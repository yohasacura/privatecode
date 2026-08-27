/**
 * How to join a LIST of commands so it means what `&&` means, in a shell that has no `&&`.
 *
 * The model reaches for `npm install && npm test`: run the second only if the first
 * succeeded. Windows PowerShell 5.1 cannot write that, and the measured fix is to stop the
 * model writing it at all — the tool takes a list (0/14 chained, against 14/14 for a string).
 * Which leaves the harness to do the joining, and the joiner has to be right for BOTH kinds
 * of failure:
 *
 *   a cmdlet error      already terminating, via $ErrorActionPreference = 'Stop'
 *   a native non-zero   NOT terminating: `cmd /c exit 1; echo next` prints next
 *
 * Two candidate joiners, and the difference between them is the classic trap:
 *
 *   LASTEXITCODE  `; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE };`
 *                 only native commands set it, so after a CMDLET it holds a stale value from
 *                 whatever native command ran before — possibly none at all
 *   QUESTION      `; if (-not $?) { exit 1 };`
 *                 $? is the last statement's success, cmdlet or native alike
 *
 *   npx tsx spike/chain-join-probe.mts
 */
import { execFile } from 'node:child_process'

const PRELUDE =
  'try { $__pcUtf8 = New-Object System.Text.UTF8Encoding; ' +
  "[Console]::OutputEncoding = $__pcUtf8; $OutputEncoding = $__pcUtf8 } catch {}; " +
  "$ErrorActionPreference = 'Stop'; "

const JOINERS: Record<string, string> = {
  'plain ;': '; ',
  LASTEXITCODE: '; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; ',
  QUESTION: '; if (-not $?) { exit 1 }; ',
}

function run(label: string, command: string): Promise<void> {
  return new Promise((resolve) => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PRELUDE + command],
      { windowsHide: true },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number'
          ? (err as unknown as { code: number }).code
          : 0
        const out = `${stdout}${stderr}`.replace(/\s+/g, ' ').trim().slice(0, 62)
        console.log(`    ${label.padEnd(14)} exit=${String(code).padEnd(4)} ${out}`)
        resolve()
      })
  })
}

/** Each case is the LIST the model would send, and what a correct `&&` chain would do. */
const CASES: { name: string; commands: string[]; want: string }[] = [
  { name: 'both succeed', commands: ['Write-Output one', 'Write-Output two'], want: 'both run, exit 0' },
  { name: 'native fails first', commands: ['cmd /c exit 3', 'Write-Output "should NOT run"'], want: 'stops, non-zero' },
  { name: 'cmdlet fails first', commands: ['cd no-such-dir', 'Write-Output "should NOT run"'], want: 'stops, non-zero' },
  { name: 'cmdlet then native', commands: ['Write-Output one', 'cmd /c exit 4'], want: 'both run, exit 4' },
  // The trap case for LASTEXITCODE: a native failure, then a cmdlet that succeeds, then more.
  // A stale LASTEXITCODE from the first would kill the chain after a statement that worked.
  { name: 'stale-code trap', commands: ['cmd /c exit 5', 'Write-Output "should NOT run"'], want: 'stops, non-zero' },
  { name: 'cmdlet after clean native', commands: ['cmd /c exit 0', 'Write-Output two'], want: 'both run, exit 0' },
]

for (const c of CASES) {
  console.log(`\n${c.name}  (want: ${c.want})`)
  for (const [label, sep] of Object.entries(JOINERS)) {
    await run(label, c.commands.join(sep))
  }
}
