import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { SessionHost } from '../src/host/host.js'
import { isHostEvent, type HostEvent, type HostOutbound, type HostReply } from '../src/host/protocol.js'
import { PRIVATE_DIR } from '../src/private-dir.js'
import { LlamaClient } from '../src/llama/client.js'
import { Session } from '../src/session/session.js'
import { SessionStore } from '../src/session/store.js'
import { createToolset } from '../src/tools/default-set.js'
import { RawResponse, startFakeServer } from './fake-server.js'

/**
 * What the rest of the system sees when ONE step runs several tool calls.
 *
 * The loop used to run `calls[0]` and refuse the rest, so every consumer downstream of
 * `onToolCall`/`onToolResult` had only ever observed one real call per step. Running them all
 * (6f116d0) hands each of those consumers a case it had never been given, and the two audits
 * before it both found their worst defects in exactly that shape: not in the code that
 * changed, in the code that silently gained a state.
 *
 * `loop.test.ts` covers the loop's own contract — order, halt-on-failure, the interleaved
 * events. This file is the consumers, driven through the host because that is the path the
 * window and the work log actually take:
 *
 * - `Session.captureToolResult` -> the work log's "Ran" lines, one per command, each with
 *   its OWN arguments. It reads them back out of `lastToolArgs`, a single slot per tool NAME.
 * - `Session.notePathWritten` -> `writtenMounts` -> which folders `verify` runs in. Same
 *   single slot, and the answer is a command that either ran in a folder or did not.
 * - `Session`'s own `recordToolOutcome` -> one line per call id in the `.ui.jsonl` beside the
 *   session, which is where a restored conversation's tick marks come from. Driven both
 *   through the host and, in one test, the way `cli.ts` drives it: a Session and no host.
 */

let stop: (() => Promise<void>) | undefined
const dirs: string[] = []

beforeEach(() => { /* each test makes its own workspace */ })
afterEach(async () => {
  await stop?.()
  stop = undefined
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function newWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pc-multi-'))
  dirs.push(dir)
  mkdirSync(join(dir, PRIVATE_DIR), { recursive: true })
  return dir
}

interface Captured { messages: HostOutbound[]; send(m: HostOutbound): void }
const makeTransport = (): Captured => {
  const messages: HostOutbound[] = []
  return { messages, send: (m) => { messages.push(m) } }
}
const eventsNamed = (t: Captured, name: string): HostEvent[] =>
  t.messages.filter((m): m is HostEvent => isHostEvent(m) && m.event === name)
const replyOf = (t: Captured, id: number): any => {
  const found = t.messages.find((m): m is HostReply => !isHostEvent(m) && m.id === id)
  if (found && 'error' in found) throw new Error(`request ${id} failed: ${found.error.message}`)
  return found?.result
}

const sseFrame = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const SSE_DONE = 'data: [DONE]\n\n'

/**
 * A streaming step that proposes SEVERAL tool calls, shaped exactly as llama.cpp emits them:
 * the calls interleave in one stream and are told apart only by `index`.
 */
function multiCallSSE(calls: { id: string; name: string; args: string }[]): RawResponse {
  let body = sseFrame({ choices: [{ delta: { reasoning_content: 'all of these, then' } }] })
  calls.forEach((c, index) => {
    body += sseFrame({
      choices: [{ delta: { tool_calls: [{ index, id: c.id, type: 'function', function: { name: c.name, arguments: '' } }] } }],
    })
  })
  calls.forEach((c, index) => {
    body += sseFrame({
      choices: [{ delta: { tool_calls: [{ index, function: { arguments: c.args } }] } }],
    })
  })
  body += sseFrame({ choices: [{ finish_reason: 'tool_calls', delta: {} }], timings: {} })
  body += sseFrame({ choices: [], usage: { completion_tokens: 40, prompt_tokens: 100 } })
  return new RawResponse(200, body + SSE_DONE, 'text/event-stream')
}

function textSSE(text: string): RawResponse {
  const body =
    sseFrame({ choices: [{ delta: { content: text } }] }) +
    sseFrame({ choices: [{ finish_reason: 'stop', delta: {} }], timings: {} }) +
    sseFrame({ choices: [], usage: { completion_tokens: 5, prompt_tokens: 60 } }) +
    SSE_DONE
  return new RawResponse(200, body, 'text/event-stream')
}

async function hostOver(
  root: string, steps: (call: number) => RawResponse | undefined,
): Promise<{ host: SessionHost; transport: Captured }> {
  let call = 0
  const fake = await startFakeServer((body, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: 8000 } }
    if (req.url === '/health') return { status: 'ok' }
    if (body.stream !== true) {
      return { choices: [{ message: { role: 'assistant', content: 'summary' }, finish_reason: 'stop' }] }
    }
    call++
    return steps(call) ?? textSSE('done')
  })
  stop = fake.close
  const transport = makeTransport()
  const host = new SessionHost({ transport })
  await host.handle({ id: 1, method: 'init', params: { workspaceRoot: root, serverUrl: fake.url } })
  // Autopilot, not a permission rule: command rules match exactly or by `prefix:*`, never
  // by `**`, and a rule that cannot match leaves the gate waiting for an approval no test
  // is going to send. What is under test here is what the consumers see, not the gate.
  await host.handle({ id: 99, method: 'setMode', params: { mode: 'autopilot' } })
  return { host, transport }
}

test('two commands in one step are both recorded in the work log, each with its own text', async () => {
  // `Session.lastToolArgs` holds ONE slot per tool name, because `onToolResult` carries the
  // result and not the arguments. Two `Bash` calls in a step is the case that slot was
  // never given: if the second call were announced before the first one's result — which is
  // what any concurrent version of the loop would do — both lines of the night's log would
  // read as the SECOND command, and the first would be invisible while having really run.
  //
  // The log is what a person reads in the morning to find out what happened. A line naming
  // the wrong command is worse than a missing one.
  const root = newWorkspace()
  const { host, transport } = await hostOver(root, (call) =>
    call === 1
      ? multiCallSSE([
        { id: 'k1', name: 'Bash', args: JSON.stringify({ command: 'Write-Output first' }) },
        { id: 'k2', name: 'Bash', args: JSON.stringify({ command: 'Write-Output second' }) },
      ])
      : undefined)
  try {
    await host.handle({ id: 2, method: 'send', params: { text: 'run both' } })
    await host.handle({ id: 3, method: 'worklog.read', params: {} })
    const text: string = replyOf(transport, 3).text

    expect(text).toContain('Write-Output first')
    expect(text).toContain('Write-Output second')
    // And neither is written twice, which is what a shared slot produces: the same command
    // under two "Ran" lines reads as a command that ran twice.
    expect(text.split('Write-Output second').length - 1).toBe(1)
  } finally {
    await host.shutdown()
  }
}, 30_000)

test('one step writing into two folders verifies both of them', async () => {
  // `writtenMounts` decides where `verify` runs, and it is filled from the same single slot:
  // `notePathWritten(this.lastToolArgs.get(name))`, once per successful write. Two writes to
  // two folders in ONE step means the slot is read twice for the name `Write`, and a
  // wrong answer here is silent — the folder that was skipped simply never reports, and a
  // broken build in it is found by a person hours later.
  const root = newWorkspace()
  const engine = join(root, '..', `${basename(root)}-engine`)
  mkdirSync(engine, { recursive: true })
  dirs.push(engine)
  writeFileSync(
    join(root, PRIVATE_DIR, 'workspace.json'),
    JSON.stringify({
      version: 1,
      folders: [{ path: engine, name: 'engine', access: 'write' }],
      profile: {
        verify: {
          [basename(root)]: 'Write-Output ran >> primary-verified.log',
          engine: 'Write-Output ran >> engine-verified.log',
        },
      },
    }),
    'utf8',
  )

  const primary = basename(root)
  const { host, transport } = await hostOver(root, (call) =>
    call === 1
      ? multiCallSSE([
        { id: 'w1', name: 'Write', args: JSON.stringify({ path: `${primary}/here.txt`, content: 'x' }) },
        { id: 'w2', name: 'Write', args: JSON.stringify({ path: 'engine/there.txt', content: 'y' }) },
      ])
      : undefined)
  try {
    await host.handle({ id: 2, method: 'send', params: { text: 'write into both folders' } })

    // Both files landed...
    expect(existsSync(join(root, 'here.txt'))).toBe(true)
    expect(existsSync(join(engine, 'there.txt'))).toBe(true)
    // ...and both folders were checked afterwards, not just whichever write was last.
    expect(existsSync(join(root, 'primary-verified.log'))).toBe(true)
    expect(existsSync(join(engine, 'engine-verified.log'))).toBe(true)
    const folders = eventsNamed(transport, 'verify').map((e) => (e.data as { folder?: string }).folder)
    expect([...folders].sort()).toEqual(['engine', primary].sort())
  } finally {
    await host.shutdown()
  }
}, 40_000)

test('a session driven without the host records its outcomes too', async () => {
  // `cli.ts` builds a `Session` directly and hands it `renderer.events`, which print lines and
  // nothing else. Recording lived in `SessionHost`, so an overnight `--unattended` run
  // persisted its transcript, appeared in the app's session list, and restored with a green
  // tick on every failed command of the night — with nothing on disk, `assumedOk` guesses from
  // the result text, and "exit code 1" does not start with `Not run:`.
  //
  // Driven the way the CLI drives it: a Session, a store, no host anywhere.
  const root = newWorkspace()
  let call = 0
  const fake = await startFakeServer((_b, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: 8000 } }
    if (req.url === '/health') return { status: 'ok' }
    call++
    if (call === 1) {
      return {
        choices: [{
          message: {
            role: 'assistant', content: null,
            tool_calls: [{
              id: 'z1', type: 'function',
              function: { name: 'Read', arguments: JSON.stringify({ path: 'nope.txt' }) },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      }
    }
    return {
      choices: [{ message: { role: 'assistant', content: 'could not read it' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 5 },
    }
  })
  stop = fake.close

  const store = new SessionStore(root)
  const session = new Session({
    client: new LlamaClient({ baseUrl: fake.url, model: 'm' }),
    toolset: createToolset({}),
    workspaceRoot: root,
    mode: 'autopilot',
    store,
  })
  await session.send('read a file that is not there')

  const raw = readFileSync(join(root, PRIVATE_DIR, 'state', 'sessions', `${session.id}.ui.jsonl`), 'utf8')
  const lines = raw.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))
  expect(lines).toContainEqual({ id: 'z1', ok: false })
}, 30_000)

test('every call of a step gets its own recorded outcome, under its own id', async () => {
  // The `.ui.jsonl` beside the session is the ONLY record of whether each call worked —
  // `ToolResult.ok` never reaches the transcript, because the model is given the result text
  // and nothing else. It is keyed by the model's own call id, so a step whose calls shared a
  // line, or reported one id twice, would restore with the wrong ticks: a write that failed
  // shown as green, in a conversation someone is reading to find out what went wrong.
  const root = newWorkspace()
  const { host, transport } = await hostOver(root, (call) =>
    call === 1
      ? multiCallSSE([
        { id: 'o1', name: 'Write', args: JSON.stringify({ path: 'ok.txt', content: 'x' }) },
        // Fails: no such file. Which also halts the step, so the third never runs.
        { id: 'o2', name: 'Read', args: JSON.stringify({ path: 'missing.txt' }) },
        { id: 'o3', name: 'Write', args: JSON.stringify({ path: 'never.txt', content: 'z' }) },
      ])
      : undefined)
  try {
    await host.handle({ id: 2, method: 'send', params: { text: 'go' } })
    const sessionId = replyOf(transport, 1).sessionId as string

    const raw = readFileSync(join(root, PRIVATE_DIR, 'state', 'sessions', `${sessionId}.ui.jsonl`), 'utf8')
    const outcomes = new Map<string, boolean>(
      raw.split('\n').filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as { id: string; ok: boolean })
        .map((o) => [o.id, o.ok]),
    )
    expect(outcomes.get('o1')).toBe(true)
    expect(outcomes.get('o2')).toBe(false)
    // The one that never ran is recorded as failed too, which is what it was: nothing
    // happened. Leaving it out entirely would restore it as a success, because an unknown
    // outcome reads as one.
    expect(outcomes.get('o3')).toBe(false)
    expect(existsSync(join(root, 'never.txt'))).toBe(false)
  } finally {
    await host.shutdown()
  }
}, 30_000)
