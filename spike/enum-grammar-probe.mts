/**
 * What a `response_format` enum of N workspace paths costs the sampler — and whether the
 * server accepts one at all.
 *
 * The idea on the table: a forced orientation step whose `open[].path` is an ENUM of every
 * source file in the workspace, so the model cannot name a file that does not exist and the
 * batch is complete in one generation. A response_format schema contributes zero prompt
 * tokens (measured, docs/SPIKE-KAT-CODER.md), so the only unknown is the grammar itself:
 * llama.cpp compiles the enum into alternations, and a few thousand of them might cost real
 * time per token — or be refused outright.
 *
 *   npx tsx spike/enum-grammar-probe.mts
 */
import { execFileSync } from 'node:child_process'

const BASE = process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080'
const REPO = 'D:\\Projects\\black-port'

const realPaths = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' })
  .split('\n').map((s) => s.trim()).filter((p) => /\.(cs|ts|tsx|js|razor|json|yml|md)$/.test(p))

function pathsOf(n: number): string[] {
  const out = [...realPaths]
  let i = 0
  while (out.length < n) {
    out.push(`src/generated/Module${Math.floor(i / 40)}/Component${i}.tsx`)
    i++
  }
  return out.slice(0, n)
}

const SYSTEM = 'You are PrivateCode, a coding agent working in the local workspace D:\\Projects\\black-port.\n' +
  'Work in small steps. Prefer a targeted search over a broad one. Always reply in English.'

const REQUEST = 'The login form on the frontend does not show the API validation error when the password is too short. ' +
  'Find out why and fix it. Look at the auth controller in the backend and the login page in the frontend.'

const tools = [
  { type: 'function', function: { name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'search_code', description: 'Search with ripgrep.', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'edit_file', description: 'Edit.', parameters: { type: 'object', properties: { path: { type: 'string' }, search_text: { type: 'string' }, replace_text: { type: 'string' } }, required: ['path', 'search_text', 'replace_text'] } } },
]

async function once(n: number, withEnum: boolean): Promise<void> {
  const paths = pathsOf(n)
  const schema = {
    type: 'object',
    required: ['open', 'search'],
    additionalProperties: false,
    properties: {
      open: {
        type: 'array',
        items: {
          type: 'object',
          required: ['path'],
          additionalProperties: false,
          properties: withEnum ? { path: { type: 'string', enum: paths } } : { path: { type: 'string' } },
        },
      },
      search: { type: 'array', items: { type: 'string' } },
    },
  }
  const body = {
    model: 'kat',
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `${REQUEST}\n\n[Before doing anything: list the files to open (up to 8) and the text patterns to search for (up to 4), as JSON only.]` },
    ],
    tools,
    // Both or neither — see forced-json.ts: on b10665 `tools` plus `response_format` without
    // this is refused outright ("failed to parse grammar"), and that refusal is what the
    // first run of this probe measured.
    tool_choice: 'none',
    max_tokens: 600,
    temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0,
    cache_prompt: true,
    chat_template_kwargs: { enable_thinking: false },
    response_format: { type: 'json_schema', json_schema: { name: 'orient', strict: true, schema } },
  }
  const started = performance.now()
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const wall = (performance.now() - started) / 1000
  const text = await res.text()
  if (!res.ok) {
    console.log(`n=${n} enum=${withEnum}: HTTP ${res.status} in ${wall.toFixed(1)}s — ${text.slice(0, 200)}`)
    return
  }
  const data = JSON.parse(text)
  const content = data.choices?.[0]?.message?.content ?? ''
  let parsed: any = null
  try { parsed = JSON.parse(content) } catch { /* reported below */ }
  const opened: string[] = parsed?.open?.map((o: any) => o.path) ?? []
  const valid = opened.filter((p) => realPaths.includes(p) || paths.includes(p)).length
  const t = data.timings ?? {}
  console.log(
    `n=${n} enum=${withEnum}: ${wall.toFixed(1)}s wall, prompt ${t.prompt_n ?? '?'} tok ` +
    `(${(t.prompt_ms ?? 0).toFixed(0)} ms), gen ${t.predicted_n ?? '?'} tok at ` +
    `${(t.predicted_per_second ?? 0).toFixed(1)} tok/s; opened ${opened.length} (${valid} valid), ` +
    `search ${JSON.stringify(parsed?.search ?? null)}`,
  )
  for (const p of opened) console.log(`    ${p}`)
}

async function main(): Promise<void> {
  console.log(`real paths: ${realPaths.length}`)
  await once(0, false)
  for (const n of [100, 500, 962, 2000, 4000]) await once(n, true)
}

main().catch((e) => { console.error(e); process.exit(1) })
