/**
 * What the tool array costs, and why that number settles the "load everything vs. a
 * tool-search tool" question for THIS deployment rather than in general.
 *
 *   npx tsx spike/tool-array-cost.mts
 */
import { buildRegistry } from '../core/src/tools/default-set.js'

const schemas = buildRegistry().schemas()
const json = JSON.stringify(schemas)

console.log(`tools           : ${schemas.length}`)
console.log(`serialised      : ${json.length} chars  (~${Math.round(json.length / 4)} tokens)`)
console.log('')
console.log('per tool, largest first:')
const sized = schemas
  .map((s) => ({ name: s.function.name, chars: JSON.stringify(s).length }))
  .sort((a, b) => b.chars - a.chars)
for (const t of sized.slice(0, 6)) {
  console.log(`  ${t.name.padEnd(18)} ${String(t.chars).padStart(5)} chars  ~${Math.round(t.chars / 4)} tokens`)
}
console.log(`  ... ${sized.length - 6} more`)
