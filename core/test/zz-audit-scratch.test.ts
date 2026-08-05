import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { LlamaClient } from '../src/llama/client.js'
import { Session } from '../src/session/session.js'
import { createToolset } from '../src/tools/default-set.js'
import { startFakeServer } from './fake-server.js'

let stop: (() => Promise<void>) | undefined
const roots: string[] = []

afterEach(async () => {
  await stop?.()
  stop = undefined
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function writeStep(path: string, content: string): unknown {
  return {
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: `c-${path}`,
          type: 'function',
          function: { name: 'write_file', arguments: JSON.stringify({ path, content }) },
        }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  }
}

function textStep(text: string): unknown {
  return {
    choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 5 },
  }
}

test('AUDIT: nothing about a running turn reaches disk until it ends', async () => {
  const snapshots: { call: number; files: string[] }[] = []
  let root = ''
  let call = 0
  const fake = await startFakeServer((_body, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: 8000 } }
    if (req.url === '/health') return { status: 'ok' }
    call++
    // What the sessions directory looks like DURING the turn.
    const dir = join(root, '.privatecode', 'sessions')
    snapshots.push({ call, files: existsSync(dir) ? readdirSync(dir) : [] })
    return call <= 20 ? writeStep(`file${call}.txt`, `contents ${call}`) : textStep('done')
  })
  stop = fake.close
  root = mkdtempSync(join(tmpdir(), 'pc-audit-'))
  roots.push(root)

  const store = new (await import('../src/session/store.js')).SessionStore(root)
  const session = new Session({
    client: new LlamaClient({ baseUrl: fake.url, model: 'm' }),
    toolset: createToolset({}),
    workspaceRoot: root,
    mode: 'autopilot',
    longRun: true,
    store,
    checkpointIntervalMs: 0,
  })

  await session.send('do twenty things')

  // eslint-disable-next-line no-console
  console.log('DURING TURN, sessions dir at each model call:',
    JSON.stringify(snapshots.map((s) => `${s.call}:[${s.files.join(',')}]`)))

  const dir = join(root, '.privatecode', 'sessions')
  const after = readdirSync(dir)
  // eslint-disable-next-line no-console
  console.log('AFTER TURN:', JSON.stringify(after))
  const jsonl = readFileSync(join(dir, `${session.id}.jsonl`), 'utf8')
  // eslint-disable-next-line no-console
  console.log('AFTER TURN jsonl lines:', jsonl.trim().split('\n').length)

  // The audit claim: no session file of any kind existed while 20 steps of real work ran.
  expect(snapshots.every((s) => !s.files.some((f) => f.endsWith('.jsonl')))).toBe(true)
  expect(snapshots.every((s) => !s.files.some((f) => f.endsWith('.meta.json')))).toBe(true)
})
