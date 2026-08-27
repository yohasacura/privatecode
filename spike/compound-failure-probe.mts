/**
 * Two candidate ways to stop reporting `exit 0` for a command whose first half failed.
 *
 * A. `$ErrorActionPreference = 'Stop'` in the prelude — makes a cmdlet error terminating, so
 *    `cd nowhere; build` never reaches the build. Correct for the reported shape; the
 *    question is what else it stops that used to keep going.
 * B. Count `$Error` around the command and report the difference — changes no semantics, only
 *    what the reply says.
 *
 * Run against real PowerShell, because what PowerShell counts as an error is not something to
 * reason about from memory.
 *
 *   npx tsx spike/compound-failure-probe.mts
 */
import { execFile } from 'node:child_process'

const PRELUDE =
  'try { $__pcUtf8 = New-Object System.Text.UTF8Encoding; ' +
  '[Console]::OutputEncoding = $__pcUtf8; $OutputEncoding = $__pcUtf8 } catch {}; '

/** `node:child_process` rather than execa: `spike/` has no node_modules of its own, and the
 * probe needs nothing execa provides. */
function run(label: string, prelude: string, command: string): Promise<void> {
  return new Promise((resolve) => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', prelude + command],
      { windowsHide: true },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number'
          ? (err as unknown as { code: number }).code
          : 0
        const out = `${stdout}${stderr}`.replace(/\s+/g, ' ').trim().slice(0, 90)
        console.log(`  ${label.padEnd(26)} exit=${String(code).padEnd(4)} ${out}`)
        resolve()
      })
  })
}

const A = `${PRELUDE}$ErrorActionPreference = 'Stop'; `
const B = `${PRELUDE}$__pcErrors = $Error.Count; `
const B_TAIL = '; if ($Error.Count -gt $__pcErrors) { Write-Output "[[errors: $($Error.Count - $__pcErrors)]]" }'

const CASES: [string, string][] = [
  ['cd fails then build', 'cd nowhere-at-all; Write-Output "the second half ran"'],
  ['cd works then build', 'cd $env:TEMP; Write-Output "ran in temp"'],
  ['plain success', 'Write-Output ok'],
  ['native non-zero exit', 'cmd /c exit 3'],
  ['a warning, not an error', 'Write-Warning "careful"; Write-Output "still ran"'],
  ['listing with one bad path', 'Get-ChildItem C:\\nope, $env:TEMP -ErrorAction Continue | Select-Object -First 1 | Out-Null; Write-Output "listed"'],
]

console.log('as it is today:')
for (const [label, cmd] of CASES) await run(label, PRELUDE, cmd)

console.log('\nA. $ErrorActionPreference = Stop:')
for (const [label, cmd] of CASES) await run(label, A, cmd)

console.log('\nB. count $Error around it:')
for (const [label, cmd] of CASES) await run(label, B, cmd + B_TAIL)

/**
 * The case that decides whether A is safe: a NATIVE program that writes to stderr and exits
 * zero. `git`, `npm` and `dotnet` all do it for progress and warnings. PowerShell 5.1 wraps a
 * native command's stderr in ErrorRecords when it is redirected INSIDE the shell — if that
 * happens here, `Stop` would abort every build that printed a warning, which would be far
 * worse than the defect it fixes.
 */
console.log('\nthe deciding case — native stderr with a zero exit:')
const NATIVE: [string, string][] = [
  ['stderr then exit 0', 'cmd /c "echo a warning 1>&2 & exit 0"; Write-Output "reached the end"'],
  ['stderr then exit 0, piped', 'cmd /c "echo a warning 1>&2 & exit 0" | Out-String | Out-Null; Write-Output "reached the end"'],
  ['git into a non-repo', 'git status; Write-Output "reached the end"'],
]
for (const [label, cmd] of NATIVE) await run(`today  ${label}`, PRELUDE, cmd)
for (const [label, cmd] of NATIVE) await run(`Stop   ${label}`, A, cmd)
