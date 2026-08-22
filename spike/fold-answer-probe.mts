/**
 * What an answered understanding check does to the contract.
 *
 * The case is the real one, copied out of a live session's meta: seven distilled criteria, a
 * person ticks three readings of the same request, and the contract goes to ten — items 8, 9
 * and 10 restating 2, 4 and 5 in slightly shorter words. Every duplicate is audited on its
 * own, planned on its own, and promoted into message 0 at every compaction.
 *
 *   npx tsx spike/fold-answer-probe.mts
 */
import { foldAnswer, type Understanding } from '../core/src/session/understanding.js'

/** Exactly the criteria the distiller produced in that session, in order. */
const CONTRACT = [
  'src/util/slug.js exports a slug() function',
  "slug('Hello World') returns 'hello-world' (no leading/trailing hyphen, only lowercase and hyphens)",
  "slug('already-lowercase') returns 'already-lowercase' (single hyphens, no leading/trailing)",
  "slug('  spaces  ') returns 'spaces' (trimmed, no leading/trailing hyphen)",
  "slug('multiple---hyphens') returns 'multiple-hyphens' (single hyphens only)",
  'node src/util/slug.test.js exits with code 0',
  'A reproduction (script or test) demonstrably FAILED before the fix — its red run is in the conversation — and passes after it',
]

/** And exactly the three options the person ticked. */
const UNDERSTANDING: Understanding = {
  shared: ['slug() strips punctuation'],
  contested: [
    "slug('Hello World') returns 'hello-world'",
    "slug('multiple---hyphens') returns 'multiple-hyphens'",
    "slug('  spaces  ') returns 'spaces'",
  ],
}
const ANSWER = UNDERSTANDING.contested.join('; ')

const folded = foldAnswer(UNDERSTANDING, ANSWER, CONTRACT)
console.log(`contract before : ${CONTRACT.length} criteria`)
console.log(`ticked          : ${folded.criteria.length}`)
console.log(`contract after  : ${folded.nextCriteria.length} criteria`)
for (const c of folded.nextCriteria) {
  const isNew = !CONTRACT.includes(c)
  console.log(`   ${isNew ? 'NEW  ' : '     '} ${c}`)
}

console.log('\n--- a tick that says MORE than the criterion sharpens it ---')
const sharpen = foldAnswer(
  { shared: [], contested: ['invoice numbers are gap-free even when a transaction rolls back'] },
  'invoice numbers are gap-free even when a transaction rolls back',
  ['invoice numbers are gap-free'],
)
console.log(`   ${sharpen.nextCriteria.length} criteria: ${JSON.stringify(sharpen.nextCriteria)}`)

console.log('\n--- a tick that says LESS must not narrow it ---')
const narrow = foldAnswer(
  { shared: [], contested: ['invoice numbers are gap-free'] },
  'invoice numbers are gap-free',
  ['invoice numbers are gap-free even when a transaction rolls back'],
)
console.log(`   ${narrow.nextCriteria.length} criteria: ${JSON.stringify(narrow.nextCriteria)}`)

console.log('\n--- a genuinely new reading is still added ---')
const added = foldAnswer(
  { shared: [], contested: ['concurrent requests never produce a duplicate number'] },
  'concurrent requests never produce a duplicate number',
  ['invoice numbers are gap-free'],
)
console.log(`   ${added.nextCriteria.length} criteria: ${JSON.stringify(added.nextCriteria)}`)
