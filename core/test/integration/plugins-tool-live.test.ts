import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { SessionHost } from '../../src/host/host.js'
import {
  isHostEvent, type CommandsListResult, type HostEvent, type HostOutbound, type HostReply, type PluginsListResult,
  type SendResult,
} from '../../src/host/protocol.js'

/**
 * The `plugins` tool against the live model and the real network: asked in words to add
 * Anthropic's example marketplace and install commit-commands from it, the model runs the
 * two `/plugin …` lines itself, and the plugin is live in the workspace afterwards — the
 * same end state `plugins-live.test.ts` reaches through the host's own RPC.
 *
 * Run with `PRIVATECODE_INTEGRATION=1 npx vitest run --config vitest.integration.config.ts
 * test/integration/plugins-tool-live.test.ts`. One llama slot: never alongside another.
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
  tmp = mkdtempSync(join(tmpdir(), 'pc-plugins-tool-live-'))
  savedAppData = process.env['APPDATA']
  // The store lives under %APPDATA%: pointed at a temp folder so the machine's own plugins are untouched.
  process.env['APPDATA'] = join(tmp, 'appdata')
})
afterAll(() => {
  if (savedAppData === undefined) delete process.env['APPDATA']; else process.env['APPDATA'] = savedAppData
})

describe.skipIf(!enabled)('the plugins tool against the live model', () => {
  test('asked to add a marketplace and install a plugin, the model does it with the plugins tool', async () => {
    const workspace = join(tmp, 'ws')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'README.md'), '# scratch\n')

    const transport: Transport = { messages: [], send(msg) { this.messages.push(msg) } }
    const host = new SessionHost({ transport, prewarm: false })
    let id = 0
    const call = async <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
      id++
      await host.handle({ id, method, params })
      return resultOf<T>(transport, id)
    }
    const started = Date.now()
    const log = (line: string): void => { process.stdout.write(`[plugins-tool-live +${((Date.now() - started) / 1000).toFixed(0)}s] ${line}\n`) }

    await call('init', { workspaceRoot: workspace, serverUrl: SERVER })
    await call('setMode', { mode: 'autopilot' })

    const answered = new Set<string>()
    const seen = new Set<number>()
    const sendPromise = call<SendResult>('send', {
      text: 'Добавь маркетплейс плагинов anthropics/claude-code и установи из него плагин commit-commands. ' +
            'Используй инструмент plugins. Больше ничего не делай.',
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
        if (e.event === 'tool.call') log(`→ ${d.name ?? '?'} ${String(d.args ?? '').slice(0, 140)}`)
        if (e.event === 'tool.result') log(`← ${d.name ?? '?'} ${d.ok === false ? 'FAILED' : 'ok'}: ${String(d.content ?? '').replace(/\s+/g, ' ').slice(0, 200)}`)
      })
      for (const e of events) {
        const data = e.data as { requestId?: string; tool?: string; summary?: string }
        if (data.requestId === undefined || answered.has(data.requestId)) continue
        if (e.event === 'approval.request') {
          answered.add(data.requestId)
          log(`approve ${data.tool ?? ''}: ${data.summary ?? ''}`)
          await host.handle({ id: ++id, method: 'approval.reply', params: { requestId: data.requestId, decision: { verdict: 'allow' } } })
        } else if (e.event === 'question.request') {
          answered.add(data.requestId)
          await host.handle({ id: ++id, method: 'question.reply', params: { requestId: data.requestId, answer: 'yes' } })
        }
      }
    }
    const result = await sendPromise
    log(`turn: ${result.turn.stoppedBecause} after ${result.turn.steps} steps — ${result.turn.finalText.replace(/\s+/g, ' ').slice(0, 300)}`)
    const events = transport.messages.filter(isHostEvent) as HostEvent[]
    const pluginCalls = events.filter((e) => e.event === 'tool.call' && (e.data as { name?: string }).name === 'plugins')
    log(`plugins tool calls: ${pluginCalls.length}`)
    expect(pluginCalls.length).toBeGreaterThanOrEqual(1)

    const listed = await call<PluginsListResult>('plugins.list')
    log(`installed: ${listed.plugins.map((p) => `${p.id}:${p.enabled}`).join(', ') || '(none)'}`)
    expect(listed.plugins.map((p) => p.id)).toContain('commit-commands@claude-code-plugins')
    const commands = await call<CommandsListResult>('commands.list')
    expect(commands.commands.map((c) => c.name)).toContain('commit-commands:commit')
    await host.shutdown()
  }, 900_000)
})
