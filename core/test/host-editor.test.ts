import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { SessionHost } from '../src/host/host.js'
import {
  isHostEvent, type AgentsCreateResult, type AgentsListResult, type FsWriteResult, type HostOutbound, type HostReply,
  type SkillsCreateResult, type SkillsListResult,
} from '../src/host/protocol.js'
import { RawResponse, startFakeServer } from './fake-server.js'

/**
 * The window's editor for skills and agents, through the host: a skill or agent from a
 * template, the file written whole, the jail the model's writes have — and the user's own
 * folders under %APPDATA%, which lie outside every workspace. Parity with the console,
 * where these are edited with $EDITOR.
 */

interface Transport { messages: HostOutbound[]; send(msg: HostOutbound): void }
function resultOf<T>(transport: Transport, id: number): T {
  const found = transport.messages.find((m): m is HostReply => !isHostEvent(m) && m.id === id)
  if (!found) throw new Error(`no reply to request ${id}`)
  if ('error' in found) throw new Error(`request ${id} failed: ${found.error.message}`)
  return found.result as T
}

let tmp: string
let workspace: string
let savedAppData: string | undefined
let stop: (() => Promise<void>) | undefined
let serverUrl = ''

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'pc-host-editor-'))
  savedAppData = process.env['APPDATA']
  process.env['APPDATA'] = join(tmp, 'appdata')
  workspace = join(tmp, 'ws')
  mkdirSync(workspace, { recursive: true })
  const fake = await startFakeServer((_body, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: 1000 } }
    if (req.url === '/health') return { status: 'ok' }
    return new RawResponse(501, '{}', 'application/json')
  })
  stop = fake.close
  serverUrl = fake.url
})
afterAll(async () => {
  await stop?.()
  if (savedAppData === undefined) delete process.env['APPDATA']; else process.env['APPDATA'] = savedAppData
  try { rmSync(tmp, { recursive: true, force: true }) } catch { /* a handle still open on Windows */ }
})

test('a skill and an agent from a template, listed, written whole, and jailed like the model', async () => {
  const transport: Transport = { messages: [], send(msg) { this.messages.push(msg) } }
  const host = new SessionHost({ transport, prewarm: false })
  await host.handle({ id: 1, method: 'init', params: { workspaceRoot: workspace, serverUrl } })
  let id = 1
  const call = async <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    id++
    await host.handle({ id, method, params })
    return resultOf<T>(transport, id)
  }

  // A project skill from the template, then a user one.
  const skill = await call<SkillsCreateResult>('skills.create', { name: 'deck-notes', scope: 'project', description: 'Turns a brief into speaker notes.' })
  expect(skill.path).toBe(join(workspace, '.privatecode', 'skills', 'deck-notes', 'SKILL.md'))
  const text = readFileSync(skill.path, 'utf8')
  expect(text).toContain('name: deck-notes')
  expect(text).toContain('description: Turns a brief into speaker notes.')
  const userSkill = await call<SkillsCreateResult>('skills.create', { name: 'everywhere', scope: 'user' })
  expect(userSkill.path).toBe(join(tmp, 'appdata', 'PrivateCode', 'skills', 'everywhere', 'SKILL.md'))
  await expect(call('skills.create', { name: 'deck-notes', scope: 'project' })).rejects.toThrow(/already exists/)
  await expect(call('skills.create', { name: 'Bad Name', scope: 'project' })).rejects.toThrow(/lowercase/)

  const listed = await call<SkillsListResult>('skills.list')
  expect(listed.skills.map((s) => `${s.scope}/${s.name}`)).toEqual(expect.arrayContaining(['project/deck-notes', 'user/everywhere']))

  // An agent, in the user folder, then listed with its path; a plugin-less workspace lists
  // only the two of ours.
  const agent = await call<AgentsCreateResult>('agents.create', { name: 'reviewer', scope: 'user', description: 'Reviews a diff for defects.' })
  expect(agent.path).toBe(join(tmp, 'appdata', 'PrivateCode', 'agents', 'reviewer.md'))
  const project = await call<AgentsCreateResult>('agents.create', { name: 'reviewer', scope: 'project', description: 'The project one wins.' })
  const agents = await call<AgentsListResult>('agents.list')
  expect(agents.agents.map((a) => `${a.scope}/${a.name}`)).toEqual(['project/reviewer'])
  expect(agents.agents[0]!.purpose).toBe('The project one wins.')
  expect(agents.agents[0]!.path).toBe(project.path)
  expect(agents.dirs.map((d) => d.scope)).toEqual(['project', 'user'])

  // Written whole: a workspace file under .privatecode, and the user folder's skill.
  const written = await call<FsWriteResult>('fs.write', { path: '.privatecode/skills/deck-notes/SKILL.md', text: '---\ndescription: edited\n---\nEdited.\n' })
  expect(written.bytes).toBe(Buffer.byteLength('---\ndescription: edited\n---\nEdited.\n'))
  expect(readFileSync(skill.path, 'utf8')).toContain('Edited.')
  await call<FsWriteResult>('fs.write', { path: join(tmp, 'appdata', 'PrivateCode', 'skills', 'everywhere', 'helper.ps1'), text: 'Write-Output hi\n' })
  expect(existsSync(join(tmp, 'appdata', 'PrivateCode', 'skills', 'everywhere', 'helper.ps1'))).toBe(true)

  // And refused where the model is refused: the tool's own state, and anything outside.
  await expect(call('fs.write', { path: '.privatecode/state/sessions/s1.jsonl', text: 'x' })).rejects.toThrow(/state/)
  await expect(call('fs.write', { path: join(tmp, 'elsewhere.txt'), text: 'x' })).rejects.toThrow()
  await expect(call('fs.write', { path: join(tmp, 'appdata', 'PrivateCode', 'settings.json'), text: '{}' })).rejects.toThrow(/skills\/ or agents\//)

  // The console's /memory: the AGENTS.md a session loads, as it is on disk now.
  writeFileSync(join(workspace, 'AGENTS.md'), '# House rules\n\nTests first.\n')
  const memory = await call<{ layers: { scope: string; path: string; bytes: number; truncated: boolean }[] }>('memory.list')
  expect(memory.layers.map((l) => l.path)).toContain(join(workspace, 'AGENTS.md'))
  expect(memory.layers.find((l) => l.path.endsWith('AGENTS.md'))?.truncated).toBe(false)

  // Opening with the OS is refused outside the allowed roots (and not exercised inside:
  // this test must not launch Explorer).
  writeFileSync(join(tmp, 'outside.txt'), 'x')
  await expect(call('fs.openExternal', { path: join(tmp, 'outside.txt') })).rejects.toThrow(/outside the workspace/)
  await host.shutdown()
})
