import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { SessionHost } from '../src/host/host.js'
import { isHostEvent, type HostOutbound, type HostReply } from '../src/host/protocol.js'
import { PRIVATE_DIR } from '../src/private-dir.js'
import { startFakeServer } from './fake-server.js'

/**
 * What the window says it is talking to.
 *
 * llama.cpp serves whatever GGUF it was launched with and ignores the `model` field of a
 * request, so that field was never a selector — it was a label compiled into this build.
 * The user swapped their server to an 80B and the window went on displaying the 35B this
 * tool was written for. The name has to come from the server, and so does the window size,
 * because the two change together and the second is what explains the first.
 */

let stop: (() => Promise<void>) | undefined
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-model-'))
  mkdirSync(join(root, PRIVATE_DIR), { recursive: true })
})
afterEach(async () => {
  await stop?.()
  stop = undefined
  rmSync(root, { recursive: true, force: true })
})

interface Captured { messages: HostOutbound[]; send(m: HostOutbound): void }
const replyOf = (t: Captured, id: number): any => {
  const found = t.messages.find((m): m is HostReply => !isHostEvent(m) && m.id === id)
  if (found && 'error' in found) throw new Error(`request ${id} failed: ${found.error.message}`)
  return found?.result
}

/** `props` null means the server answers /props with a 500 — a model still loading. */
async function hostWith(props: { modelPath?: string; nCtx?: number } | null): Promise<Captured> {
  const fake = await startFakeServer((_b, req) => {
    if (req.url === '/health') return { status: 'ok' }
    if (req.url === '/props') {
      if (props === null) throw new Error('loading')
      return {
        ...(props.modelPath !== undefined ? { model_path: props.modelPath } : {}),
        default_generation_settings: { n_ctx: props.nCtx ?? 32768 },
      }
    }
    return { choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }
  })
  stop = fake.close
  const messages: HostOutbound[] = []
  const transport: Captured = { messages, send: (m) => { messages.push(m) } }
  const h = new SessionHost({ transport })
  await h.handle({ id: 1, method: 'init', params: { workspaceRoot: root, serverUrl: fake.url } })
  await h.handle({ id: 2, method: 'status', params: {} })
  await h.shutdown()
  return transport
}

test('the model name comes off the served file, not out of this build', async () => {
  const t = await hostWith({
    modelPath: 'D:\\Projects\\LocalAgent\\Qwen3-Coder-Next-UD-Q3_K_XL.gguf',
    nCtx: 32768,
  })
  const status = replyOf(t, 2)
  // The file name is the useful name: family, size and quantisation in one string.
  expect(status.model).toBe('Qwen3-Coder-Next-UD-Q3_K_XL')
  expect(status.model).not.toContain('.gguf')
  expect(status.model).not.toContain('\\')
  expect(status.contextLength).toBe(32768)
})

test('a posix path works too — the separator is the server\'s, not ours', async () => {
  const t = await hostWith({ modelPath: '/models/Llama-3.3-70B-Q4_K_M.gguf' })
  expect(replyOf(t, 2).model).toBe('Llama-3.3-70B-Q4_K_M')
})

test('a server that reports no path keeps a name rather than showing an empty label', async () => {
  const t = await hostWith({ nCtx: 8000 })
  const status = replyOf(t, 2)
  expect(typeof status.model).toBe('string')
  expect(status.model.length).toBeGreaterThan(0)
  expect(status.contextLength).toBe(8000)
})

test('a model still loading leaves no context length, and says nothing false about the name', async () => {
  // The ordinary case now, not the unlucky one: tens of gigabytes take minutes to load and
  // the window opens in a second, so the first probe of a cold start always misses.
  const t = await hostWith(null)
  const status = replyOf(t, 2)
  expect(status.contextLength).toBeUndefined()
  expect(typeof status.model).toBe('string')
})
