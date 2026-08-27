import { execa } from 'execa'

/** The one place that knows how to launch a PowerShell child.
 *
 * Windows PowerShell 5.1 encodes redirected stdout in the machine's OEM codepage, and any
 * character outside that codepage -- all of Cyrillic on an English-locale system -- is
 * folded to a literal `?` before Node ever sees the bytes. The prelude switches the
 * session to UTF-8 before the command runs: `[Console]::OutputEncoding` is what the child
 * uses to write its redirected output (and to decode the stdout of native programs it
 * runs), `$OutputEncoding` is what it uses to pipe text INTO native programs. The
 * parameterless UTF8Encoding constructor is BOM-less; the assignment can throw when the
 * process has no console at all, hence the try/catch.
 */
const UTF8_PRELUDE =
  'try { $__pcUtf8 = New-Object System.Text.UTF8Encoding; ' +
  '[Console]::OutputEncoding = $__pcUtf8; $OutputEncoding = $__pcUtf8 } catch {}; '

/**
 * Stop at the first statement that fails, instead of running the rest and reporting the exit
 * code of whatever happened to be last.
 *
 * The reported shape: the model writes `cd engine; dotnet build`, the `cd` fails because
 * `engine` is a workspace FOLDER name and not a directory under the one the shell started in,
 * and PowerShell's `;` is a separator rather than a conditional — so the build ran anyway, in
 * the wrong project, and the reply said `exit 0`. Measured, on a two-folder workspace: the
 * command answered `ok=true` and returned the contents of the wrong file.
 *
 * That is the same defect as this project's own CI gate, which passed while sixty tests
 * failed because a multi-line PowerShell `run:` reports only the last command's code. A
 * harness that says a build passed when it built something else is worse than one that
 * wastes a round trip.
 *
 * `Stop` and not something narrower, and the boundaries were measured rather than assumed
 * (`spike/compound-failure-probe.mts`):
 *
 *   cd to a missing path, then echo   exit 1, and the echo never runs   <- the fix
 *   an explicit `-ErrorAction Continue`   still continues               <- the escape hatch
 *   a native program writing to stderr and exiting 0   unaffected       <- the deciding case
 *
 * The last row is the one that could have made this a bad trade: `git`, `npm` and `dotnet`
 * all write progress and warnings to stderr, and PowerShell 5.1 wraps a native command's
 * stderr in ErrorRecords when it is redirected INSIDE the shell. It is not redirected inside
 * the shell here — execa reads the child's pipes directly — and a native stderr write with a
 * zero exit behaves identically with `Stop` and without it.
 *
 * What this does NOT cover: a NATIVE command that exits non-zero mid-command
 * (`npm test; npm run build`). Native exit codes produce no ErrorRecord, so the rest still
 * runs and the reported code is the last one's. Fixing that means injecting a check between
 * statements, which means parsing the command, and a shell command is not something to parse.
 */
const STOP_ON_ERROR = "$ErrorActionPreference = 'Stop'; "

export const POWERSHELL_EXE = 'powershell.exe'

/** argv for `powershell.exe <command>`. The prelude lives inside the same -Command string
 * as the command itself, ahead of it, so the process exit code and `$LASTEXITCODE` still
 * come from the command. */
export function powershellArgs(command: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    UTF8_PRELUDE + STOP_ON_ERROR + command]
}

/**
 * Stop a PowerShell child AND everything it started, parent-first.
 *
 * Every command this app runs is `powershell.exe -Command <...>`, so the process actually
 * doing the work — dotnet, npm, node — is PowerShell's CHILD, and the direct child is only
 * a shell. Node's `kill()` is TerminateProcess on that direct child alone, which leaves the
 * grandchild running: a verify build kept compiling after the turn was interrupted, holding
 * its obj/ lock and its cores, with nothing on screen admitting it existed.
 *
 * The ORDER is the whole point. `taskkill /T` walks parent-child links as they stand when
 * it runs, so it has to run while PowerShell is still alive; killing the shell first
 * reparents the grandchild and leaves `/T` nothing to find. `kill()` follows as the
 * fallback for what taskkill cannot do — a pid we never learned, or a machine without it
 * on PATH.
 *
 * `execa`'s own `timeout` and `cancelSignal` both end in that same bare `kill()`, so a
 * caller that wants the tree gone must not use them: it runs its own timer and its own
 * abort listener, and calls this.
 */
async function killTree(child: { pid?: number | undefined; kill: () => unknown }): Promise<void> {
  const pid = child.pid
  if (pid !== undefined && process.platform === 'win32') {
    try {
      await execa('taskkill', ['/PID', String(pid), '/T', '/F'], { reject: false, windowsHide: true })
    } catch { /* not on PATH, or the tree is already gone */ }
  }
  try {
    child.kill()
  } catch { /* already exited */ }
}

/**
 * Run one PowerShell command to completion, where a timeout or an abort takes down the
 * whole process tree rather than the shell alone (see `killTree`).
 *
 * `stopped` says which of the two ended it, because execa is no longer the one killing:
 * its `timedOut` and `isCanceled` flags only report ITS stop paths, and those are exactly
 * the ones a caller must not use here.
 */
/** The spawn itself, split out ONLY so its concrete option types survive into
 * `runPowershell`'s return type — inferring from a bare `typeof execa` widens `all` to a
 * union that no caller can call `.trim()` on. */
function spawnPowershell(command: string, cwd: string) {
  return execa(POWERSHELL_EXE, powershellArgs(command), {
    cwd, reject: false, windowsHide: true, all: true,
  })
}

export async function runPowershell(
  command: string,
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal | undefined },
): Promise<{
  result: Awaited<ReturnType<typeof spawnPowershell>>
  stopped: 'cancelled' | 'timeout' | null
}> {
  const child = spawnPowershell(command, opts.cwd)
  let stopped: 'cancelled' | 'timeout' | null = null
  const stop = async (reason: 'cancelled' | 'timeout'): Promise<void> => {
    if (stopped !== null) return
    stopped = reason
    await killTree(child)
  }
  const timer = setTimeout(() => { void stop('timeout') }, opts.timeoutMs)
  const onAbort = (): void => { void stop('cancelled') }
  opts.signal?.addEventListener('abort', onAbort)
  // Both are detached the moment the process is gone. The listener especially: the signal
  // belongs to the whole turn, so one left behind would fire for a LATER abort and taskkill
  // a pid Windows may by then have handed to someone else.
  const result = await child.finally(() => {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
  })
  return { result, stopped }
}
