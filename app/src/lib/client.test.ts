import { describe, expect, it, vi } from 'vitest'
import { createClientForTesting, type RawTransport } from './client'

/** A fake `RawTransport`: records every sent line and lets the test deliver lines/close
 * events on demand, with no real Tauri IPC or WebSocket involved -- exactly the seam
 * `RawTransport` exists to make testable (see client.ts's own doc comment). */
function fakeTransport() {
  const sent: string[] = []
  let lineCb: ((line: string) => void) | undefined
  let closeCb: (() => void) | undefined
  const transport: RawTransport = {
    send(line) { sent.push(line) },
    onLine(cb) { lineCb = cb },
    // Mirrors TauriTransport's always-ready semantics: fires immediately, since none of
    // these tests care about the connecting/open distinction itself (that seam is
    // exercised directly by testing TauriTransport/WsTransport, not the fake).
    onOpen(cb) { cb() },
    onClose(cb) { closeCb = cb },
    close() { closeCb?.() },
  }
  return {
    transport,
    sent,
    deliver(msg: unknown) { lineCb?.(JSON.stringify(msg)) },
    triggerClose() { closeCb?.() },
  }
}

describe('ProtocolClient request/reply correlation', () => {
  it('resolves a call when a reply naming its own request id arrives', async () => {
    const fake = fakeTransport()
    const client = createClientForTesting(fake.transport)

    const promise = client.call('status', {})
    expect(fake.sent).toHaveLength(1)
    const req = JSON.parse(fake.sent[0]!)
    expect(req).toMatchObject({ method: 'status', params: {} })

    fake.deliver({ id: req.id, result: { serverUp: true, model: 'x' } })
    await expect(promise).resolves.toEqual({ serverUp: true, model: 'x' })
  })

  it('rejects a call when the reply is an error envelope', async () => {
    const fake = fakeTransport()
    const client = createClientForTesting(fake.transport)

    const promise = client.call('abort', {})
    const req = JSON.parse(fake.sent[0]!)
    fake.deliver({ id: req.id, error: { message: 'boom' } })
    await expect(promise).rejects.toThrow('boom')
  })

  it('matches replies to their own request id even when they arrive out of order', async () => {
    const fake = fakeTransport()
    const client = createClientForTesting(fake.transport)

    const p1 = client.call('status', {})
    const p2 = client.call('status', {})
    const req1 = JSON.parse(fake.sent[0]!)
    const req2 = JSON.parse(fake.sent[1]!)
    expect(req1.id).not.toBe(req2.id)

    // Reply to the SECOND request first -- proves correlation is by id, not send order.
    fake.deliver({ id: req2.id, result: { serverUp: false } })
    fake.deliver({ id: req1.id, result: { serverUp: true } })
    await expect(p2).resolves.toEqual({ serverUp: false })
    await expect(p1).resolves.toEqual({ serverUp: true })
  })
})

describe('ProtocolClient event dispatch', () => {
  it('delivers an event to a subscriber, and stops after unsubscribe', () => {
    const fake = fakeTransport()
    const client = createClientForTesting(fake.transport)
    const handler = vi.fn()

    const unsub = client.on('todos', handler)
    fake.deliver({ event: 'todos', data: { items: [{ text: 'x', status: 'pending' }] } })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({ items: [{ text: 'x', status: 'pending' }] })

    unsub()
    fake.deliver({ event: 'todos', data: { items: [] } })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('delivers one event to every subscriber', () => {
    const fake = fakeTransport()
    const client = createClientForTesting(fake.transport)
    const a = vi.fn()
    const b = vi.fn()
    client.on('settings.problem', a)
    client.on('settings.problem', b)
    fake.deliver({ event: 'settings.problem', data: { text: 'oops' } })
    expect(a).toHaveBeenCalledWith({ text: 'oops' })
    expect(b).toHaveBeenCalledWith({ text: 'oops' })
  })
})

describe('ProtocolClient connection state', () => {
  it('rejects every pending call and flips to closed when the transport closes', async () => {
    const fake = fakeTransport()
    const client = createClientForTesting(fake.transport)
    const states: string[] = []
    client.onStateChange((s) => states.push(s))

    const promise = client.call('status', {})
    fake.triggerClose()

    await expect(promise).rejects.toThrow()
    expect(client.state()).toBe('closed')
    expect(states).toContain('closed')
  })
})
