// One-shot network smoke of the web tool's two halves, run by hand:
//   cd core && npx tsx ../spike/web-smoke.mts
import { webSearch, renderHits } from '../core/src/web/search.js'
import { fetchPage, extractReadable } from '../core/src/web/read.js'

const s = await webSearch('Node.js LTS current version')
console.log('engine:', s.engine, '| hits:', s.hits.length)
console.log(renderHits(s.hits.slice(0, 3), s.engine))

const target = s.hits[0]!.url
const p = await fetchPage(target)
const a = extractReadable(p.body, target)
console.log('\nREAD:', a.title, '| jsShell:', a.jsShell, '| text chars:', a.text.length)
console.log(a.text.slice(0, 300))
