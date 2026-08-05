import { afterAll, describe, expect, test } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlamaClient } from '../../src/llama/client.js'
import { Session } from '../../src/session/session.js'
import { SessionStore } from '../../src/session/store.js'
import { createToolset } from '../../src/tools/default-set.js'

/**
 * Compaction between the steps of a running turn, against the real model.
 *
 * Everything else about this machinery is checked against a fake server, which answers
 * exactly what it is told to. The parts that can only fail for real are the ones this covers:
 * whether the message list a swap leaves behind is something llama.cpp will actually accept,
 * and whether a model handed a briefing in place of its own history carries on with the task
 * or loses the thread.
 *
 * The trick that makes it minutes rather than hours: the Session is told its context window
 * is 30,000 tokens while the server's is 131,072. Nothing under test knows the difference —
 * `compactIfOverWindow` reads the number it was given — so a few real steps cross it, and
 * every generation, tool call and summary is genuine.
 *
 * 30,000 and not less: `compactIfOverWindow` deliberately does nothing below
 * (TOOL_SCHEMA_TOKENS + PRE_TURN_HEADROOM) * 4 = 26,400, because under a window that small
 * the fixed costs dominate and the comparison says "compact" forever. The first version of
 * this test used 12,000 and proved only that the guard works — it exercised the BACKGROUND
 * compaction instead, and the mid-turn path never ran.
 */

const BASE = process.env.PRIVATECODE_SERVER ?? 'http://127.0.0.1:8080'
const PRETEND_CONTEXT = 30_000

const roots: string[] = []
afterAll(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Three files each big enough that reading one is a real dent in a 30k window. */
function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'pc-live-long-'))
  roots.push(root)
  for (const [name, subject] of [
    ['orders.ts', 'Order'], ['users.ts', 'User'], ['stock.ts', 'StockItem'],
  ] as const) {
    const lines = [`export interface ${subject} {`, '  id: string', '  createdAt: string', '}', '']
    for (let i = 0; i < 220; i++) {
      lines.push(
        `/** Helper ${i} for ${subject}. Verbose on purpose so a read is a real read. */`,
        `export function ${subject.toLowerCase()}Helper${i}(input: ${subject}): string {`,
        '  return `${input.id}:' + i + ':${input.createdAt}`',
        '}',
        '',
      )
    }
    writeFileSync(join(root, name), lines.join('\n'), 'utf8')
  }
  return root
}

describe('a turn that compacts itself, live', () => {
  test('the turn finishes the task, and the record survives every swap', async () => {
    const root = makeWorkspace()
    const store = new SessionStore(root)
    const states: string[] = []

    const session = new Session({
      client: new LlamaClient({ baseUrl: BASE, model: 'qwen' }),
      toolset: createToolset({}),
      workspaceRoot: root,
      mode: 'autopilot',
      store,
      longRun: true,
      checkpointIntervalMs: 20_000,
      compaction: { contextLength: PRETEND_CONTEXT },
      onCompaction: (e) => states.push(e.state),
      events: { onThinkingDelta: () => {} },
    })

    const result = await session.send(
      'Read orders.ts, users.ts and stock.ts one at a time. Then write summary.md listing ' +
      'each file and how many exported functions it has. Then append a line to each of the ' +
      'three files: a comment reading // reviewed. Work steadily, do not ask, finish it.',
    )

    // It compacted mid-turn — the thing under test actually happened.
    expect(states).toContain('applied')

    // And it still finished the work it was asked for, on the far side of having its own
    // history replaced by a summary. This is what a fake server cannot tell you.
    expect(result.stoppedBecause).toBe('done')
    expect(existsSync(join(root, 'summary.md'))).toBe(true)
    for (const f of ['orders.ts', 'users.ts', 'stock.ts']) {
      expect(readFileSync(join(root, f), 'utf8')).toContain('// reviewed')
    }

    // The flush (a759855): the swap must not take the turn's own work off the disk with it.
    const jsonl = readFileSync(join(root, '.privatecode', 'sessions', `${session.id}.jsonl`), 'utf8')
    const firstMarker = jsonl.indexOf('"__event":"compaction"')
    expect(firstMarker).toBeGreaterThan(0)
    expect(jsonl.slice(0, firstMarker)).toContain('Read orders.ts')

    // The relaxed clean-boundary rule, checked against what it is FOR: every tool reply in
    // the transcript a resume would rebuild must still have the call that produced it. A
    // single orphan here is a message list the server would refuse.
    const messages = store.load(session.id).transcript.messages()
    const orphans = messages.filter((m, i) =>
      m.role === 'tool' && !messages.slice(0, i).some((p) =>
        p.role === 'assistant' && (p.tool_calls ?? []).some((c) => c.id === m.tool_call_id)))
    expect(orphans).toHaveLength(0)

    // And the turn left a trail to come back to, rather than one entry written at the end.
    const checkpoints = await session.listCheckpoints(200)
    expect(checkpoints.filter((c) => c.step !== undefined).length).toBeGreaterThan(0)
  })
})
