import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { SessionHost } from '../src/host/host.js'
import { isHostEvent, type HostEvent, type HostOutbound, type HostReply } from '../src/host/protocol.js'
import { RawResponse, startFakeServer } from './fake-server.js'

/**
 * The long-run surfaces as the window sees them: checkpoints, the parked queue, the work
 * log, and starting a run.
 *
 * The property most of these defend is that the app cannot be shown something that did not
 * happen — an undo point that does not exist, a decision that was answered twice, a rewind
 * while a turn is mid-edit.
 */

let stop: (() => Promise<void>) | undefined
let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-host-lr-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')
})

afterEach(async () => {
  await stop?.()
  stop = undefined
  rmSync(root, { recursive: true, force: true })
})

interface Captured { messages: HostOutbound[]; send(m: HostOutbound): void }
const makeTransport = (): Captured => {
  const messages: HostOutbound[] = []
  return { messages, send: (m) => { messages.push(m) } }
}

const replyOf = (t: Captured, id: number): any => {
  const found = t.messages.find((m): m is HostReply => !isHostEvent(m) && m.id === id)
  if (found && 'error' in found) throw new Error(`request ${id} failed: ${found.error.message}`)
  return found?.result
}
const errorOf = (t: Captured, id: number): string | undefined => {
  const found = t.messages.find((m): m is HostReply => !isHostEvent(m) && m.id === id)
  return found && 'error' in found ? found.error.message : undefined
}
const eventsNamed = (t: Captured, name: string): HostEvent[] =>
  t.messages.filter(isHostEvent).filter((e) => e.event === name)

const sseFrame = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`

/**
 * A `chatStream`-shaped answer that ends the turn with plain text.
 *
 * SSE and not a plain JSON body: a host-driven turn ALWAYS streams, because `SessionHost`
 * wires the delta callbacks unconditionally. The first version of this file returned an
 * ordinary completion object, so every turn failed at the transport — which surfaced as an
 * empty work log and a run that ended `server-unreachable`, two symptoms of one wrong
 * fixture.
 */
function textSSE(text: string): RawResponse {
  return new RawResponse(200,
    sseFrame({ choices: [{ delta: { content: text } }] }) +
    sseFrame({ choices: [{ finish_reason: 'stop', delta: {} }], timings: {} }) +
    sseFrame({ choices: [], usage: { completion_tokens: 5, prompt_tokens: 60 } }) +
    'data: [DONE]\n\n',
    'text/event-stream')
}

async function newHost(finalText = 'ok') {
  const fake = await startFakeServer((body, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: 8000 } }
    if (req.url === '/health') return { status: 'ok' }
    if (body.stream === true) return textSSE(finalText)
    return { choices: [{ message: { role: 'assistant', content: finalText }, finish_reason: 'stop' }] }
  })
  stop = fake.close
  const transport = makeTransport()
  const host = new SessionHost({ transport })
  await host.handle({ id: 1, method: 'init', params: { workspaceRoot: root, serverUrl: fake.url } })
  return { host, transport }
}

test('a turn leaves a checkpoint the app can list', async () => {
  const { host, transport } = await newHost()
  try {
    await host.handle({ id: 2, method: 'send', params: { text: 'look at it' } })
    await host.handle({ id: 3, method: 'checkpoints.list', params: {} })
    const { checkpoints } = replyOf(transport, 3)
    // The baseline, at least: taken before the first turn so "before it touched anything"
    // is always reachable.
    expect(checkpoints.length).toBeGreaterThanOrEqual(1)
    expect(checkpoints[0].id).toMatch(/^[0-9a-f]{7,}$/)
  } finally {
    await host.shutdown()
  }
})

test('a rewind restores files and hands back the point that undoes it', async () => {
  const { host, transport } = await newHost()
  try {
    await host.handle({ id: 2, method: 'send', params: { text: 'first' } })
    await host.handle({ id: 3, method: 'checkpoints.list', params: {} })
    const baseline = replyOf(transport, 3).checkpoints.at(-1)

    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 999\n', 'utf8')
    writeFileSync(join(root, 'src', 'added.ts'), 'export const b = 2\n', 'utf8')
    await host.handle({ id: 4, method: 'send', params: { text: 'second' } })

    await host.handle({ id: 5, method: 'checkpoints.rewind', params: { id: baseline.id } })
    const { restored, undo } = replyOf(transport, 5)
    expect(restored.id).toBe(baseline.id)
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1\n')

    // The reverse is offered immediately: rewinding to the wrong point is the failure this
    // whole feature exists to survive.
    await host.handle({ id: 6, method: 'checkpoints.rewind', params: { id: undo.id } })
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toBe('export const a = 999\n')
  } finally {
    await host.shutdown()
  }
})

test('a rewind names a checkpoint that does not exist rather than half-applying it', async () => {
  const { host, transport } = await newHost()
  try {
    await host.handle({ id: 2, method: 'send', params: { text: 'go' } })
    await host.handle({ id: 3, method: 'checkpoints.rewind', params: { id: 'deadbee' } })
    expect(errorOf(transport, 3)).toMatch(/no checkpoint "deadbee"/)
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1\n')
  } finally {
    await host.shutdown()
  }
})

test('the work log reads back, and an empty one is not an error', async () => {
  const { host, transport } = await newHost()
  try {
    await host.handle({ id: 2, method: 'worklog.read', params: {} })
    // A workspace that has never run is the normal case, not something to put in front of
    // someone as a failure.
    expect(replyOf(transport, 2)).toMatchObject({ text: '', path: '.privatecode/worklog.md' })

    await host.handle({ id: 3, method: 'send', params: { text: 'do a thing' } })
    await host.handle({ id: 4, method: 'worklog.read', params: {} })
    expect(replyOf(transport, 4).text).toContain('**Asked:** do a thing')
  } finally {
    await host.shutdown()
  }
})

test('an unattended run streams its turns and ends with a named reason', async () => {
  const { host, transport } = await newHost('All done.')
  try {
    await host.handle({ id: 2, method: 'run.start', params: { task: 'tidy up', maxTurns: 3 } })
    for (let i = 0; i < 200 && eventsNamed(transport, 'run.ended').length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    const turns = eventsNamed(transport, 'run.turn')
    expect(turns.length).toBeGreaterThanOrEqual(1)
    expect((turns[0]?.data as { text: string }).text).toBe('tidy up')

    const ended = eventsNamed(transport, 'run.ended')[0]!.data as { stoppedBecause: string; detail: string }
    expect(ended.stoppedBecause).toBe('done')
    expect(ended.detail.length).toBeGreaterThan(10)
  } finally {
    await host.shutdown()
  }
})

test('a manual send during a run is refused by the same single-slot guard', async () => {
  const { host, transport } = await newHost('still working')
  try {
    await host.handle({ id: 2, method: 'run.start', params: { task: 'long thing', maxTurns: 50 } })
    await host.handle({ id: 3, method: 'send', params: { text: 'me too' } })
    expect(errorOf(transport, 3)).toMatch(/already running/)
    await host.handle({ id: 4, method: 'run.stop', params: {} })
  } finally {
    await host.shutdown()
  }
})

test('with nothing parked the queue is empty rather than absent', async () => {
  const { host, transport } = await newHost()
  try {
    await host.handle({ id: 2, method: 'decisions.list', params: {} })
    expect(replyOf(transport, 2)).toEqual({ decisions: [] })
  } finally {
    await host.shutdown()
  }
})

test('answering a parked decision remembers the rule and clears it exactly once', async () => {
  const { host, transport } = await newHost()
  try {
    // Park one by hand: producing a real deferral needs an approval nobody answers, which
    // is a two-minute wait by design.
    const session = (host as unknown as { session: { decisionQueue(): any } }).session
    const queue = session.decisionQueue()
    queue.add({
      kind: 'approval', id: 'd1', at: new Date().toISOString(), sessionId: 's',
      tool: 'run_command', summary: 'npx tsc --noEmit', detail: 'detail',
      suggestedRules: ['run_command(npx tsc:*)'],
    })

    await host.handle({ id: 2, method: 'decisions.list', params: {} })
    expect(replyOf(transport, 2).decisions).toHaveLength(1)

    await host.handle({
      id: 3,
      method: 'decisions.resolve',
      params: { id: 'd1', verdict: 'allow', rule: { rule: 'run_command(npx tsc:*)', layer: 'session' } },
    })
    await host.handle({ id: 4, method: 'decisions.list', params: {} })
    expect(replyOf(transport, 4).decisions).toEqual([])

    // The rule is live in the engine, which is the entire value of the queue: a night's
    // questions become permission rules rather than one-off yesses.
    const engine = (host as unknown as { engine: { decide(k: unknown): { verdict: string } } }).engine
    expect(engine.decide({ tool: 'run_command', command: 'npx tsc --noEmit' }).verdict).toBe('allow')
    expect(eventsNamed(transport, 'decisions.changed').length).toBeGreaterThanOrEqual(1)
  } finally {
    await host.shutdown()
  }
})
