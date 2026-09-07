import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { SessionHost } from '../../src/host/host.js'
import { isHostEvent, type HostEvent, type HostOutbound, type HostReply, type SendResult } from '../../src/host/protocol.js'

/**
 * The renamed tools, against the live model: asked to look at the folder and to run
 * something in the background and read what it printed, the model reaches for `LS`,
 * `Bash` with `run_in_background` and `TaskOutput` under their new names — the schemas it
 * is shown are the only place it could learn them from.
 *
 * Run with `PRIVATECODE_INTEGRATION=1 npx vitest run --config vitest.integration.config.ts
 * test/integration/tool-names-live.test.ts`. One llama slot: never alongside another.
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
  tmp = mkdtempSync(join(tmpdir(), 'pc-tool-names-live-'))
  savedAppData = process.env['APPDATA']
  process.env['APPDATA'] = join(tmp, 'appdata')
})
afterAll(() => {
  if (savedAppData === undefined) delete process.env['APPDATA']; else process.env['APPDATA'] = savedAppData
})

describe.skipIf(!enabled)('the renamed tools, against the live model', () => {
  test('LS, Bash in the background and TaskOutput are called by their new names', async () => {
    const workspace = join(tmp, 'ws')
    mkdirSync(join(workspace, 'src'), { recursive: true })
    writeFileSync(join(workspace, 'README.md'), '# demo\n')
    writeFileSync(join(workspace, 'src', 'app.js'), 'console.log("hi")\n')

    const transport: Transport = { messages: [], send(msg) { this.messages.push(msg) } }
    const host = new SessionHost({ transport, prewarm: false })
    let id = 0
    const call = async <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
      const reqId = ++id
      await host.handle({ id: reqId, method, params })
      return resultOf<T>(transport, reqId)
    }
    const started = Date.now()
    const log = (line: string): void => { process.stdout.write(`[tool-names-live +${((Date.now() - started) / 1000).toFixed(0)}s] ${line}\n`) }

    await call('init', { workspaceRoot: workspace, serverUrl: SERVER })
    await call('setMode', { mode: 'autopilot' })

    const seen = new Set<number>()
    const answered = new Set<string>()
    const sendPromise = call<SendResult>('send', {
      text: 'Two small things, using the tools: (1) list the top-level entries of this workspace ' +
            'with the directory-listing tool; (2) start `sleep 1; echo BACKGROUND-DONE` as a background ' +
            'task and then read its output until you see BACKGROUND-DONE. Then reply with one line ' +
            'naming the entries you saw and the word the task printed. Do not edit anything.',
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
        if (e.event === 'tool.call') log(`→ ${d.name ?? '?'} ${String(d.args ?? '').slice(0, 100)}`)
        if (e.event === 'tool.result') log(`← ${d.name ?? '?'} ${d.ok === false ? 'FAILED' : 'ok'}: ${String(d.content ?? '').replace(/\s+/g, ' ').slice(0, 120)}`)
      })
      for (const e of events) {
        const data = e.data as { requestId?: string }
        if (data.requestId === undefined || answered.has(data.requestId)) continue
        if (e.event === 'approval.request') {
          answered.add(data.requestId)
          await host.handle({ id: ++id, method: 'approval.reply', params: { requestId: data.requestId, decision: { verdict: 'allow' } } })
        } else if (e.event === 'question.request') {
          answered.add(data.requestId)
          await host.handle({ id: ++id, method: 'question.reply', params: { requestId: data.requestId, answer: 'yes' } })
        }
      }
    }
    const result = await sendPromise
    log(`turn: ${result.turn.stoppedBecause} after ${result.turn.steps} steps — ${result.turn.finalText.replace(/\s+/g, ' ').slice(0, 200)}`)

    const calls = (transport.messages.filter(isHostEvent) as HostEvent[])
      .filter((e) => e.event === 'tool.call')
      .map((e) => (e.data as { name?: string }).name ?? '')
    log(`tools called: ${calls.join(', ')}`)
    expect(calls).toContain('LS')
    expect(calls).toContain('Bash')
    expect(calls).toContain('TaskOutput')
    // Nothing was called by a name that no longer exists.
    expect(calls.some((c) => /^[a-z]/.test(c))).toBe(false)
    expect(result.turn.finalText).toMatch(/BACKGROUND-DONE/)
    await host.shutdown()
  }, 600_000)
})
