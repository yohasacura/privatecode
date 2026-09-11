import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { SessionHost } from '../src/host/host.js'
import type { HostOutbound, WorkspaceGetResult } from '../src/host/protocol.js'
import { loadMounts, saveWorkspaceFile } from '../src/mounts.js'
import { startFakeServer } from './fake-server.js'

/**
 * The manager replaces the folder list whole, and once replaced it with a list it had not
 * finished loading: an Add pressed before `workspace.get` answered (or while the folder
 * picker was open) sent the new folder alone, and a workspace of several folders came back
 * as the primary plus the new one. The host now refuses a list that cannot be one manager
 * action, and lists a folder it cannot mount so a save keeps it.
 */

const dirs: string[] = []
let stop: (() => Promise<void>) | undefined
afterEach(async () => {
  if (stop) { await stop(); stop = undefined }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function dir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

interface Captured { messages: HostOutbound[]; send(msg: HostOutbound): void }
type Reply = { result?: unknown; error?: { message: string } }
type Spec = { path: string; name?: string; access: 'write' | 'read' }

function replyTo(t: Captured, id: number): Reply {
  const found = t.messages.find((m) => !('event' in m) && m.id === id)
  if (!found) throw new Error(`no reply to request ${id}`)
  return found as Reply
}

async function hostFor(primary: string) {
  const fake = await startFakeServer((_body, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: 1000 } }
    if (req.url === '/health') return { status: 'ok' }
    return {}
  })
  stop = fake.close
  const messages: HostOutbound[] = []
  const t: Captured = { messages, send: (m) => { messages.push(m) } }
  const host = new SessionHost({ transport: t, prewarm: false })
  let id = 1
  await host.handle({ id: id++, method: 'init', params: { workspaceRoot: primary, serverUrl: fake.url } })
  const next = (): number => id++
  return {
    async folders(): Promise<WorkspaceGetResult> {
      const n = next()
      await host.handle({ id: n, method: 'workspace.get', params: {} })
      return replyTo(t, n).result as WorkspaceGetResult
    },
    async set(folders: Spec[]): Promise<Reply> {
      const n = next()
      await host.handle({ id: n, method: 'workspace.set', params: { name: 'ws', folders } })
      return replyTo(t, n)
    },
  }
}

const stored = (primary: string): number => (loadMounts(primary).file?.folders ?? []).length

test('a list built before the folders had loaded is refused, and the file keeps every folder', async () => {
  const primary = dir('pc-ws-main-')
  const a = dir('pc-ws-a-')
  const b = dir('pc-ws-b-')
  const c = dir('pc-ws-c-')
  saveWorkspaceFile(primary, { version: 1, folders: [{ path: a, access: 'write' }, { path: b, name: 'lib', access: 'read' }] })
  const h = await hostFor(primary)
  expect((await h.folders()).folders).toHaveLength(3)

  // The stale add: the new folder alone. Refused, with the folders it would have dropped named.
  const refused = await h.set([{ path: c, access: 'write' }])
  expect(refused.error?.message).toMatch(/would drop/)
  expect(refused.error?.message).toContain('"lib"')
  expect(refused.error?.message).toMatch(/reload the Workspace tab/)
  expect(stored(primary)).toBe(2)

  // Dropping one while adding another is no manager action either.
  const repoint = await h.set([{ path: a, access: 'write' }, { path: c, access: 'write' }])
  expect(repoint.error?.message).toMatch(/would drop/)
  expect(stored(primary)).toBe(2)

  // The real add keeps both and gains the third; removing one afterwards is one action.
  expect((await h.set([{ path: a, access: 'write' }, { path: b, name: 'lib', access: 'read' }, { path: c, access: 'write' }])).error).toBeUndefined()
  expect(stored(primary)).toBe(3)
  expect((await h.set([{ path: a, access: 'write' }, { path: c, access: 'write' }])).error).toBeUndefined()
  expect(stored(primary)).toBe(2)
  // And a name or access change drops nothing.
  expect((await h.set([{ path: a, name: 'core', access: 'read' }, { path: c, access: 'write' }])).error).toBeUndefined()
  expect(loadMounts(primary).file?.folders[0]?.name).toBe('core')
})

test('a folder the definition names but cannot mount is listed as missing, and a save keeps it', async () => {
  const primary = dir('pc-ws-main-')
  const a = dir('pc-ws-a-')
  const ghost = join(primary, '..', `pc-ws-ghost-${Date.now()}`)
  saveWorkspaceFile(primary, { version: 1, folders: [{ path: a, access: 'write' }, { path: ghost, name: 'ghost', access: 'read' }] })
  const h = await hostFor(primary)

  const got = await h.folders()
  expect(got.folders.filter((f) => !f.primary)).toHaveLength(2)
  const missing = got.folders.find((f) => f.missing !== undefined)
  expect(missing?.name).toBe('ghost')
  expect(missing?.access).toBe('read')
  expect(missing?.missing).toMatch(/no longer at/)

  // The manager sends everything back, the missing one included: an add loses nothing.
  const b = dir('pc-ws-b-')
  const ok = await h.set([
    ...got.folders.filter((f) => !f.primary).map((f) => ({ path: f.root, name: f.name, access: f.access })),
    { path: b, access: 'write' },
  ])
  expect(ok.error).toBeUndefined()
  expect(stored(primary)).toBe(3)
  expect(loadMounts(primary).file?.folders.some((f) => f.name === 'ghost')).toBe(true)

  // And the stale shape is still refused, the unmounted folder named among the dropped.
  const refused = await h.set([{ path: b, access: 'write' }])
  expect(refused.error?.message).toContain('"ghost"')
  expect(stored(primary)).toBe(3)
})
