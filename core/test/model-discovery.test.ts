import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { SessionHost } from '../src/host/host.js'
import { isHostEvent, type HostEvent, type HostOutbound, type HostReply } from '../src/host/protocol.js'
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

/**
 * The second half of the same lesson: a value learned from the server once was then believed
 * forever. The name was fixed by reading it from `/props`; the WINDOW was read from the same
 * response and cached behind a guard that only re-probed when the first attempt had failed.
 * So a first success was permanent, and raising `-c` on the server reached nothing.
 */

/** A host held open across several requests, with props the test can change underneath it. */
async function liveHost(initial: { modelPath?: string; nCtx?: number } | null) {
  let props = initial
  const fake = await startFakeServer((_b, req) => {
    // A stopped server refuses BOTH, which is what makes the down->up edge observable.
    // llama.cpp answers /health with 503 until the weights are in, so "loading" and
    // "not running" look the same from here — as they should.
    if (req.url === '/health') {
      if (props === null) throw new Error('loading')
      return { status: 'ok' }
    }
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
  return {
    transport,
    serve: (p: { modelPath?: string; nCtx?: number } | null) => { props = p },
    newSession: async (id: number) => {
      await h.handle({ id, method: 'sessions.new', params: {} })
      return replyOf(transport, id)
    },
    status: async (id: number) => {
      await h.handle({ id, method: 'status', params: {} })
      return replyOf(transport, id)
    },
    close: () => h.shutdown(),
  }
}

test('a server restarted with a bigger window is picked up by New session', async () => {
  // The reported bug, exactly: `-c` raised from 131072 to 262144 on a server behind a
  // running window, and the app went on showing 131k. Nothing was wrong with the reading --
  // it simply never asked again.
  const h = await liveHost({ modelPath: '/m/Qwen3.6-35B-A3B.gguf', nCtx: 131072 })
  expect(replyOf(h.transport, 1).contextLength).toBe(131072)

  h.serve({ modelPath: '/m/Qwen3.6-80B-A3B.gguf', nCtx: 262144 })
  const fresh = await h.newSession(2)

  expect(fresh.contextLength).toBe(262144)
  // And the label moves with it, because the two change together: a window that grew is
  // nearly always a different file loaded.
  expect((await h.status(3)).model).toBe('Qwen3.6-80B-A3B')
  await h.close()
})

test('a server that goes down does not erase the window it already reported', async () => {
  // The reason the probe cannot simply overwrite: `/props` failing returns a null length,
  // and assigning that would turn compaction off for a session whose server is merely
  // restarting -- trading a stale number for a silently degraded session.
  const h = await liveHost({ modelPath: '/m/Qwen3.6-35B-A3B.gguf', nCtx: 131072 })
  h.serve(null)
  const fresh = await h.newSession(2)

  expect(fresh.contextLength).toBe(131072)
  expect(fresh.problems.some((p: string) => p.includes('compaction is off'))).toBe(false)
  await h.close()
})

test('a server restarted mid-session is picked up without starting a new one', async () => {
  // The user changes model settings on the fly: stop the server, edit `-c` or point it at a
  // different GGUF, start it again -- in the middle of a session that is already going. The
  // status poll is the only thing watching, and it used to report a cached number forever.
  const h = await liveHost({ modelPath: '/m/Qwen3.6-35B-A3B.gguf', nCtx: 131072 })
  expect((await h.status(2)).contextLength).toBe(131072)

  h.serve(null)                       // stopped: /props fails and /health is refused
  expect((await h.status(3)).serverUp).toBe(false)
  // Down is not a licence to forget: the last known window is still the best answer there is.
  expect((await h.status(4)).contextLength).toBe(131072)

  h.serve({ modelPath: '/m/Qwen3.6-80B-A3B.gguf', nCtx: 262144 })
  const back = await h.status(5)

  expect(back.serverUp).toBe(true)
  expect(back.contextLength).toBe(262144)
  expect(back.model).toBe('Qwen3.6-80B-A3B')
  await h.close()
})

test('the change is said out loud, because it changes how the session behaves', async () => {
  const h = await liveHost({ modelPath: '/m/small.gguf', nCtx: 131072 })
  await h.status(2)
  h.serve(null)
  await h.status(3)
  h.serve({ modelPath: '/m/big.gguf', nCtx: 262144 })
  await h.status(4)

  const notices = h.transport.messages
    .filter((m): m is HostEvent => isHostEvent(m) && m.event === 'settings.problem')
    .map((m) => (m.data as { text: string }).text)
  expect(notices.some((t) => t.includes('262k') && t.includes('was 131k'))).toBe(true)
  await h.close()
})

test('a restart that changes nothing says nothing', async () => {
  // The ordinary case -- the server stopped and came back the same -- must stay silent, or
  // the notice becomes noise and stops being read.
  const h = await liveHost({ modelPath: '/m/same.gguf', nCtx: 131072 })
  await h.status(2)
  const before = h.transport.messages.length
  h.serve(null)
  await h.status(3)
  h.serve({ modelPath: '/m/same.gguf', nCtx: 131072 })
  await h.status(4)

  const notices = h.transport.messages.slice(before)
    .filter((m) => isHostEvent(m) && m.event === 'settings.problem')
  expect(notices).toEqual([])
  await h.close()
})
