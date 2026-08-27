/**
 * Does a worker actually work, and does the caller actually reach for one?
 *
 * The unit tests pin the plumbing. Three things they cannot answer, and all three decide
 * whether this feature is worth its place in the tool array — which is not free, since the
 * array renders at the FRONT of the prompt and every tool in it is paid for on every request:
 *
 *   1. does a worker, given a self-contained job and a read-only tool set, come back with a
 *      right answer — and how much does it cost
 *   2. does the CALLER pick `delegate` when delegating is the sensible move
 *   3. does the caller leave it alone when it is not — a model that delegates "what is 2+2"
 *      has made every turn slower for nothing
 *
 *   npx tsx spike/delegate-live-probe.mts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlamaClient } from '../core/src/llama/client.js'
import { ROLES, runSubAgent } from '../core/src/agent/subagent.js'
import { buildRegistry } from '../core/src/tools/default-set.js'
import { Workspace } from '../core/src/workspace.js'

const client = new LlamaClient({
  baseUrl: process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080',
  model: 'qwen',
})

/** A small workspace with one fact buried two files deep. */
function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'pc-delegate-live-'))
  mkdirSync(join(root, 'src', 'util'), { recursive: true })
  mkdirSync(join(root, 'src', 'api'), { recursive: true })
  writeFileSync(join(root, 'src', 'util', 'slug.ts'),
    'const MAX = 60\n\n' +
    'export function slug(text: string): string {\n' +
    "  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, MAX)\n" +
    '}\n', 'utf8')
  writeFileSync(join(root, 'src', 'api', 'posts.ts'),
    "import { slug } from '../util/slug'\n\n" +
    'export function createPost(title: string) {\n' +
    '  return { id: slug(title), title }\n' +
    '}\n', 'utf8')
  writeFileSync(join(root, 'src', 'api', 'pages.ts'),
    "import { slug } from '../util/slug'\n\n" +
    'export function createPage(title: string) {\n' +
    '  return { path: `/${slug(title)}`, title }\n' +
    '}\n', 'utf8')
  return root
}

// ---------------------------------------------------------------------- 1. the worker ----

const root = makeWorkspace()
const registry = buildRegistry()
const workspace = new Workspace(root)
const investigate = ROLES.find((r) => r.name === 'investigate')!

console.log('1. a worker on a self-contained job\n')
for (const task of [
  'Which files call the slug() function, and what do they use the result for? ' +
    'Name every caller with its path.',
  'What is the maximum length a slug can be, and where is that limit defined?',
]) {
  const out = await runSubAgent({ client, registry, workspace }, investigate, task)
  const right = /posts\.ts/.test(out.text) && /pages\.ts/.test(out.text)
  const limit = /60/.test(out.text) && /slug\.ts/.test(out.text)
  console.log(`  ${(out.ms / 1000).toFixed(1).padStart(6)}s  ${out.steps} steps  ${out.problem ?? ''}`)
  console.log(`     ${out.text.replace(/\s+/g, ' ').slice(0, 150)}`)
  console.log(`     callers named: ${right}   limit named: ${limit}\n`)
}

// ------------------------------------------------------- 2 and 3. does the caller pick ----

const TOOLS = registry.schemas().map((s) => ({ type: 'function', function: s.function }))

async function whatDoesItCall(ask: string): Promise<string> {
  const res = await fetch(`${process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080'}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [
        {
          role: 'system',
          content: 'You are PrivateCode, a coding agent working in the local workspace ' +
            `${root}. Work in small steps.`,
        },
        { role: 'user', content: ask },
      ],
      tools: TOOLS,
      temperature: 0.7,
      top_p: 0.8,
      max_tokens: 400,
      stream: false,
    }),
  })
  const body = await res.json() as {
    choices?: { message?: { tool_calls?: { function?: { name?: string; arguments?: string } }[]; content?: string } }[]
  }
  const call = body.choices?.[0]?.message?.tool_calls?.[0]?.function
  if (!call) return `(no call) ${(body.choices?.[0]?.message?.content ?? '').slice(0, 60)}`
  return `${call.name} ${(call.arguments ?? '').replace(/\s+/g, ' ').slice(0, 80)}`
}

const WORTH_DELEGATING = [
  'I need a full picture of every place slug() is used and what depends on its output ' +
    'before I change it. Find that out.',
  'Work out how this codebase turns a title into a URL — trace it end to end and tell me ' +
    'where every decision is made.',
]
const NOT_WORTH_DELEGATING = [
  'What is 2 + 2?',
  'Read src/util/slug.ts for me.',
]

console.log('2. jobs where delegating is the sensible move\n')
for (const ask of WORTH_DELEGATING) console.log(`  ${await whatDoesItCall(ask)}`)

console.log('\n3. jobs where it is not\n')
for (const ask of NOT_WORTH_DELEGATING) console.log(`  ${await whatDoesItCall(ask)}`)

rmSync(root, { recursive: true, force: true })
