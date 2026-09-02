import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { LlamaClient } from '../src/llama/client.js'
import { Session, type StageInfo } from '../src/session/session.js'
import { SessionStore } from '../src/session/store.js'
import { ToolRegistry } from '../src/tools/registry.js'
import type { Toolset } from '../src/tools/default-set.js'
import { startFakeServer } from './fake-server.js'

/**
 * The stage events, and the one invariant that makes them safe to render.
 *
 * A front end shows a stage on `started` and hides it on `done`. It has no timeout of its
 * own, deliberately — a gate can legitimately take four minutes and a timeout would either
 * blank a running gate or leave a dead one on screen. That puts the entire burden on this
 * pairing: a stage that starts and never ends is a spinner nobody can clear, and the exits
 * where it would happen are the uncommon ones (aborted, skipped, could-not-run), which is
 * exactly why they need a test rather than a reading.
 */

let stop: (() => Promise<void>) | undefined
const workspaces: string[] = []

beforeEach(() => { stop = undefined })
afterEach(async () => {
  await stop?.()
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function newWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pc-stages-'))
  workspaces.push(dir)
  return dir
}

async function makeServer(handler: (body: any) => unknown) {
  return startFakeServer((body, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: 100_000 } }
    if (req.url === '/health') return { status: 'ok' }
    return handler(body)
  })
}

const answered = () => ({
  choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 100, completion_tokens: 5 },
})

function makeSession(root: string, url: string, stages: StageInfo[]): Session {
  return new Session({
    client: new LlamaClient({ baseUrl: url, model: 'm' }),
    toolset: { registry: new ToolRegistry() } as Toolset,
    workspaceRoot: root,
    mode: 'autopilot',
    store: new SessionStore(root),
    onStage: (info) => stages.push(info),
  })
}

/** Every `started` has exactly one `done`, and no `done` arrives unopened. */
function pairsUp(stages: StageInfo[]): { unclosed: string[]; unopened: string[] } {
  const open = new Map<string, number>()
  const unopened: string[] = []
  for (const s of stages) {
    if (s.state === 'started') open.set(s.stage, (open.get(s.stage) ?? 0) + 1)
    else if (s.state === 'done') {
      const n = open.get(s.stage) ?? 0
      if (n === 0) unopened.push(s.stage)
      else open.set(s.stage, n - 1)
    }
  }
  return {
    unclosed: [...open.entries()].filter(([, n]) => n > 0).map(([k]) => k),
    unopened,
  }
}

test('a plain turn opens no stages at all', async () => {
  const fake = await makeServer(() => answered())
  stop = fake.close
  const stages: StageInfo[] = []
  const session = makeSession(newWorkspace(), fake.url, stages)

  await session.send('hi')

  // Short message, no contract, nothing written: none of the gates has anything to do, and
  // a gate that announces itself and then discovers that is a flicker on screen.
  expect(stages).toEqual([])
})

test('a build with no verify command configured still opens and closes its stage', async () => {
  const fake = await makeServer(() => answered())
  stop = fake.close
  const stages: StageInfo[] = []
  const session = makeSession(newWorkspace(), fake.url, stages)

  await session.runGate('build')

  // The "there was nothing to run" exit — the one most likely to return early and leave a
  // stage open, because it is the path that does no work.
  expect(pairsUp(stages)).toEqual({ unclosed: [], unopened: [] })
  expect(stages.at(-1)?.outcome).toContain('no verify command')
})

test('a review with no contract still opens and closes its stage', async () => {
  const fake = await makeServer(() => answered())
  stop = fake.close
  const stages: StageInfo[] = []
  const session = makeSession(newWorkspace(), fake.url, stages)

  await session.runGate('review')

  expect(pairsUp(stages)).toEqual({ unclosed: [], unopened: [] })
  expect(stages.at(-1)?.outcome).toContain('nothing to review')
})

test('the build stage names the command, not the word "build"', async () => {
  const root = newWorkspace()
  mkdirSync(join(root, '.privatecode'), { recursive: true })
  writeFileSync(
    join(root, '.privatecode', 'settings.json'),
    JSON.stringify({ verify: { command: 'echo hello', timeoutMs: 10_000 } }),
    'utf8',
  )
  const fake = await makeServer(() => answered())
  stop = fake.close
  const stages: StageInfo[] = []
  const session = new Session({
    client: new LlamaClient({ baseUrl: fake.url, model: 'm' }),
    toolset: { registry: new ToolRegistry() } as Toolset,
    workspaceRoot: root,
    mode: 'autopilot',
    store: new SessionStore(root),
    verify: { command: 'echo hello', timeoutMs: 10_000, source: 'the test' },
    onStage: (info) => stages.push(info),
  })

  await session.runGate('build')

  const started = stages.find((s) => s.state === 'started')
  // Waiting on `dotnet build ./src/Engine` and waiting on `npm test` are not the same wait,
  // and the person watching is the one who wrote the command.
  expect(started?.detail).toContain('echo hello')
  expect(pairsUp(stages)).toEqual({ unclosed: [], unopened: [] })
})

test('gateMode manual is the default off switch, and it is off by default', async () => {
  const fake = await makeServer(() => answered())
  stop = fake.close
  const session = makeSession(newWorkspace(), fake.url, [])
  // Automatic is what a new session gets. The safer of the two to forget.
  expect(session.gateMode).toBe('auto')
  session.gateMode = 'manual'
  expect(session.gateMode).toBe('manual')
})

test('the reviewer detail says which file, not which JSON', () => {
  // Reaching into the private static through the class: this string is what a person reads
  // for four minutes while the reviewer works, and it is worth pinning literally.
  const detail = (Session as unknown as {
    reviewerDetail(name: string, args: string): string
  }).reviewerDetail

  expect(detail('Read', '{"path":"core/src/session/session.ts"}'))
    .toBe('reading core/src/session/session.ts')
  expect(detail('Grep', '{"pattern":"applyCompactionSwap","max_results":40}'))
    .toBe('searching for applyCompactionSwap')
  expect(detail('list_dir', '{"path":"core/src"}')).toBe('listing core/src')
  // A half-streamed call still has a usable name; it must not throw.
  expect(detail('Read', '{"path":')).toBe('Read')
  // Long values are clipped, because a status line that wraps pushes the composer around
  // while you are trying to type in it.
  const long = detail('Read', JSON.stringify({ path: 'a/'.repeat(60) + 'b.ts' }))
  expect(long.length).toBeLessThan(80)
  expect(long.endsWith('...')).toBe(true)
})

test('a gate that does nothing still reports why', async () => {
  const fake = await makeServer(() => answered())
  stop = fake.close
  const session = makeSession(newWorkspace(), fake.url, [])

  // Found live: `/review` on a session with no contract opened and closed its stage inside
  // a second, wrote nothing to the transcript, and left the person with no answer at all.
  // The outcome now comes back with the result so the window can say it.
  const review = await session.runGate('review')
  expect(review.turn.steps).toBe(0)
  expect(review.outcome).toContain('nothing to review')
  expect(review.reported).toBe(false)

  const build = await session.runGate('build')
  expect(build.outcome).toContain('no verify command')
  expect(build.reported).toBe(false)
})

test('a build that PASSES reports itself, so the window stays quiet', async () => {
  const root = newWorkspace()
  const fake = await makeServer(() => answered())
  stop = fake.close
  const session = new Session({
    client: new LlamaClient({ baseUrl: fake.url, model: 'm' }),
    toolset: { registry: new ToolRegistry() } as Toolset,
    workspaceRoot: root,
    mode: 'autopilot',
    store: new SessionStore(root),
    verify: { command: 'echo hello', timeoutMs: 20_000, source: 'the test' },
  })

  const build = await session.runGate('build')

  // The bug this pins: a passing build runs no fixer, so it comes back with zero steps and
  // empty text. The first version read that as "nothing happened" and announced
  // "/check: passed" as an ERROR note, in alert red, directly under the green verify row
  // that had just said the same thing. `reported` is the fact, asked rather than inferred.
  expect(build.turn.steps).toBe(0)
  expect(build.turn.finalText).toBe('')
  expect(build.reported).toBe(true)
  expect(build.outcome).toBe('passed')
})
