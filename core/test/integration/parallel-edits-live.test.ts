import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { SessionHost } from '../../src/host/host.js'
import { isHostEvent, type HostEvent, type HostOutbound, type HostReply, type SendResult } from '../../src/host/protocol.js'

/**
 * The owner's report: "the model tries to edit 3–4 files in parallel, does them one by one
 * anyway, and then all 4 calls fail with 'not enough room'". The cause was the output limit
 * landing in the middle of a batch of calls and the loop dropping the whole batch. Against
 * the real model: four files edited in one request, every one changed by the end of the
 * turn, and no card closed with "ran out of room".
 *
 * Run with `PRIVATECODE_INTEGRATION=1 npx vitest run --config vitest.integration.config.ts
 * test/integration/parallel-edits-live.test.ts`. One llama slot: never alongside another.
 */

const SERVER = process.env.PRIVATECODE_SERVER ?? 'http://127.0.0.1:8080'
const enabled = process.env.PRIVATECODE_INTEGRATION === '1'

interface Transport { messages: HostOutbound[]; send(msg: HostOutbound): void }
function resultOf<T>(transport: Transport, id: number): T {
  const found = transport.messages.find((m): m is HostReply => !isHostEvent(m) && m.id === id)
  if (!found) throw new Error(`no reply to request ${id}`)
  if ('error' in found) throw new Error(`request ${id} failed: ${found.error.message}`)
  return found.result as T
}

const FILES = ['Orders', 'Customers', 'Invoices', 'Shipments']
const source = (name: string): string => [
  'using System;',
  'using System.Collections.Generic;',
  '',
  `namespace Demo.Services`,
  '{',
  `    public sealed class ${name}Service`,
  '    {',
  `        private readonly List<string> _items = new();`,
  '',
  `        public void Add(string item)`,
  '        {',
  '            if (string.IsNullOrWhiteSpace(item)) throw new ArgumentException("empty", nameof(item));',
  '            _items.Add(item);',
  '        }',
  '',
  `        public int Count => _items.Count;`,
  '    }',
  '}',
  '',
].join('\n')

let tmp: string
let savedAppData: string | undefined
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pc-parallel-live-'))
  savedAppData = process.env['APPDATA']
  process.env['APPDATA'] = join(tmp, 'appdata')
})
afterAll(() => {
  if (savedAppData === undefined) delete process.env['APPDATA']; else process.env['APPDATA'] = savedAppData
})

describe.skipIf(!enabled)('several edits in one step, against the live model', () => {
  test('four files asked for at once are all edited by the end of the turn, with no call lost to the output limit', async () => {
    const workspace = join(tmp, 'ws')
    mkdirSync(join(workspace, 'Services'), { recursive: true })
    for (const f of FILES) writeFileSync(join(workspace, 'Services', `${f}Service.cs`), source(f))
    writeFileSync(join(workspace, 'Demo.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework><Nullable>enable</Nullable></PropertyGroup></Project>\n')

    const transport: Transport = { messages: [], send(msg) { this.messages.push(msg) } }
    const host = new SessionHost({ transport, prewarm: false })
    let id = 0
    const call = async <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
      // Captured here: the polling loop below bumps `id` for approval and question replies while
      // a `send` is still in flight, and reading the shared counter after the await picked up
      // the LAST reply (a bare `{}` from approval.reply) instead of the turn.
      const reqId = ++id
      await host.handle({ id: reqId, method, params })
      return resultOf<T>(transport, reqId)
    }
    const started = Date.now()
    const log = (line: string): void => { process.stdout.write(`[parallel-live +${((Date.now() - started) / 1000).toFixed(0)}s] ${line}\n`) }
    log(`workspace ${workspace}`)

    await call('init', { workspaceRoot: workspace, serverUrl: SERVER })
    await call('setMode', { mode: 'autopilot' })

    const answered = new Set<string>()
    const seen = new Set<number>()
    const sendPromise = call<SendResult>('send', {
      text: 'В каждом из четырёх файлов в Services/ (OrdersService.cs, CustomersService.cs, InvoicesService.cs, ' +
            'ShipmentsService.cs) добавь над классом подробный XML-комментарий <summary> из 4–6 строк на русском ' +
            'о назначении сервиса, его инвариантах и потокобезопасности, и добавь метод `public bool Contains(string item) => _items.Contains(item);` ' +
            'после Add. Сделай все четыре правки одним шагом — четыре вызова Edit сразу, не по одному.',
    })
    let settled = false
    void sendPromise.finally(() => { settled = true })
    while (!settled) {
      await new Promise((r) => setTimeout(r, 200))
      const events = transport.messages.filter(isHostEvent) as HostEvent[]
      events.forEach((e, i) => {
        if (seen.has(i)) return
        seen.add(i)
        const d = e.data as { name?: string; ok?: boolean; content?: string; args?: string; step?: number }
        if (e.event === 'tool.call') log(`→ ${d.name ?? '?'} ${String(d.args ?? '').slice(0, 120)}`)
        if (e.event === 'tool.result') log(`← ${d.name ?? '?'} ${d.ok === false ? 'FAILED' : 'ok'}: ${String(d.content ?? '').replace(/\s+/g, ' ').slice(0, 160)}`)
        if (e.event === 'step.continuation' || e.event === 'continuation') log(`continuation: ${JSON.stringify(d).slice(0, 120)}`)
      })
      for (const e of events) {
        const data = e.data as { requestId?: string; tool?: string; summary?: string }
        if (data.requestId === undefined || answered.has(data.requestId)) continue
        if (e.event === 'approval.request') {
          answered.add(data.requestId)
          await host.handle({ id: ++id, method: 'approval.reply', params: { requestId: data.requestId, decision: { verdict: 'allow' } } })
        } else if (e.event === 'question.request') {
          answered.add(data.requestId)
          await host.handle({ id: ++id, method: 'question.reply', params: { requestId: data.requestId, answer: 'yes' } })
        }
      }
    }
    const result = await sendPromise
    log(`turn: ${result.turn.stoppedBecause} after ${result.turn.steps} steps — ${result.turn.finalText.replace(/\s+/g, ' ').slice(0, 240)}`)
    const events = transport.messages.filter(isHostEvent) as HostEvent[]
    const results = events.filter((e) => e.event === 'tool.result').map((e) => e.data as { name?: string; ok?: boolean; content?: string })
    const edits = results.filter((r) => r.name === 'Edit' || r.name === 'Write')
    const notRun = results.filter((r) => /^Not run:/.test(String(r.content ?? '')))
    log(`edit results: ${edits.length} (${edits.filter((r) => r.ok !== false).length} ok); not-run: ${notRun.length}`)
    for (const r of notRun) log(`  not run: ${String(r.content).slice(0, 160)}`)

    for (const f of FILES) {
      const text = readFileSync(join(workspace, 'Services', `${f}Service.cs`), 'utf8')
      const ok = text.includes('<summary>') && text.includes('Contains(string item)')
      log(`${f}Service.cs: ${ok ? 'edited' : 'NOT edited'}`)
      expect(ok, `${f}Service.cs`).toBe(true)
    }
    expect(edits.filter((r) => r.ok !== false).length).toBeGreaterThanOrEqual(4)
    // Nothing closed with "ran out of room" — the cut, if any, is named for what it is.
    expect(notRun.filter((r) => /ran out of room/.test(String(r.content)))).toHaveLength(0)
    expect(existsSync(join(workspace, '.privatecode'))).toBe(true)
    await host.shutdown()
  }, 900_000)
})
