import { expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_TRIGGER_TOKENS, Session } from '../src/session/session.js'
import { LlamaClient } from '../src/llama/client.js'
import { createToolset } from '../src/tools/default-set.js'

/**
 * The number the status bar shows and the number that decides a compaction are now the same
 * number, computed once.
 *
 * They were two, and only one of them was on screen. The gate corrected a measured count by
 * everything appended since it was taken, and an estimate by the tool schemas sent with every
 * request; the readout divided the raw figures by the window. So the bar could read half full
 * and calm while the conversation compacted underneath it — the exact surprise a context
 * readout exists to prevent.
 */

function session(triggerTokens?: number): { s: Session; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pc-ctx-'))
  const s = new Session({
    client: new LlamaClient({ baseUrl: 'http://127.0.0.1:1', model: 'test' }),
    toolset: createToolset({ workspaceRoot: dir }),
    workspaceRoot: dir,
    compaction: { contextLength: 262_144, ...(triggerTokens === undefined ? {} : { triggerTokens }) },
  })
  return { s, dir }
}

test('an estimate carries the tool schemas, because every request does', () => {
  // ~2,600 tokens of JSON schema go out with every single call. Left out of the estimate,
  // the readout is short by that much from the first message to the last.
  const { s, dir } = session()
  try {
    const usage = s.contextUsage()
    expect(usage.promptTokens).toBeNull()
    expect(usage.approxTokens).toBeGreaterThanOrEqual(2_600)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the threshold is whichever of the two triggers fires first', () => {
  const { s, dir } = session()
  try {
    // Ratio alone: 0.8 x 262144. This is what a bare Session has.
    expect(s.compactAt()).toBeCloseTo(209_715, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('and the absolute trigger wins when it is lower, which is the shipped default', () => {
  // The host sets DEFAULT_TRIGGER_TOKENS on every session it builds. On this machine's 262k
  // window that is 53% — so a bar whose only warning was at 80% of the window never warned
  // before a compaction, not once.
  const { s, dir } = session(DEFAULT_TRIGGER_TOKENS)
  try {
    expect(s.compactAt()).toBe(DEFAULT_TRIGGER_TOKENS)
    expect(DEFAULT_TRIGGER_TOKENS / 262_144).toBeLessThan(0.6)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
