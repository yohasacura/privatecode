import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session } from '../src/session/session.js'
import { LlamaClient } from '../src/llama/client.js'
import { createToolset } from '../src/tools/default-set.js'
import { PermissionEngine } from '../src/permissions/engine.js'
import { splitUserMessage } from '../src/host/replay.js'
import { sha1 } from '../src/map/digest.js'
import type { MapIndex } from '../src/map/notes.js'
import { RawResponse, startFakeServer } from './fake-server.js'

/**
 * How the map reaches the model on a mapped workspace, end to end and without a model:
 * the rule in the system prompt, the nearest notes folded into the user message — alone,
 * or inside the contract's bracket — and the window showing the person's words only.
 */

let root: string
let stop: (() => Promise<void>) | undefined

const SOURCE = 'export function placeOrder(total: number): string { return String(total) }\n'
const REQUEST = 'Where is placeOrder and what does it return?'

function mapIndex(): MapIndex {
  const hash = sha1(SOURCE)
  return {
    version: 1, builtAt: '2026-09-08T00:00:00.000Z',
    skeleton: {
      builtAt: '2026-09-08T00:00:00.000Z', commits: 0,
      files: [{ path: 'src/orders.ts', hash, bytes: SOURCE.length, lines: 1, language: 'ts', symbols: [{ kind: 'function', name: 'placeOrder', line: 1, depth: 0 }], uses: [], usedBy: [], tests: [], isTest: false, coChanges: [], history: [] }],
      modules: [{ path: '', files: [], children: ['src'] }, { path: 'src', files: ['src/orders.ts'], children: [] }],
      mounts: [{ name: '', root }],
    },
    notes: {
      files: {
        'src/orders.ts': {
          kind: 'file', path: 'src/orders.ts', hash, what: 'Places an order.', why: 'Orders.',
          contracts: [{ symbol: 'placeOrder', guarantees: 'returns the formatted total' }], invariants: [], gotchas: ['doubles the total on retry'],
          builtAt: '2026-09-08T00:00:00.000Z', model: 'scripted',
        },
      },
      modules: {},
    },
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-map-move-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, '.privatecode', 'map'), { recursive: true })
  writeFileSync(join(root, 'src', 'orders.ts'), SOURCE, 'utf8')
  writeFileSync(join(root, '.privatecode', 'map', 'index.json'), JSON.stringify(mapIndex()), 'utf8')
})
afterEach(async () => {
  await stop?.()
  stop = undefined
  rmSync(root, { recursive: true, force: true })
})

const text = (s: string) => ({
  choices: [{ message: { role: 'assistant', content: s }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1000, completion_tokens: 10 },
})

const contract = {
  goal: 'say where placeOrder is', rules: [], criteria: ['the file is named'],
  constraints: [], interfaces: '', kind: 'question', changesCode: false,
}

/** Records every chat request's messages; answers gates by schema name and the loop with "done". */
async function serve(requests: { role: string; content: string | null }[][]) {
  const fake = await startFakeServer((body, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: 32_000 } }
    if (req.url === '/health') return { status: 'ok' }
    if (req.url?.startsWith('/slots/')) return new RawResponse(501, '{"error":{"code":501}}', 'application/json')
    const name = (body.response_format as { json_schema?: { name?: string } } | undefined)?.json_schema?.name
    if (name === 'contract') return text(JSON.stringify(contract))
    if (name !== undefined) return text(JSON.stringify({ items: [], premises: [], does: [] }))
    requests.push(body.messages as { role: string; content: string | null }[])
    return text('It is in src/orders.ts and returns the formatted total.')
  })
  stop = fake.close
  return fake
}

function build(url: string, gates?: 'off'): Session {
  return new Session({
    client: new LlamaClient({ baseUrl: url, model: 'm' }),
    toolset: createToolset({}),
    workspaceRoot: root,
    mode: 'normal',
    engine: new PermissionEngine({ layers: [], mode: 'normal', workspaceRoot: root }),
    ...(gates !== undefined ? { gates } : {}),
  })
}

test('on a mapped workspace the rule is in the prompt and the nearest notes ride in the user message', async () => {
  const requests: { role: string; content: string | null }[][] = []
  const fake = await serve(requests)
  await build(fake.url, 'off').send(REQUEST)
  const first = requests[0]!
  expect(first[0]!.role).toBe('system')
  expect(first[0]!.content).toContain('This workspace has a detailed project map')
  const user = first.find((m) => m.role === 'user')!.content!
  expect(user.startsWith('[Project map — the notes nearest this request')).toBe(true)
  expect(user).toContain('- src/orders.ts — Places an order.')
  expect(user).toContain('  · contract: placeOrder — returns the formatted total')
  expect(user.endsWith(`]\n\n${REQUEST}`)).toBe(true)
  // The window shows the person's words, not the harness's.
  expect(splitUserMessage(user)).toEqual({ kind: 'user', text: REQUEST })
})

test('with a contract the notes share its bracket, and the window still shows the request alone', async () => {
  const requests: { role: string; content: string | null }[][] = []
  const fake = await serve(requests)
  // Task-shaped (three sentences, over eighty characters), so a contract is distilled.
  const task = 'Add a currency parameter to placeOrder in src/orders.ts. Keep the formatted total as the return value. Then tell me which files call placeOrder.'
  await build(fake.url).send(task)
  const user = requests[0]!.find((m) => m.role === 'user')!.content!
  expect(user.startsWith('[TASK CONTRACT')).toBe(true)
  expect(user).toContain('\n\nProject map — the notes nearest this request')
  expect(user.endsWith(`]\n\n${task}`)).toBe(true)
  expect(splitUserMessage(user).text).toBe(task)
})

test('a request about nothing on the map carries no block, and no map means no rule', async () => {
  const requests: { role: string; content: string | null }[][] = []
  const fake = await serve(requests)
  await build(fake.url, 'off').send('Why does the login page flicker on Safari?')
  expect(requests[0]!.find((m) => m.role === 'user')!.content).toBe('Why does the login page flicker on Safari?')
  expect(requests[0]![0]!.content).toContain('ProjectMap')

  rmSync(join(root, '.privatecode', 'map'), { recursive: true, force: true })
  const bare: { role: string; content: string | null }[][] = []
  const other = await serve(bare)
  await build(other.url, 'off').send(REQUEST)
  expect(bare[0]![0]!.content).not.toContain('ProjectMap')
  expect(bare[0]!.find((m) => m.role === 'user')!.content).toBe(REQUEST)
})
