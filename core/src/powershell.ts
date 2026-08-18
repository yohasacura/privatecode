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

export const POWERSHELL_EXE = 'powershell.exe'

/** argv for `powershell.exe <command>`. The prelude lives inside the same -Command string
 * as the command itself, ahead of it, so the process exit code and `$LASTEXITCODE` still
 * come from the command. */
export function powershellArgs(command: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    UTF8_PRELUDE + command]
}
