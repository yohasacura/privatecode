/**
 * What an answered understanding check does to the contract.
 *
 * Both cases are real, copied out of live sessions' meta files.
 *
 * The FIRST is the one the string comparison handles: seven distilled criteria, three ticks
 * that restate them almost word for word, and a contract that went to ten.
 *
 * The SECOND is the one it does not: after the rules fix put the request's own sentence into
 * the contract, the criteria grew examples and the lenses answered in terse paraphrases —
 * "slug removes leading and trailing hyphens" against "no leading or trailing hyphens in the
 * slug — e.g. slug('---hello---') must not return '-hello-'". Same requirement, no shared
 * containment, 8 criteria + 3 ticks = 11. That case needs the model.
 *
 *   npx tsx spike/fold-answer-probe.mts
 */
import { foldAnswer, foldAnswerWithModel, type Understanding } from '../core/src/session/understanding.js'
import { LlamaClient } from '../core/src/llama/client.js'

const client = new LlamaClient({
  baseUrl: process.env.LLAMA_URL ?? 'http://127.0.0.1:8080',
  model: process.env.LLAMA_MODEL ?? 'local',
})

/** Session s-20260819: near-verbatim restatements. */
const OLD_CONTRACT = [
  'src/util/slug.js exports a slug() function',
  "slug('Hello World') returns 'hello-world' (no leading/trailing hyphen, only lowercase and hyphens)",
  "slug('already-lowercase') returns 'already-lowercase' (single hyphens, no leading/trailing)",
  "slug('  spaces  ') returns 'spaces' (trimmed, no leading/trailing hyphen)",
  "slug('multiple---hyphens') returns 'multiple-hyphens' (single hyphens only)",
  'node src/util/slug.test.js exits with code 0',
  'A reproduction (script or test) demonstrably FAILED before the fix — its red run is in the conversation — and passes after it',
]
const OLD_TICKS = [
  "slug('Hello World') returns 'hello-world'",
  "slug('multiple---hyphens') returns 'multiple-hyphens'",
  "slug('  spaces  ') returns 'spaces'",
]

/** Session s-20260823, after the rules fix: same requirement, different words. */
const NEW_CONTRACT = [
  "slugs contain only lowercase letters, digits and single hyphens — e.g. slug('Hello, World!') must return 'hello-world', not 'hello,-world!'",
  "no leading or trailing hyphens in the slug — e.g. slug('---hello---') must not return '-hello-' or '--hello--'",
  "slug('Hello, World!') returns 'hello-world'",
  "slug('---hello---') returns 'hello'",
  "slug('a--b') returns 'a-b'",
  "slug('Hello  World') returns 'hello-world'",
  'a new test exists in the test file that fails before the change and passes after',
  'A reproduction (script or test) demonstrably FAILED before the fix — its red run is in the conversation — and passes after it',
]
const NEW_TICKS = [
  'slug strips punctuation so only letters, digits and hyphens remain',
  'slug removes leading and trailing hyphens',
  'slug collapses multiple consecutive hyphens into one',
]

/** Session s-20260823-002557, driven through the real window: two of three ticks were kept
 * as new criteria, and #3 is criterion 1 with "Slug strings" for "slugs". */
const UI_CONTRACT = [
  'slugs contain only lowercase letters, digits and single hyphens — e.g. "Hello, World!" must become "hello-world"',
  'no leading or trailing hyphen — e.g. a slug must not start or end with "-"',
  'src/util/slug.js is read before any edit is made',
  'src/util/slug.js is edited so slug() satisfies both rules above',
  'a test exists that fails when run against the original slug() implementation',
  'the same test passes when run against the updated slug() implementation',
  'the test file is committed to the workspace (exists on disk after the work is done)',
  'A reproduction (script or test) demonstrably FAILED before the fix — its red run is in the conversation — and passes after it',
]
const UI_TICKS = [
  "slug('Hello, World!') returns 'hello-world' instead of 'hello,-world!'",
  'slugs never contain punctuation characters',
  'Slug strings contain only lowercase letters, digits, and single hyphens',
]

async function report(name: string, contract: string[], ticks: string[]): Promise<void> {
  const u: Understanding = { shared: [], contested: ticks }
  const answer = ticks.join('; ')
  const lexical = foldAnswer(u, answer, contract)
  const withModel = await foldAnswerWithModel(client, u, answer, contract)
  console.log(`\n=== ${name} ===`)
  console.log(`  contract ${contract.length} + ${ticks.length} ticks`)
  console.log(`     string comparison alone : ${lexical.nextCriteria.length} criteria`)
  console.log(`     asking the model        : ${withModel.nextCriteria.length} criteria`)
  for (const c of withModel.nextCriteria) {
    console.log(`        ${contract.includes(c) ? '    ' : 'NEW '} ${c.slice(0, 95)}`)
  }
}

await report('near-verbatim restatements (s-20260819)', OLD_CONTRACT, OLD_TICKS)
await report('same requirement, different words (s-20260823)', NEW_CONTRACT, NEW_TICKS)
await report('driven through the real window (s-20260823-002557)', UI_CONTRACT, UI_TICKS)

console.log('\n=== a genuinely SEPARATE requirement must survive ===')
// Same subject, plainly not implied: nothing about the allowed character set says
// anything about length. The earlier probe used "gap-free" against "no duplicates",
// which is a bad test -- a gap-free sequence really does imply uniqueness, so a model
// merging them is not obviously wrong.
for (const [criterion, tick] of [
  ['slugs contain only lowercase letters, digits and single hyphens', 'slugs are truncated to 60 characters'],
  ['every amount is rounded half-up to two decimals before it is summed', 'totals are shown with a thousands separator'],
  ['invoice numbers are gap-free', 'the invoice PDF shows the customer VAT number'],
] as [string, string][]) {
  const u2: Understanding = { shared: [], contested: [tick] }
  const kept = await foldAnswerWithModel(client, u2, tick, [criterion])
  console.log(`  ${kept.nextCriteria.length === 2 ? 'KEPT   ' : 'DROPPED'} ${tick}`)
}
