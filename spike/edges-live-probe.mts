// Live integration probe for Move 7: the real vendored roslyn-nav.exe against the real
// QwenLauncher repository. Measures harvest time, edge yield, and how the map's top
// reorders once compiler-confirmed edges join the graph. Run: npx tsx spike/edges-live-probe.ts
import { indexRepo, renderIndex } from '../core/src/outline/repo-map.js'
import { harvestReferenceEdges } from '../core/src/csharp/reference-edges.js'
import { stopNavProcess } from '../core/src/csharp/nav-process.js'

const ROOT = process.argv[2] ?? 'D:/Projects/LocalAgent/local-standard-server/src'

async function main(): Promise<void> {
const t0 = Date.now()
const index = await indexRepo(ROOT)
const files = index.folders[0]?.files ?? []
console.log(`indexed ${files.length} files in ${Date.now() - t0}ms`)
console.log(`.cs files: ${files.filter((f) => f.path.endsWith('.cs')).length}`)

const t1 = Date.now()
const edges = await harvestReferenceEdges(ROOT, index)
console.log(`harvest: ${Date.now() - t1}ms`)
if (edges === null) {
  console.log('NO EDGES (helper missing, load failed, or nothing to attribute)')
} else {
  let total = 0
  for (const [, tos] of edges) for (const [, w] of tos) total += w
  console.log(`edges: ${edges.size} referencing files, total weight ${total}`)
  for (const [from, tos] of [...edges.entries()].slice(0, 6)) {
    for (const [to, w] of [...tos.entries()].slice(0, 3)) console.log(`  ${from} -> ${to} (${w})`)
  }
}

const top = (s: string) => s.split('\n').filter((l) => /^\S+\.(cs|xaml|csproj)$/.test(l.trim())).slice(0, 12)
const before = top(renderIndex(index))
const after = top(renderIndex(index, undefined, [], edges ?? undefined))
console.log('\n== map top, textual only:')
before.forEach((l, i) => console.log(`  ${i + 1}. ${l}`))
console.log('== map top, with semantic edges:')
after.forEach((l, i) => console.log(`  ${i + 1}. ${l}${l === before[i] ? '' : '   << moved'}`))

await stopNavProcess()
}

main().catch((e) => { console.error(e); process.exit(1) })
