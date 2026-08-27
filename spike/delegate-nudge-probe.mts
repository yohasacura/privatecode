/**
 * Is the caller's choice reachable at all?
 *
 * The probe above says the tool works and the caller never picks it — which is this
 * project's law pointing the usual way: the description asks for a JUDGEMENT ("use it when
 * answering would take several reads"), and judgements are what prose does not route.
 *
 * Before concluding that, one thing is worth measuring, because prose is not uniformly
 * useless here: naming the shell in a tool description moved `&&` from 2/12 to 1/12 earlier
 * today. So the question is whether a line in the SYSTEM prompt — the place the 0/703 result
 * came from — moves this one.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRegistry } from '../core/src/tools/default-set.js'

const BASE = process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080'
const root = mkdtempSync(join(tmpdir(), 'pc-nudge-'))
mkdirSync(join(root, 'src', 'util'), { recursive: true })
mkdirSync(join(root, 'src', 'api'), { recursive: true })
writeFileSync(join(root, 'src', 'util', 'slug.ts'), 'export function slug(t: string) { return t }\n', 'utf8')
writeFileSync(join(root, 'src', 'api', 'posts.ts'), "import { slug } from '../util/slug'\n", 'utf8')
writeFileSync(join(root, 'src', 'api', 'pages.ts'), "import { slug } from '../util/slug'\n", 'utf8')

const TOOLS = buildRegistry().schemas().map((s) => ({ type: 'function', function: s.function }))
const BASE_SYSTEM = `You are PrivateCode, a coding agent working in the local workspace ${root}. Work in small steps.`
const WITH_NUDGE = `${BASE_SYSTEM}\n\nA question that needs several files read before it can be answered goes to a worker: call delegate with the whole question. You get the answer without the reading landing here.`

const ASKS = [
  'I need a full picture of every place slug() is used and what depends on its output before I change it. Find that out.',
  'Work out how this codebase turns a title into a URL — trace it end to end and tell me where every decision is made.',
  'Before I touch the slug helper, find out everything that would break.',
]

async function firstCall(system: string, ask: string): Promise<string> {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'system', content: system }, { role: 'user', content: ask }],
      tools: TOOLS, temperature: 0.7, top_p: 0.8, max_tokens: 300, stream: false,
    }),
  })
  const body = await res.json() as { choices?: { message?: { tool_calls?: { function?: { name?: string } }[] } }[] }
  return body.choices?.[0]?.message?.tool_calls?.[0]?.function?.name ?? '(no call)'
}

for (const [label, system] of [['bare  ', BASE_SYSTEM], ['nudged', WITH_NUDGE]] as const) {
  const picked: string[] = []
  for (const ask of ASKS) picked.push(await firstCall(system, ask))
  const n = picked.filter((p) => p === 'delegate').length
  console.log(`  ${label}  delegate ${n}/${ASKS.length}   ${picked.join(', ')}`)
}
rmSync(root, { recursive: true, force: true })
