/**
 * How big the constant prefix actually is, so the constants sized against it can be honest.
 *
 * `session.ts`'s `TOOL_SCHEMA_TOKENS` was measured when the toolset had fifteen tools. It
 * has twenty-one now, and that number feeds the context-fill estimate that decides when to
 * compact — an estimate reading low is how an over-long prompt got through in the first
 * place.
 *
 *   npx tsx spike/prefix-size-probe.mts
 */
import { createToolset } from '../core/src/tools/default-set.js'

const toolset = createToolset({ workspaceRoot: process.cwd() } as never)
const all = toolset.registry.schemas()
const readOnly = toolset.registry.schemas(toolset.registry.readOnlyNames())

const size = (v: unknown): number => JSON.stringify(v).length
const tokens = (chars: number): number => Math.ceil(chars / 4)

console.log(`tools registered        : ${all.length}`)
console.log(`full array              : ${size(all)} chars ~ ${tokens(size(all))} tokens`)
console.log(`read-only (plan mode)   : ${readOnly.length} tools, ${size(readOnly)} chars ~ ${tokens(size(readOnly))} tokens`)
console.log('\nper tool, largest first:')
for (const s of [...all].sort((a, b) => size(b) - size(a))) {
  console.log(`  ${s.function.name.padEnd(16)} ${String(size(s)).padStart(5)} chars`)
}
