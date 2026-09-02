/**
 * What the project map looks like for a real multi-folder workspace, with the layout block
 * and line numbers — printed, so the thing the model reads first can be read by a person.
 *
 *   npx tsx spike/map-preview.mts [budgetChars]
 */
import { indexRepo, renderIndex, DEFAULT_MAP_BUDGET } from '../core/src/outline/repo-map.js'

const budget = Number(process.argv[2] ?? DEFAULT_MAP_BUDGET)
const started = Date.now()
const index = await indexRepo([
  { name: 'backend', root: 'D:\\Projects\\black-port\\src\\backend', access: 'write', primary: true },
  { name: 'frontend', root: 'D:\\Projects\\black-port\\src\\frontend', access: 'write', primary: false },
])
const indexed = Date.now() - started
const text = renderIndex(index, budget)
const files = index.folders.reduce((n, f) => n + f.files.length, 0)
const listed = (text.match(/^(backend|frontend)\/\S+$/gm) ?? []).length
console.log(`indexed ${files} files in ${indexed} ms; map ${text.length} chars (~${Math.ceil(text.length / 4)} tokens), ${listed} files listed at budget ${budget}\n`)
console.log(text)
