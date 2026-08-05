import { expect, test } from 'vitest'
import { createEventRenderer } from '../src/cli/render.js'

/**
 * The CLI must take the STREAMING transport, whether or not it is drawing a live line.
 *
 * These are two different questions that used to have one answer. Visible streaming is a
 * rendering choice and is rightly gated on a TTY — no `\r` trick should ever reach a pipe.
 * Which transport `Agent` uses is not a rendering choice: streaming is opt-in purely on a
 * delta callback being present at all (loop.ts's `chat()`), and the step deadline measures
 * SILENCE, which can only be observed on a stream.
 *
 * So a piped run got a flat ceiling on the whole step instead of on the quiet part of it.
 * `--unattended` is exactly that run — no TTY, and the longest steps there are. Measured
 * live: a step batching four ~100-line file writes into one generation died on the 90 s
 * ceiling 3/3 having written nothing; on the streaming transport, 3/3 complete.
 */

test('the renderer always wires a delta callback, so the loop streams', () => {
  // No `stream` option at all: `cli.ts`'s one-shot and `--unattended` paths.
  const { events } = createEventRenderer()
  const streams = events.onThinkingDelta !== undefined ||
    events.onTextDelta !== undefined ||
    events.onToolCallDelta !== undefined
  expect(streams).toBe(true)
})

test('and it stays wired when stdout is not a terminal', () => {
  // The condition that used to turn it off. `isTTY` is read once, at construction, so this
  // has to be false BEFORE the call — which is also how the real piped process meets it.
  const original = process.stdout.isTTY
  try {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
    const { events } = createEventRenderer({ stream: true })
    expect(events.onToolCallDelta).toBeDefined()
    // And the VISIBLE streaming is still off, which is the half that should be TTY-gated:
    // a pipe gets the whole-blob path and never sees a carriage-return rewrite.
    expect(events.onTextDelta).toBeUndefined()
  } finally {
    Object.defineProperty(process.stdout, 'isTTY', { value: original, configurable: true })
  }
})
