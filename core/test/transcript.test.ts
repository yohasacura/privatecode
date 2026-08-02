import { expect, test } from 'vitest'
import { Transcript } from '../src/transcript/transcript.js'

test('appends messages in order', () => {
  const t = new Transcript()
  t.append({ role: 'system', content: 'sys' })
  t.append({ role: 'user', content: 'hello' })
  expect(t.messages().map((m) => m.role)).toEqual(['system', 'user'])
})

// The prompt must be append-only: mutating history costs a full re-prefill.
// Measured 0.5 s to append vs 27.7 s to change one early word (docs/SPIKE-RESULTS.md).
test('returned messages cannot be mutated in place', () => {
  const t = new Transcript()
  t.append({ role: 'user', content: 'hello' })
  const list = t.messages() as ChatMessageArray
  expect(() => { (list as any).push({ role: 'user', content: 'x' }) }).toThrow()
  expect(() => { (list[0] as any).content = 'changed' }).toThrow()
})

type ChatMessageArray = readonly { role: string; content: string | null }[]

test('estimates tokens from character count', () => {
  const t = new Transcript()
  t.append({ role: 'user', content: 'a'.repeat(400) })
  // ~4 characters per token is close enough for a fill gauge.
  expect(t.approxTokens()).toBeGreaterThan(80)
  expect(t.approxTokens()).toBeLessThan(140)
})

test('round-trips through JSONL', () => {
  const t = new Transcript()
  t.append({ role: 'system', content: 'sys' })
  t.append({ role: 'assistant', content: null, reasoning_content: 'thinking' })
  const back = Transcript.fromJSONL(t.toJSONL())
  expect(back.messages()).toEqual(t.messages())
})
