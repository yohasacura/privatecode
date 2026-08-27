/**
 * Does the distiller actually tell code work from writing?
 *
 * Reported: asked to compose an email, the harness ran `dotnet build`. The cause was that
 * nothing ever asked what kind of work it was — `looksLikeTask` keys on LENGTH alone (220
 * characters, or 80 with three sentences), so a detailed email request is indistinguishable
 * from a refactor, and the build gate keys on "did this turn write a file".
 *
 * The contract now carries `changesCode` as its own forced boolean, answered last with the
 * goal and criteria already written. Whether that classification is RIGHT is a question about
 * the model, so it is asked of the model.
 *
 * Only an explicit `false` turns the build off, so the failure that matters is a false
 * NEGATIVE — code work classified as writing, and the check silently skipped. The list below
 * is weighted accordingly: the code cases include ones that talk about documents.
 *
 *   npx tsx spike/changes-code-probe.mts
 */
import { LlamaClient } from '../core/src/llama/client.js'
import { distillContract } from '../core/src/session/contract.js'

const client = new LlamaClient({
  baseUrl: process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080',
  model: 'qwen',
})

/** `want` is what `changesCode` should be. */
const CASES: { want: boolean; text: string }[] = [
  // --- not code -----------------------------------------------------------------------
  {
    want: false,
    text: 'Составь письмо клиенту о переносе релиза на следующую неделю. Объясни причину — ' +
      'нашли проблему с производительностью при большой нагрузке. Тон деловой, но не ' +
      'сухой. Предложи созвон в четверг, если нужны детали.',
  },
  {
    want: false,
    text: 'Write release notes for version 2.4 from the commit log. Group them by area, ' +
      'lead with the two things users actually asked for, and keep it under a page. ' +
      'Anything internal-only goes at the bottom in one line.',
  },
  {
    want: false,
    text: 'Explain how the checkpoint system works in this project, in enough detail that ' +
      'a new person could reason about it. Cover what is stored, where, and what happens ' +
      'on a rewind. Do not change anything.',
  },
  // --- code, including ones that mention documents -------------------------------------
  {
    want: true,
    text: 'The slug helper drops underscores but keeps ampersands, so slug("a&b") comes ' +
      'back as "a&b" instead of "a-b". Fix it and add the cases to the test file.',
  },
  {
    want: true,
    text: 'Add a --json flag to the export command so it writes the report as JSON instead ' +
      'of the current text table. Keep the text output as the default and document the ' +
      'flag in the README.',
  },
  {
    want: true,
    text: 'Rename the InvoiceService class to BillingService everywhere, update the imports ' +
      'and the docs that mention it, and make sure the test suite still passes.',
  },
]

let right = 0
for (const c of CASES) {
  const contract = await distillContract(client, [{ role: 'user', content: c.text }], c.text)
  const got = contract?.changesCode
  const ok = got === c.want
  if (ok) right++
  console.log(
    `  ${ok ? 'ok  ' : 'WRONG'}  want=${String(c.want).padEnd(5)} got=${String(got).padEnd(9)} ` +
    `kind=${String(contract?.kind).padEnd(7)} ${c.text.slice(0, 52).replace(/\s+/g, ' ')}…`,
  )
}
console.log(`\n${right}/${CASES.length} classified correctly`)
