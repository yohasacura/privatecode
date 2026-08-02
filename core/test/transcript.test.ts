import { expect, test } from 'vitest'
import { Transcript } from '../src/transcript/transcript.js'
import type { ChatMessage, ToolCall } from '../src/llama/types.js'

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

function toolCall(args: string): ToolCall {
  return { id: 'call_1', type: 'function', function: { name: 'run', arguments: args } }
}

// Object.freeze is shallow: it locks the top-level object but leaves nested
// arrays/objects (like tool_calls and its contents) mutable. Both gaps below
// must throw, or the append-only guarantee is fiction.
test('nested tool_calls contents cannot be mutated through messages()', () => {
  const t = new Transcript()
  t.append({ role: 'assistant', content: null, tool_calls: [toolCall('{"x":1}')] })
  const [m] = t.messages()
  expect(() => {
    ;(m as ChatMessage).tool_calls![0]!.function.arguments = 'x'
  }).toThrow()
})

test('pushing onto a stored message tool_calls array throws', () => {
  const t = new Transcript()
  t.append({ role: 'assistant', content: null, tool_calls: [toolCall('{"x":1}')] })
  const [m] = t.messages()
  expect(() => {
    ;(m as ChatMessage).tool_calls!.push(toolCall('{"y":2}'))
  }).toThrow()
})

// append() must not retain a reference to the caller's object or anything
// reachable from it, otherwise mutating the caller's own copy after append()
// silently rewrites stored history behind the public API's back.
test('mutating the caller original object after append does not affect stored history', () => {
  const t = new Transcript()
  const original: ChatMessage = {
    role: 'assistant',
    content: null,
    tool_calls: [toolCall('{"x":1}')],
  }
  t.append(original)

  original.content = 'mutated'
  original.tool_calls![0]!.function.arguments = 'mutated'
  original.tool_calls!.push(toolCall('{"y":2}'))

  const [stored] = t.messages()
  expect(stored!.content).toBeNull()
  expect(stored!.tool_calls).toHaveLength(1)
  expect(stored!.tool_calls![0]!.function.arguments).toBe('{"x":1}')
})

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
