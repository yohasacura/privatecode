import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session, type StageInfo } from '../src/session/session.js'
import { LlamaClient } from '../src/llama/client.js'
import { createToolset } from '../src/tools/default-set.js'
import { PermissionEngine } from '../src/permissions/engine.js'
import { RawResponse, startFakeServer } from './fake-server.js'

/**
 * Two promises about who decides when a check runs.
 *
 * "Checks off" (gateMode manual) says nothing checks until asked — and until now the pair
 * at the first write (premises, lenses) and the build after every edit ran anyway, some forty
 * seconds of gates on a turn the person had told to stop checking. And `/review` typed by a
 * person must run the reviewer whatever the `gates` profile says: the profile decides what
 * runs by ITSELF, never what someone may ask for by name.
 */

let root: string
let stop: (() => Promise<void>) | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-checks-'))
  mkdirSync(join(root, '.privatecode'), { recursive: true })
})
afterEach(async () => {
  await stop?.()
  stop = undefined
  rmSync(root, { recursive: true, force: true })
})

const TASK =
  'Create a file notes/summary.txt that explains what this workspace is for, in at least ' +
  'three short paragraphs. Then confirm the file exists by reading it back. Keep the wording ' +
  'plain and do not touch any other file in the workspace while you do it.'

const contract = {
  goal: 'notes/summary.txt exists and explains the workspace',
  rules: [], criteria: ['notes/summary.txt exists', 'it has three paragraphs'],
  constraints: [], interfaces: '', kind: 'feature', changesCode: true,
}

const write = (content: string) => ({
  choices: [{
    message: {
      role: 'assistant', content: null,
      tool_calls: [{ id: 'w1', type: 'function', function: { name: 'Write', arguments: JSON.stringify({ path: 'notes/summary.txt', content }) } }],
    },
    finish_reason: 'tool_calls',
  }],
  usage: { prompt_tokens: 900, completion_tokens: 40 },
})
const text = (s: string) => ({
  choices: [{ message: { role: 'assistant', content: s }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1000, completion_tokens: 10 },
})

/**
 * A fake that answers each kind of request by what it IS: gate requests by their schema
 * name, the main loop by call order. `seen` records the schema names asked for.
 */
async function serve(steps: () => unknown, seen: string[]) {
  const fake = await startFakeServer((body, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: 32_000 } }
    if (req.url === '/health') return { status: 'ok' }
    if (req.url?.startsWith('/slots/')) return new RawResponse(501, '{"error":{"code":501}}', 'application/json')
    const name = (body.response_format as { json_schema?: { name?: string } } | undefined)?.json_schema?.name
    if (name !== undefined) {
      seen.push(name)
      if (name === 'contract') return text(JSON.stringify(contract))
      if (name === 'acceptance') return text(JSON.stringify({ items: [{ index: 1, evidence: 'written', met: true }, { index: 2, evidence: 'three paragraphs', met: true }] }))
      if (name === 'review') return text(JSON.stringify({ goalMet: true, goalGap: '', issues: [] }))
      if (name === 'premises') return text(JSON.stringify({ premises: [] }))
      return text(JSON.stringify({ does: ['a summary file exists'] }))
    }
    return steps()
  })
  stop = fake.close
  return fake
}

function build(url: string, stages: StageInfo[], verifies: string[], gates?: 'fast'): Session {
  return new Session({
    client: new LlamaClient({ baseUrl: url, model: 'm' }),
    toolset: createToolset({}),
    workspaceRoot: root,
    mode: 'autopilot',
    engine: new PermissionEngine({ layers: [], mode: 'autopilot', workspaceRoot: root }),
    verify: { command: 'cmd /c exit 0', timeoutMs: 20_000, source: 'test' },
    onVerify: (i) => verifies.push(i.command),
    onStage: (s) => stages.push(s),
    ...(gates !== undefined ? { gates } : {}),
  })
}

test('Checks off holds the first-write pair and the build after an edit until /check', async () => {
  let call = 0
  const seen: string[] = []
  const fake = await serve(() => { call++; return call === 1 ? write('one\n\ntwo\n\nthree\n') : text('done') }, seen)
  const stages: StageInfo[] = []
  const verifies: string[] = []
  const session = build(fake.url, stages, verifies)
  session.gateMode = 'manual'

  await session.send(TASK)

  // The contract still distils — `/review` needs one — but nothing checked the write.
  expect(seen).toContain('contract')
  expect(seen).not.toContain('premises')
  expect(seen).not.toContain('reading')
  expect(seen).not.toContain('acceptance')
  expect(verifies).toHaveLength(0)
  expect(stages.map((s) => s.stage)).not.toContain('premises')
  expect(stages.map((s) => s.stage)).not.toContain('understanding')
  // And the prompt does not claim a check that will not come.
  expect(session.messages()[0]?.content).not.toMatch(/runs by itself/)

  // Asked by hand, the build runs.
  await session.runGate('build')
  expect(verifies).toEqual(['cmd /c exit 0'])
})

test('/review runs the reviewer even in the fast profile', async () => {
  let call = 0
  const seen: string[] = []
  // A change big enough for an independent reader to have something to read.
  const fake = await serve(() => { call++; return call === 1 ? write('paragraph\n'.repeat(300)) : text('done, the file is written') }, seen)
  const stages: StageInfo[] = []
  const session = build(fake.url, stages, [], 'fast')

  await session.send(TASK)
  // By itself, `fast` audits and does not review.
  expect(seen).toContain('acceptance')
  expect(seen).not.toContain('review')

  const asked = await session.runGate('review')
  expect(seen).toContain('review')
  expect(asked.outcome).not.toContain('nothing to review')
  expect(stages.some((s) => s.stage === 'review' && s.state === 'done')).toBe(true)
})
