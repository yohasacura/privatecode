import { stat } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { execa } from 'execa'
import { POWERSHELL_EXE, powershellArgs } from '../powershell.js'
import { countLines, headLines, overflowNotice, spillToLog } from './output-log.js'
import type { ApprovalPreview, PermissionKey, Tool } from './types.js'
import type { Workspace } from '../workspace.js'

export interface RunCommandArgs {
  command: string
  timeout_seconds?: number
  cwd?: string
}

const DEFAULT_TIMEOUT_S = 120
const MAX_TIMEOUT_S = 600
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
 * uses — does not resolve. Measured on a two-folder workspace: that `Test-Path` answers False
 * while `../engine/Engine.csproj` answers True. With nothing in the reply saying where it had
 * been, a wrong guess looked exactly like a missing file, and the way out was `pwd`, then
 * `dir`, then a third command to check the guess.
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

export const runCommandTool: Tool<RunCommandArgs> = {
  name: 'run_command',
  readOnly: false,
  description:
    'Run a PowerShell command in the workspace and return its combined output and exit ' +
    'code. Exit code 0 is evidence, not proof — verify with a follow-up check when it ' +
    'matters (some installers return 0 while work continues in the background). ' +
    'Long-running processes (dev servers, watchers) belong in background_task, not here.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The PowerShell command line to run.' },
      timeout_seconds: {
        type: 'integer',
        description: `Kill the command after this many seconds (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}).`,
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
    },
    required: ['command'],
  },
  validate(raw) {
    const r = raw as Partial<RunCommandArgs>
    if (typeof r?.command !== 'string' || r.command.trim() === '') {
      return { ok: false, error: 'command must be a non-empty string' }
    }
    if (r.timeout_seconds !== undefined) {
      if (!Number.isInteger(r.timeout_seconds) || r.timeout_seconds < 1 ||
          r.timeout_seconds > MAX_TIMEOUT_S) {
        return { ok: false, error: `timeout_seconds must be an integer from 1 to ${MAX_TIMEOUT_S}` }
      }
    }
    if (r.cwd !== undefined && (typeof r.cwd !== 'string' || r.cwd.trim() === '')) {
      return { ok: false, error: 'cwd must be a non-empty workspace-relative path when given' }
    }
    const args: RunCommandArgs = { command: r.command }
    if (r.timeout_seconds !== undefined) args.timeout_seconds = r.timeout_seconds
    if (r.cwd !== undefined) args.cwd = r.cwd
    return { ok: true, args }
  },
  permissionKey(args): PermissionKey {
    return { tool: 'run_command', command: args.command }
  },
  approvalPreview(args): ApprovalPreview {
    const oneLine = args.command.replace(/\s+/g, ' ').trim()
    return {
      summary: oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine,
      // "workspace root" was the wording, and it names nothing a person can point at once the
      // workspace is several folders — the default is the FIRST of them. No `ctx` reaches
      // here to say which, so it says which one it means rather than naming it.
      detail: `Run in PowerShell (cwd: ${args.cwd ?? 'the first workspace folder'}):\n${args.command}`,
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
    const timeoutS = args.timeout_seconds ?? DEFAULT_TIMEOUT_S
    const started = performance.now()
    // reject: false — a non-zero exit is a result, not an exception. windowsHide keeps
    // PowerShell from flashing a console window once this runs under a UI shell.
    //
    // No `timeout` and no `cancelSignal`: both of execa's own stop paths end in
    // `subprocess.kill()`, which on Windows is TerminateProcess on the DIRECT child, and
    // the direct child here is always powershell.exe (see powershellArgs) while the thing
    // actually doing the work — node, dotnet, npm — is its grandchild. Both paths are
    // therefore run by hand below, so the tree can be taken down parent-first.
    const child = execa(
      POWERSHELL_EXE,
      powershellArgs(args.command),
      {
        cwd,
        forceKillAfterDelay: 2_000,
        reject: false,
        windowsHide: true,
        all: true,
      },
    )

    /**
     * Stop the job AND everything it started, then remember which of the two reasons it
     * was — execa is no longer the one killing, so `isCanceled`/`timedOut` no longer
     * arrive on its result.
     *
     * The ORDER is the whole point, and it is the same order background-task.ts:213 and
     * mcp/transport.ts:155 already use for the same reason. `taskkill /T` walks the tree
     * by parent-child links as they stand when it runs, so it has to run while PowerShell
     * is still alive; killing PowerShell first leaves the grandchild with a dead parent
     * and nothing left to walk. What that cost, before this: Esc or the 120 s timeout
     * reported the command stopped while node/dotnet kept running — holding its port, its
     * build lock and its file handles — invisible in the Terminal panel, which lists only
     * background_task entries, so the next run failed with EADDRINUSE for a process the
     * user had no way to see or stop.
     *
     * `kill()` stays, after, for what taskkill cannot do: a pid we never learned, or a
     * platform without it.
     */
    let stopped: 'cancelled' | 'timeout' | null = null
    const stopTree = async (reason: 'cancelled' | 'timeout'): Promise<void> => {
      if (stopped !== null) return
      stopped = reason
      const pid = child.pid
      if (pid !== undefined && process.platform === 'win32') {
        try {
          await execa('taskkill', ['/PID', String(pid), '/T', '/F'],
            { reject: false, windowsHide: true })
        } catch { /* not on PATH, or the tree is already gone */ }
      }
      try {
        child.kill()
      } catch { /* already exited */ }
    }

    const timer = setTimeout(() => { void stopTree('timeout') }, timeoutS * 1000)
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
      const head = `Command killed after ${timeoutS} s (timeout). Partial output:\n`
      const tail = '\nIf it legitimately needs longer, re-run with a larger ' +
        'timeout_seconds, or use background_task for something long-running.'
      return {
        ok: false,
        content: `${head}${out || '(none)'}${tail}`,
        display: `${head}${full || '(none)'}${tail}`,
      }
    }
    const code = result.exitCode ?? -1
    const header = `exit ${code} in ${seconds} s${whereRan(ctx.workspace, cwd, args.cwd)}\n`
    return {
      ok: code === 0,
      content: `${header}${out || '(no output)'}`,
      display: `${header}${full || '(no output)'}`,
    }
  },
}
