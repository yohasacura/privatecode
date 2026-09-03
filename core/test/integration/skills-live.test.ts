import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { SessionHost } from '../../src/host/host.js'
import { isHostEvent, type HostEvent, type HostOutbound, type HostReply, type SendResult } from '../../src/host/protocol.js'

/**
 * The owner's ruling, against the real model: asked to make a skill, the model writes it
 * into `.privatecode/skills/` itself — the folder that was walled off until 0.4.5. What is
 * checked is the file on disk, the tools it took, and that nothing was refused.
 *
 * Run with `PRIVATECODE_INTEGRATION=1 npx vitest run --config vitest.integration.config.ts
 * test/integration/skills-live.test.ts`. One llama slot: never alongside another live test.
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
  tmp = mkdtempSync(join(tmpdir(), 'pc-skills-live-'))
  savedAppData = process.env['APPDATA']
  process.env['APPDATA'] = join(tmp, 'appdata')
})
afterAll(() => {
  if (savedAppData === undefined) delete process.env['APPDATA']; else process.env['APPDATA'] = savedAppData
})

describe.skipIf(!enabled)('a skill written by the model, against the live model', () => {
  test('asked for a project skill, the model writes SKILL.md under .privatecode/skills and is not refused', async () => {
    const workspace = join(tmp, 'ws')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'README.md'), '# demo\n\nA small project.\n')

    const transport: Transport = { messages: [], send(msg) { this.messages.push(msg) } }
    const host = new SessionHost({ transport, prewarm: false })
    let id = 0
    const call = async <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
      id++
      await host.handle({ id, method, params })
      return resultOf<T>(transport, id)
    }
    const started = Date.now()
    const log = (line: string): void => { process.stdout.write(`[skills-live +${((Date.now() - started) / 1000).toFixed(0)}s] ${line}\n`) }
    log(`workspace ${workspace}`)

    await call('init', { workspaceRoot: workspace, serverUrl: SERVER })
    await call('setMode', { mode: 'autopilot' })

    const answered = new Set<string>()
    const seen = new Set<number>()
    const sendPromise = call<SendResult>('send', {
      text: 'Создай в этом проекте скилл commit-style: папка .privatecode/skills/commit-style с файлом SKILL.md. ' +
            'В нём — frontmatter с name и description, и короткие правила оформления сообщений коммитов на русском ' +
            '(заголовок до 60 символов, тело объясняет почему). Ничего больше не делай.',
    })
    let settled = false
    void sendPromise.finally(() => { settled = true })
    while (!settled) {
      await new Promise((r) => setTimeout(r, 200))
      const events = transport.messages.filter(isHostEvent) as HostEvent[]
      events.forEach((e, i) => {
        if (seen.has(i)) return
        seen.add(i)
        const d = e.data as { name?: string; ok?: boolean; content?: string; args?: unknown }
        if (e.event === 'tool.call') log(`→ ${d.name ?? '?'} ${JSON.stringify(d.args ?? {}).slice(0, 160)}`)
        if (e.event === 'tool.result') log(`← ${d.name ?? '?'} ${d.ok === false ? 'FAILED' : 'ok'}: ${String(d.content ?? '').replace(/\s+/g, ' ').slice(0, 200)}`)
      })
      for (const e of events) {
        const data = e.data as { requestId?: string; tool?: string; summary?: string; question?: string }
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
    const failures = events.filter((e) => e.event === 'tool.result' && (e.data as { ok?: boolean }).ok === false)
    for (const f of failures) log(`failed: ${String((f.data as { content?: string }).content ?? '').slice(0, 200)}`)

    const path = join(workspace, '.privatecode', 'skills', 'commit-style', 'SKILL.md')
    log(`skill on disk: ${existsSync(path)}`)
    expect(existsSync(path)).toBe(true)
    const text = readFileSync(path, 'utf8')
    expect(text).toMatch(/^---\s*\n/)
    expect(text).toMatch(/description:/)
    expect(failures.filter((f) => /Blocked by built-in protection|access denied/.test(String((f.data as { content?: string }).content)))).toHaveLength(0)
    await host.shutdown()
  }, 600_000)
})
