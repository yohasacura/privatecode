import { stat } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { findBash, spawnBash } from '../bash.js'
import { killTree } from '../powershell.js'
import type { BackgroundTasks } from './background-task.js'
import { countLines, headLines, overflowNotice, spillToLog } from './output-log.js'
import type { ApprovalPreview, PermissionKey, Tool } from './types.js'
import type { Workspace } from '../workspace.js'

/**
 * `Bash` — Claude Code's shell tool, with Claude Code's shell.
 *
 * The command runs under bash: the copy of Git for Windows' bash and coreutils that ships
 * with the app (`vendor/git`, see `bash.ts`), or the machine's own Git for Windows. That is
 * what Claude Code runs on Windows, and it is what every plugin, hook script and README
 * written for Claude Code assumes: `&&`, pipes, `$(...)`, globs, `2>/dev/null`, `grep`,
 * `sed`, `find`. The arguments are Claude Code's too — `command`, `timeout` in
 * milliseconds, `description`, `run_in_background` — plus `cwd`, which this project needs
 * because a workspace here can be several folders.
 *
 * Until 2026-09-03 this tool was `run_command` over Windows PowerShell 5.1 and took a LIST
 * of commands, a shape measured to stop the model writing `&&` for a shell that had none
 * (`spike/operator-grammar-probe.mts`). Bash has `&&`, so the list is gone; a stored session
 * that still sends one is joined with `&&`, which is what the list meant.
 */

export interface BashArgs {
  command: string
  /** Milliseconds, as Claude Code counts it. */
  timeout?: number
  /** What the command is for, in a few words — shown on the approval card. */
  description?: string
  cwd?: string
  /** Start it and return at once; `background_task` polls and stops it. */
  run_in_background?: boolean
}

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
/** Output cap. Everything returned is permanent transcript; a build log can be megabytes. */
const MAX_OUTPUT_CHARS = 8_000
/** Ceiling on the untruncated copy sent to the UI (see `ToolResult.display`). Large enough
 * for a real build or test log, small enough that one command cannot make the transcript
 * unbounded. */
const MAX_DISPLAY_CHARS = 400_000

/** Lines of the head shown inline when the rest went to a log file. Enough that a short
 * failure is answered without a second call, small enough to stay cheap. */
const HEAD_LINES = 60

/** Head-and-tail clip: the head names what ran, the tail carries the error that matters.
 * Still used for the UI copy and as the fallback when a log file cannot be written. */
export function clipOutput(text: string, limit = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text
  const head = Math.floor(limit * 0.6)
  const tail = limit - head
  const dropped = text.length - limit
  return `${text.slice(0, head)}\n... (${dropped} characters omitted from the middle; ` +
    `output is capped at ${limit}) ...\n${text.slice(-tail)}`
}

/**
 * ` · in engine/`, or nothing at all.
 *
 * Where a command ran was the one fact the result never carried, and on a multi-folder
 * workspace it is the fact the model was missing: a bare command starts in the FIRST folder,
 * and inside the command text `engine/Engine.csproj` — the language every other tool argument
 * uses — does not resolve. With nothing in the reply saying where it had been, a wrong guess
 * looked exactly like a missing file, and the way out was `pwd`, then `ls`, then a third
 * command to check the guess.
 *
 * Silent when the workspace is one folder and no cwd was asked for, which is most commands in
 * most workspaces: there is one place it could have run and the model already knows it from
 * the system prompt.
 */
function whereRan(workspace: Workspace, resolved: string, asked: string | undefined): string {
  if (!workspace.multi && asked === undefined) return ''
  const shown = workspace.display(resolved)
  return ` · in ${shown === '.' ? 'the workspace root' : `${shown}/`}`
}

/**
 * A command that opens by changing directory, which is the shape behind the report.
 *
 * `cd engine && dotnet build` is what a model taught `engine/src/x.cs` writes, and `engine`
 * is a workspace FOLDER name — not a directory under the one the shell started in. A bare
 * "No such file or directory" says what went wrong and not what to do instead, and the thing
 * to do instead is a tool argument rather than a shell command.
 *
 * Deliberately only a HINT, appended to a failure. Rewriting `cd X && rest` into
 * `cwd: X` + `rest` was the tempting version and it is guesswork about shell syntax.
 */
const OPENS_BY_CHANGING_DIRECTORY = /^\s*(cd|pushd)\s+\S/i

const NO_BASH =
  'bash is not available: the copy that ships with PrivateCode is missing (vendor/git — ' +
  'run `node scripts/fetch-vendor.mjs` in a checkout) and Git for Windows is not installed. ' +
  'Nothing was run.'

/**
 * The tool, built per toolset: `background` is what `run_in_background` hands the command to,
 * and a toolset without one (the one-shot CLI, most tests) says so rather than failing.
 */
export function createBashTool(deps: { background?: BackgroundTasks } = {}): Tool<BashArgs> {
  return {
    name: 'Bash',
    readOnly: false,
    description:
      'Run a bash command (Git Bash on this Windows machine) in the workspace and return its ' +
      'output and exit code. `&&`, `||`, pipes, `$(...)`, globs and redirects work as in bash; ' +
      'write paths with forward slashes (`src/app.ts`, `D:/dir` or `/d/dir`). Each call starts ' +
      'in the workspace folder, or in `cwd`: a `cd` does not carry over to the next call, so ' +
      'set `cwd` rather than chaining `cd`. `git`, `node`, `python`, `dotnet` and the rest come ' +
      'from the machine\'s PATH. Exit code 0 is evidence, not proof — verify with a follow-up ' +
      'check when it matters. A dev server, a watcher or anything long-running: pass ' +
      'run_in_background: true and poll it with background_task.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to run, as one bash command line.' },
        description: {
          type: 'string',
          description: 'What this command is for, in five to ten words (e.g. "Run the unit tests").',
        },
        timeout: {
          type: 'integer',
          description: `Kill the command after this many milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`,
        },
        cwd: {
          type: 'string',
          description:
            'Which directory to run in, named the way every other tool argument is: ' +
            'folder-prefixed in a multi-folder workspace (`engine`, `engine/src`), plain ' +
            'workspace-relative in a single-folder one. Defaults to the FIRST folder. Paths ' +
            'inside the command itself are ordinary shell paths from that directory, not ' +
            'folder-prefixed — so reach another folder by setting this, not by writing ../ ' +
            'in the command.',
        },
        run_in_background: {
          type: 'boolean',
          description: 'Start the command and return its task id at once instead of waiting for it.',
        },
      },
      required: ['command'],
    },
    validate(raw) {
      const r = raw as Partial<BashArgs> & { commands?: unknown; timeout_seconds?: unknown }
      // The list a session recorded before 2026-09-03 sends: joined with `&&`, which is what
      // "in order, stopping at the first failure" meant.
      let command: string | null = typeof r?.command === 'string' ? r.command : null
      if (command === null && Array.isArray(r?.commands)) {
        const entries = r.commands.filter((c): c is string => typeof c === 'string' && c.trim() !== '')
        if (entries.length !== r.commands.length || entries.length === 0) {
          return { ok: false, error: 'every entry in commands must be a non-empty command line' }
        }
        command = entries.join(' && ')
      }
      if (command === null || command.trim() === '') {
        return { ok: false, error: 'command must be a non-empty bash command line' }
      }
      const args: BashArgs = { command: command.trim() }
      const timeout = r.timeout !== undefined ? r.timeout
        : typeof r.timeout_seconds === 'number' ? r.timeout_seconds * 1000 : undefined
      if (timeout !== undefined) {
        if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) {
          return { ok: false, error: `timeout must be an integer number of milliseconds from 1 to ${MAX_TIMEOUT_MS}` }
        }
        args.timeout = timeout
      }
      if (r.description !== undefined) {
        if (typeof r.description !== 'string') return { ok: false, error: 'description must be a string' }
        if (r.description.trim() !== '') args.description = r.description.trim()
      }
      if (r.cwd !== undefined) {
        if (typeof r.cwd !== 'string' || r.cwd.trim() === '') {
          return { ok: false, error: 'cwd must be a non-empty workspace-relative path when given' }
        }
        args.cwd = r.cwd
      }
      if (r.run_in_background !== undefined) {
        if (typeof r.run_in_background !== 'boolean') return { ok: false, error: 'run_in_background must be true or false' }
        if (r.run_in_background) args.run_in_background = true
      }
      return { ok: true, args }
    },
    permissionKey(args): PermissionKey {
      return { tool: 'Bash', command: args.command }
    },
    approvalPreview(args): ApprovalPreview {
      const oneLine = args.command.replace(/\s+/g, ' ').trim()
      return {
        summary: args.description ?? (oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine),
        detail: `Run in bash (cwd: ${args.cwd ?? 'the first workspace folder'})` +
          `${args.run_in_background === true ? ', in the background' : ''}:\n${args.command}`,
      }
    },
    async execute(args, ctx) {
      let cwd = ctx.workspace.root
      if (args.cwd) {
        try {
          cwd = ctx.workspace.resolve(args.cwd)
        } catch (e) {
          return { ok: false, content: (e as Error).message }
        }
        try {
          if (!(await stat(cwd)).isDirectory()) {
            return { ok: false, content: `cwd ${args.cwd} is not a directory` }
          }
        } catch {
          return { ok: false, content: `cwd ${args.cwd} does not exist` }
        }
      }
      const bash = findBash()
      if (bash === null) return { ok: false, content: NO_BASH }

      if (args.run_in_background === true) {
        if (deps.background === undefined) {
          return { ok: false, content: 'No background runner is available here; run the command without run_in_background.' }
        }
        const entry = deps.background.start(args.command, null, cwd, 'agent', ctx.extraPath ?? [])
        return {
          ok: true,
          content: `Started in the background as ${entry.id}${whereRan(ctx.workspace, cwd, args.cwd)}. ` +
            `Read its output with background_task (action: poll, id: ${entry.id}); stop it with action: stop.`,
        }
      }

      const timeoutMs = args.timeout ?? DEFAULT_TIMEOUT_MS
      const started = performance.now()
      // reject: false — a non-zero exit is a result, not an exception. No `timeout` and no
      // `cancelSignal`: both of execa's own stop paths end in `subprocess.kill()`, which on
      // Windows is TerminateProcess on the DIRECT child — bash — while the thing doing the
      // work (node, dotnet, npm) is its grandchild. Both paths run by hand below instead, so
      // the tree comes down parent-first (`killTree`).
      const child = spawnBash(bash, args.command, {
        cwd, ...(ctx.extraPath !== undefined ? { extraPath: ctx.extraPath } : {}),
      })

      let stopped: 'cancelled' | 'timeout' | null = null
      const stopTree = async (reason: 'cancelled' | 'timeout'): Promise<void> => {
        if (stopped !== null) return
        stopped = reason
        await killTree(child)
      }

      const timer = setTimeout(() => { void stopTree('timeout') }, timeoutMs)
      const onAbort = (): void => { void stopTree('cancelled') }
      if (ctx.signal) {
        if (ctx.signal.aborted) onAbort()
        else ctx.signal.addEventListener('abort', onAbort, { once: true })
      }
      // The same bytes the buffered result will contain, forwarded as they appear: a long
      // command used to be a frozen card until exit, and "is it working or wedged" was
      // unanswerable from the window. Streaming changes nothing about the result below.
      if (ctx.onLiveOutput) {
        // Not chunk.toString(): a chunk boundary can land mid-codepoint, and a split
        // multi-byte character would reach the live view as mojibake. The decoder holds the
        // partial bytes until the rest arrives.
        const decoder = new StringDecoder('utf8')
        child.all?.on('data', (chunk: Buffer | string) => {
          try {
            const text = typeof chunk === 'string' ? chunk : decoder.write(chunk)
            if (text !== '') ctx.onLiveOutput?.(text)
          } catch { /* display-only */ }
        })
      }
      // Both stop paths are detached the moment the process is gone. The listener especially:
      // ctx.signal belongs to the whole turn, so one left behind would fire stopTree for a
      // later Esc — and taskkill an exited pid that Windows may by then have handed to
      // someone else.
      const result = await child.finally(() => {
        clearTimeout(timer)
        ctx.signal?.removeEventListener('abort', onAbort)
      })
      const seconds = ((performance.now() - started) / 1000).toFixed(1)
      const raw = (result.all ?? '').trim()
      // What a person sees. Still bounded -- a runaway build log must not be able to grow
      // the app's transcript without limit -- but two orders of magnitude above what the
      // model's permanent transcript can afford.
      const full = clipOutput(raw, MAX_DISPLAY_CHARS)

      // What the MODEL sees. When the output does not fit, it is not elided into a dead end:
      // the whole thing goes to a log file and the model is told how to page and filter it
      // (see output-log.ts). Falls back to the old head-and-tail clip only if the file
      // cannot be written.
      let out = raw
      if (raw.length > MAX_OUTPUT_CHARS) {
        const log = await spillToLog(ctx.workspace, 'run', raw)
        out = log === null
          ? clipOutput(raw)
          : `${headLines(raw, HEAD_LINES)}${overflowNotice(log, Math.min(HEAD_LINES, countLines(raw)))}`
      }

      if (stopped === 'cancelled') {
        return { ok: false, content: 'Command cancelled by the user before it finished.' }
      }
      if (stopped === 'timeout') {
        const head = `Command killed after ${Math.round(timeoutMs / 1000)} s (timeout). Partial output:\n`
        const tail = '\nIf it legitimately needs longer, re-run with a larger `timeout`, or ' +
          'start it with run_in_background: true.'
        return {
          ok: false,
          content: `${head}${out || '(none)'}${tail}`,
          display: `${head}${full || '(none)'}${tail}`,
        }
      }
      const code = result.exitCode ?? -1
      const header = `exit ${code} in ${seconds} s${whereRan(ctx.workspace, cwd, args.cwd)}\n`
      const hint = code !== 0 && OPENS_BY_CHANGING_DIRECTORY.test(args.command)
        ? '\n\nThis command began by changing directory. Set the `cwd` argument instead — it ' +
          'takes the same folder-prefixed path every other tool argument takes, and a `cd` ' +
          'inside the command does not.'
        : ''
      return {
        ok: code === 0,
        content: `${header}${out || '(no output)'}${hint}`,
        display: `${header}${full || '(no output)'}${hint}`,
      }
    },
  }
}

/** The tool with no background runner — what tests and the one-shot CLI use. */
export const runCommandTool: Tool<BashArgs> = createBashTool()
