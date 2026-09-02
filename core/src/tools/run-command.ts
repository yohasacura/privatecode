import { stat } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { execa } from 'execa'
import { delimiter } from 'node:path'

/**
 * PATH with the enabled plugins' `bin/` folders in front (docs/PLUGINS-2026-09.md §4). The
 * variable keeps whatever case the process has (`Path` on Windows), so the child does not
 * end up with two spellings of it and the OS picking one.
 */
function withExtraPath(extra: readonly string[]): Record<string, string> {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  return { [key]: [...extra, process.env[key] ?? ''].filter((p) => p !== '').join(delimiter) }
}
import { POWERSHELL_EXE, powershellArgs } from '../powershell.js'
import { countLines, headLines, overflowNotice, spillToLog } from './output-log.js'
import type { ApprovalPreview, PermissionKey, Tool } from './types.js'
import type { Workspace } from '../workspace.js'

export interface RunCommandArgs {
  /** One entry per command, run in order, stopping at the first failure. */
  commands: string[]
  timeout_seconds?: number
  cwd?: string
}

/**
 * Joins a list of commands so that it means what `&&` means.
 *
 * `&&` is what the model reaches for and Windows PowerShell 5.1 does not have it — it is a
 * parse error, so nothing runs at all. Telling the model that is not enough, and this is not
 * a guess: measured against the live model over 14 trials per arm
 * (`spike/operator-grammar-probe.mts`), with a prompt that invites the habit —
 *
 *   a `command` string, bare schema            14/14 wrote `&&`
 *   the same, plus a `pattern` forbidding it   14/14 — this build ignores `pattern` in a
 *                                              tool schema, so the sampler never constrains it
 *   the same, plus prose in the description     3/14
 *   a `commands` LIST, bare                     0/14
 *
 * Which is this project's own law arriving from the other direction: instructions do not
 * route behaviour, structure does. A list has nowhere to write a separator, so none is
 * written — and the joining becomes the harness's job.
 *
 * `$?` and not `$LASTEXITCODE`, and the difference is not stylistic. Only NATIVE commands set
 * `$LASTEXITCODE`, so after a cmdlet it holds whatever a previous native command left there,
 * or nothing at all. Measured (`spike/chain-join-probe.mts`): joining with
 * `if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }` broke the most ordinary case of the six —
 * two successful cmdlets, where the second never ran because `$null -ne 0`. `$?` is the last
 * statement's success whether it was a cmdlet or a native program, and was correct in all six.
 *
 * `exit 1` rather than the real code because `powershell.exe -Command` already collapses a
 * native exit code to 1 on the way out; the distinction is lost before this line either way.
 */
const CHAIN = '; if (-not $?) { exit 1 }; '

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

/**
 * A command that opens by changing directory, which is the shape behind the report.
 *
 * `cd engine; dotnet build` is what a model taught `engine/src/x.cs` writes, and `engine` is a
 * workspace FOLDER name — not a directory under the one the shell started in. The `cd` now
 * fails the whole command (see `STOP_ON_ERROR`) instead of letting the build run somewhere
 * else, which is the important half. This is the other half: a bare "Cannot find path" says
 * what went wrong and not what to do instead, and the thing to do instead is a tool argument
 * rather than a shell command.
 *
 * Deliberately only a HINT, appended to a failure. Rewriting `cd X; rest` into
 * `cwd: X` + `rest` was the tempting version and it is guesswork about shell syntax: the
 * separator may be inside a quoted string, the target may be a variable, and a wrong rewrite
 * runs a command the caller never wrote.
 */
const OPENS_BY_CHANGING_DIRECTORY = /^\s*(cd|chdir|sl|set-location)\s+\S/i

/**
 * `&&` or `||` written where PowerShell 5.1 will refuse to parse it — outside every quoted
 * run.
 *
 * The list shape removed the SEPARATOR use of `&&` (measured: 14/14 chained as one string,
 * 0/14 as a list). What it does not remove is the habit inside a single entry —
 * `npm run build && npm test`, `cat a || cat b` — which still reaches a shell that has no
 * such operator, so nothing runs and the reply is a parse error pointing at our own prelude.
 * Caught here instead: no process spawned, and the answer names the fix.
 *
 * Quote-aware, and biased to ALLOW. `cmd /c "a && b"` is legitimate — the `&&` is cmd's, not
 * PowerShell's — and refusing it would break a working command to prevent a broken one.
 * Anything this scanner is unsure about therefore runs, and falls back to the honest parse
 * error it always had. That is the safe direction: a false negative costs a round trip, a
 * false positive costs a command someone meant.
 *
 * Not a shell parser. It tracks one thing — whether the cursor is inside a `'` or `"` run —
 * which is all that separates the two cases above.
 */
export function unparsableChainAt(command: string): '&&' | '||' | null {
  let quote: "'" | '"' | null = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    // PowerShell's escape is a backtick, and only inside double quotes.
    if (quote === '"' && c === '`') { i++; continue }
    if (quote === null && (c === "'" || c === '"')) { quote = c; continue }
    if (quote !== null && c === quote) { quote = null; continue }
    if (quote !== null) continue
    if ((c === '&' || c === '|') && command[i + 1] === c) return c === '&' ? '&&' : '||'
  }
  return null
}

/**
 * `a && b && c` as the list entries `[a, b, c]` — the same scan as `unparsableChainAt`,
 * cutting at every `&&` outside quotes.
 *
 * Splitting rather than refusing, because the refusal was measured to cost a whole step and
 * buy nothing: the model reads "put each command in its own entry", re-issues the identical
 * pair as two entries, and the list runs exactly what the split would have run — the entries
 * already execute in order and stop at the first failure, which IS what `&&` means, and in
 * ONE shell, so a leading `cd` still applies to what follows. Watched in the speed probe:
 * `cd <root> && dotnet build` refused, then re-sent split, one step of ~5 s for a rewrite
 * the harness can do exactly. `||` stays refused: PowerShell 5.1 has no operator for it and
 * a rewrite would have to invent control flow the caller never wrote.
 *
 * Only reached when the scan already found an unquoted `&&`, so a `&&` inside quotes is
 * never a cut point here either.
 */
export function splitUnquotedAnd(command: string): string[] {
  const parts: string[] = []
  let quote: "'" | '"' | null = null
  let start = 0
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (quote === '"' && c === '`') { i++; continue }
    if (quote === null && (c === "'" || c === '"')) { quote = c; continue }
    if (quote !== null && c === quote) { quote = null; continue }
    if (quote !== null) continue
    if (c === '&' && command[i + 1] === '&') {
      parts.push(command.slice(start, i))
      start = i + 2
      i++
    }
  }
  parts.push(command.slice(start))
  return parts.map((p) => p.trim()).filter((p) => p !== '')
}

export const runCommandTool: Tool<RunCommandArgs> = {
  name: 'run_command',
  readOnly: false,
  description:
    'Run one or more commands in the workspace, in order, stopping at the first failure, and ' +
    'return their combined output and exit code. Exit code 0 is evidence, not proof — verify ' +
    'with a follow-up check when it matters (some installers return 0 while work continues ' +
    'in the background). Long-running processes (dev servers, watchers) belong in ' +
    'background_task, not here.',
  parameters: {
    type: 'object',
    properties: {
      commands: {
        type: 'array',
        items: { type: 'string' },
        description:
          'The commands to run, in order, one per entry. Each runs only if the one before ' +
          'it succeeded — so a list is what `&&` would mean elsewhere. Usually one entry. ' +
          'Each entry is a Windows PowerShell 5.1 command line, not sh: no `&&`, no `||`, ' +
          'no `2>/dev/null`.',
      },
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
    required: ['commands'],
  },
  validate(raw) {
    const r = raw as Partial<RunCommandArgs> & { command?: unknown }
    // A bare `command` string is accepted as a one-entry list. The schema does not offer it
    // and the model does not send it, but a stored session, a hand-written call or a future
    // caller might — and answering "commands must be an array" to something this can plainly
    // run would be pedantry with a cost.
    const given = Array.isArray(r?.commands) ? r.commands
      : typeof r?.command === 'string' ? [r.command]
      : null
    if (given === null) {
      return { ok: false, error: 'commands must be an array of command lines' }
    }
    const entries = given.filter((c): c is string => typeof c === 'string' && c.trim() !== '')
    if (entries.length !== given.length) {
      return { ok: false, error: 'every entry in commands must be a non-empty string' }
    }
    if (entries.length === 0) {
      return { ok: false, error: 'commands must contain at least one command line' }
    }
    const commands: string[] = []
    for (const [i, c] of entries.entries()) {
      const op = unparsableChainAt(c)
      if (op === '&&') {
        // The habit the list shape did not remove, absorbed instead of refused — see
        // `splitUnquotedAnd`. The parts land in the list the model should have written.
        commands.push(...splitUnquotedAnd(c))
        continue
      }
      if (op !== null) {
        return {
          ok: false,
          error: `commands[${i}] contains \`${op}\`, which Windows PowerShell 5.1 cannot ` +
            'parse — nothing would run at all. Put each command in its own entry: they ' +
            'already run in order and stop at the first failure.',
        }
      }
      commands.push(c)
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
    const args: RunCommandArgs = { commands }
    if (r.timeout_seconds !== undefined) args.timeout_seconds = r.timeout_seconds
    if (r.cwd !== undefined) args.cwd = r.cwd
    return { ok: true, args }
  },
  permissionKey(args): PermissionKey {
    // Joined with a plain `; `, which is the exact shape the model used to send as ONE string
    // — so every permission rule and every hard-deny pattern a person already has keeps
    // matching what it always matched. `HARD_DENY`'s entries bound themselves with `[^|;&]*`
    // so a `git push` in the second half is still caught, and joining this way preserves it.
    //
    // Not one key per entry, which would be finer and is the obvious next step: the gate asks
    // `permissionKey` once per tool call and the whole approval path — the card, "always
    // allow", session rules — is built on that one answer. Changing it is a bigger change
    // than this, and doing it here would have smuggled it in behind a fix for `&&`.
    return { tool: 'run_command', command: args.commands.join('; ') }
  },
  approvalPreview(args): ApprovalPreview {
    const oneLine = args.commands.join('; ').replace(/\s+/g, ' ').trim()
    return {
      summary: oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine,
      // "workspace root" was the wording, and it names nothing a person can point at once the
      // workspace is several folders — the default is the FIRST of them. No `ctx` reaches
      // here to say which, so it says which one it means rather than naming it.
      // One per line, because the approval card is where a person decides, and a list joined
      // back into one line is exactly the shape that made this hard to read in the first place.
      detail: `Run in PowerShell (cwd: ${args.cwd ?? 'the first workspace folder'}):\n` +
        args.commands.join('\n'),
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
      // ONE shell for the whole list: a `cd` in the first entry has to still apply to
      // the second, which separate invocations would lose.
      powershellArgs(args.commands.join(CHAIN)),
      {
        cwd,
        forceKillAfterDelay: 2_000,
        reject: false,
        windowsHide: true,
        all: true,
        ...(ctx.extraPath !== undefined && ctx.extraPath.length > 0 ? { env: withExtraPath(ctx.extraPath) } : {}),
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
    const hint = code !== 0 && OPENS_BY_CHANGING_DIRECTORY.test(args.commands[0] ?? '')
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
