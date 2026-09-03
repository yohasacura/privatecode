import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { SessionHost } from '../../src/host/host.js'
import { isHostEvent, type HostEvent, type HostOutbound, type HostReply, type SendResult } from '../../src/host/protocol.js'

/**
 * The one file the model may write but never silently, against the live model: asked in
 * autopilot to add an MCP server to `.privatecode/settings.json`, the write is put to the
 * user first (an approval request naming the file), and lands only once it is approved.
 *
 * Run with `PRIVATECODE_INTEGRATION=1 npx vitest run --config vitest.integration.config.ts
 * test/integration/settings-ask-live.test.ts`. One llama slot: never alongside another.
 */

const SERVER = process.env.PRIVATECODE_SERVER ?? 'http://127.0.0.1:8080'
const enabled = process.env.PRIVATECODE_INTEGRATION === '1'

interface Transport { messages: HostOutbound[]; send(msg: HostOutbound): void }
function resultOf<T>(transport: Transport, id: number): T {
  const found = transport.messages.find((m): m is HostReply => !isHostEvent(m) && m.id === id)
  if (!found) throw new Error(`no reply to request ${id}`)
  if ('error' in found) throw new Error(`request ${id} failed: ${found.error.message}`)
  return found.result as T
}

let tmp: string
let savedAppData: string | undefined
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pc-settings-ask-live-'))
  savedAppData = process.env['APPDATA']
  process.env['APPDATA'] = join(tmp, 'appdata')
})
afterAll(() => {
  if (savedAppData === undefined) delete process.env['APPDATA']; else process.env['APPDATA'] = savedAppData
})

describe.skipIf(!enabled)('a settings write by the model, against the live model', () => {
  test('in autopilot, adding an MCP server to settings.json is asked first and lands once approved', async () => {
    const workspace = join(tmp, 'ws')
    mkdirSync(join(workspace, '.privatecode'), { recursive: true })
    writeFileSync(join(workspace, 'README.md'), '# demo\n')
    writeFileSync(join(workspace, '.privatecode', 'settings.json'), '{\n  "permissions": { "allow": [], "ask": [], "deny": [] }\n}\n')

    const transport: Transport = { messages: [], send(msg) { this.messages.push(msg) } }
    const host = new SessionHost({ transport, prewarm: false })
    let id = 0
    const call = async <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
      // Captured here: the polling loop below bumps `id` for approval and question replies while
      // a `send` is still in flight, and reading the shared counter after the await picked up
      // the LAST reply (a bare `{}` from approval.reply) instead of the turn.
      const reqId = ++id
      await host.handle({ id: reqId, method, params })
      return resultOf<T>(transport, reqId)
    }
    const started = Date.now()
    const log = (line: string): void => { process.stdout.write(`[settings-ask-live +${((Date.now() - started) / 1000).toFixed(0)}s] ${line}\n`) }

    await call('init', { workspaceRoot: workspace, serverUrl: SERVER })
    await call('setMode', { mode: 'autopilot' })

    const asked: Array<{ tool: string | undefined; summary: string | undefined }> = []
    const answered = new Set<string>()
    const seen = new Set<number>()
    const sendPromise = call<SendResult>('send', {
      text: 'Добавь в .privatecode/settings.json (не создавай другой файл) MCP-сервер "docs": ' +
            '{"command": "node", "args": ["docs-server.js"]} в объект "mcpServers". Остальное содержимое файла сохрани. Ничего больше не делай.',
    })
    let settled = false
    void sendPromise.finally(() => { settled = true })
    while (!settled) {
      await new Promise((r) => setTimeout(r, 200))
      const events = transport.messages.filter(isHostEvent) as HostEvent[]
      events.forEach((e, i) => {
        if (seen.has(i)) return
        seen.add(i)
        const d = e.data as { name?: string; ok?: boolean; content?: string; args?: string }
        if (e.event === 'tool.call') log(`→ ${d.name ?? '?'} ${String(d.args ?? '').slice(0, 120)}`)
        if (e.event === 'tool.result') log(`← ${d.name ?? '?'} ${d.ok === false ? 'FAILED' : 'ok'}: ${String(d.content ?? '').replace(/\s+/g, ' ').slice(0, 160)}`)
      })
      for (const e of events) {
        const data = e.data as { requestId?: string; tool?: string; summary?: string; reason?: string }
        if (data.requestId === undefined || answered.has(data.requestId)) continue
        if (e.event === 'approval.request') {
          answered.add(data.requestId)
          asked.push({ tool: data.tool, summary: data.summary })
          log(`ASKED ${data.tool ?? ''}: ${data.summary ?? ''} — ${JSON.stringify(data).slice(0, 200)}`)
          await host.handle({ id: ++id, method: 'approval.reply', params: { requestId: data.requestId, decision: { verdict: 'allow' } } })
        } else if (e.event === 'question.request') {
          answered.add(data.requestId)
          await host.handle({ id: ++id, method: 'question.reply', params: { requestId: data.requestId, answer: 'yes' } })
        }
      }
    }
    const result = await sendPromise
    log(`send reply: ${JSON.stringify(result).slice(0, 400)}`)
    const turn = (result as { turn?: SendResult['turn'] }).turn
    if (turn !== undefined) log(`turn: ${turn.stoppedBecause} after ${turn.steps} steps — ${turn.finalText.replace(/\s+/g, ' ').slice(0, 240)}`)

    // Asked, in autopilot, for the settings file — and for nothing else the model did.
    const settingsAsks = asked.filter((a) => /settings\.json/.test(`${a.summary ?? ''}`) || /Edit|Write/.test(`${a.tool ?? ''}`))
    log(`approval requests: ${asked.length}, for settings: ${settingsAsks.length}`)
    expect(settingsAsks.length).toBeGreaterThanOrEqual(1)

    const path = join(workspace, '.privatecode', 'settings.json')
    expect(existsSync(path)).toBe(true)
    const doc = JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: Record<string, { command?: string }>; permissions?: unknown }
    log(`settings.json mcpServers: ${JSON.stringify(doc.mcpServers)}`)
    expect(doc.mcpServers?.['docs']?.command).toBe('node')
    expect(doc.permissions).toBeDefined()
    await host.shutdown()
  }, 600_000)
})
