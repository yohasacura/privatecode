import { describe, expect, test } from 'vitest'
import { encodeLine, LineDecoder, isHostEvent } from '../src/host/protocol.js'
import type { HostEvent, HostReply, HostRequest } from '../src/host/protocol.js'

describe('LineDecoder', () => {
  test('reassembles a message split mid-JSON across three chunks', () => {
    const decoder = new LineDecoder()
    const full = `${JSON.stringify({ id: 1, result: { ok: true, nested: [1, 2, 3] } })}\n`
    // Cut mid-object on purpose (inside the "result" value), not on a convenient boundary.
    const a = full.slice(0, 6)
    const b = full.slice(6, 18)
    const c = full.slice(18)

    expect(decoder.push(a)).toEqual([])
    expect(decoder.push(b)).toEqual([])
    expect(decoder.push(c)).toEqual([{ id: 1, result: { ok: true, nested: [1, 2, 3] } }])
  })

  test('parses two complete messages delivered in a single chunk', () => {
    const decoder = new LineDecoder()
    const chunk = `${JSON.stringify({ id: 1, result: 'a' })}\n${JSON.stringify({ id: 2, result: 'b' })}\n`

    expect(decoder.push(chunk)).toEqual([{ id: 1, result: 'a' }, { id: 2, result: 'b' }])
  })

  test('tolerates CRLF line endings', () => {
    const decoder = new LineDecoder()
    const chunk = `${JSON.stringify({ event: 'todos', data: { items: [] } })}\r\n`

    expect(decoder.push(chunk)).toEqual([{ event: 'todos', data: { items: [] } }])
  })

  test('CRLF split across chunks (the \\r arrives at the end of one chunk, \\n at the start of the next)', () => {
    const decoder = new LineDecoder()
    const line = JSON.stringify({ event: 'text.delta', data: { text: 'hi' } })

    expect(decoder.push(`${line}\r`)).toEqual([])
    expect(decoder.push('\n')).toEqual([{ event: 'text.delta', data: { text: 'hi' } }])
  })

  test('malformed JSON throws an error naming the offending line', () => {
    const decoder = new LineDecoder()
    expect(() => decoder.push('{not valid json}\n')).toThrow(/\{not valid json\}/)
  })

  test('throws when a single line exceeds MAX_LINE_CHARS without a newline (untrusted peer growth bound)', () => {
    const decoder = new LineDecoder()
    const hugeChunk = 'x'.repeat(1_000_001)
    expect(() => decoder.push(hugeChunk)).toThrow(
      /line buffer exceeded.*1000000 chars without a newline/
    )
  })
})

describe('encodeLine / LineDecoder round-trip', () => {
  test('HostRequest', () => {
    const req: HostRequest = {
      id: 1,
      method: 'init',
      params: { workspaceRoot: '/tmp/ws', serverUrl: 'http://127.0.0.1:8080' },
    }
    expect(new LineDecoder().push(encodeLine(req))).toEqual([req])
  })

  test('HostReply (result shape)', () => {
    const reply: HostReply = { id: 2, result: { sessions: [], problems: [] } }
    expect(new LineDecoder().push(encodeLine(reply))).toEqual([reply])
  })

  test('HostReply (error shape)', () => {
    const reply: HostReply = { id: 3, error: { message: 'workspace root does not exist' } }
    expect(new LineDecoder().push(encodeLine(reply))).toEqual([reply])
  })

  test('HostEvent', () => {
    const event: HostEvent = { event: 'approval.request', data: { requestId: 'r1', tool: 'edit_file', summary: 's', detail: 'd', suggestedRules: ['edit_file'] } }
    expect(new LineDecoder().push(encodeLine(event))).toEqual([event])
  })

  test('produces exactly one trailing newline and no embedded newlines', () => {
    const line = encodeLine({ event: 'assistant.text', data: { text: 'line one\nline two' } })
    expect(line.endsWith('\n')).toBe(true)
    expect(line.slice(0, -1)).not.toMatch(/[\r\n]/)
    // and it still decodes back to the original multi-line text
    expect(new LineDecoder().push(line)).toEqual([{ event: 'assistant.text', data: { text: 'line one\nline two' } }])
  })
})

describe('isHostEvent', () => {
  test('discriminates HostEvent from HostReply correctly', () => {
    const event: HostEvent = { event: 'step.done', data: { step: 1, seconds: 0.5 } }
    expect(isHostEvent(event)).toBe(true)

    const replyResult: HostReply = { id: 1, result: 'ok' }
    expect(isHostEvent(replyResult)).toBe(false)

    const replyError: HostReply = { id: 1, error: { message: 'failed' } }
    expect(isHostEvent(replyError)).toBe(false)
  })
})
