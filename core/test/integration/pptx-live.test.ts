import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { SessionHost } from '../../src/host/host.js'
import { isHostEvent, type HostEvent, type HostOutbound, type HostReply, type SendResult } from '../../src/host/protocol.js'

/**
 * The bundled pptx skill, used by the real model the way a person would ask for it: a folder
 * with a page of material, one sentence asking for a deck. What is checked is what the skill
 * promises — the model reads the procedure, writes a spec, the tool builds a deck that
 * validates and renders — plus a record of every tool call and every failure the model hit,
 * which is the measure of whether SKILL.md is enough for this model.
 *
 * Run with `PRIVATECODE_INTEGRATION=1 npx vitest run --config vitest.integration.config.ts
 * test/integration/pptx-live.test.ts`. One llama slot: never alongside another live test.
 */

const SERVER = process.env.PRIVATECODE_SERVER ?? 'http://127.0.0.1:8080'
const enabled = process.env.PRIVATECODE_INTEGRATION === '1'
const TOOL = join(__dirname, '..', '..', 'skills', 'pptx', 'pptx.cjs')

const BRIEF = `# Итоги третьего квартала: сеть кофеен «Зерно»

Материал для презентации совету директоров. Восемь–десять слайдов, аудитория — инвесторы,
которые видели прошлый отчёт.

## Главные цифры

- Выручка 184 млн ₽, рост 21% к прошлому кварталу и 34% год к году.
- Средний чек 412 ₽ (было 371 ₽); гости приходят 2,4 раза в неделю против 2,1.
- Открыто 6 новых точек (всего 47), из них 4 в формате «окно» без посадки.
- Маржинальность точки выросла с 11% до 14% за счёт закупки зерна напрямую у обжарщика.
- Отток персонала снизился с 38% до 29% годовых после новой системы смен.

## Что сработало

1. Подписка «кофе каждый день» за 2 990 ₽ в месяц: 8 400 подписчиков, 19% выручки, подписчики
   тратят на еду на 27% больше обычных гостей.
2. Формат «окно»: точка окупается за 7 месяцев вместо 14, аренда в 3 раза ниже.
3. Прямая закупка зерна: минус 2,1 млн ₽ в месяц на сырьё, стабильный вкус, один поставщик.
4. Приложение: 61% заказов проходят через него, очередь у стойки сократилась вдвое.

## Что не сработало

- Завтраки: 4% выручки при плане 10%, кухня не справляется в утренний пик.
- Две точки в торговых центрах убыточны второй квартал подряд (минус 0,9 млн ₽ в сумме).
- Доставка через агрегаторы: комиссия 30% съедает всю маржу, доля 6%.

## Планы на четвёртый квартал

- Закрыть или переформатировать две убыточные точки в ТЦ до декабря.
- Открыть ещё 8 «окон» в спальных районах; бюджет 24 млн ₽.
- Убрать завтраки из меню там, где кухня меньше 12 м², оставить выпечку.
- Запустить семейную подписку и годовой тариф со скидкой 15%.
- Цель квартала: выручка 215 млн ₽, маржинальность точки 15%, 12 000 подписчиков.

## Сравнение форматов

| Формат | Точек | Выручка на точку в месяц | Маржа | Окупаемость |
| Классический с посадкой | 31 | 1,6 млн ₽ | 12% | 14 месяцев |
| Окно | 12 | 0,9 млн ₽ | 19% | 7 месяцев |
| Торговый центр | 4 | 1,1 млн ₽ | −3% | не окупается |

Тезис для финала: рост даёт не количество точек, а подписка и дешёвый формат; сеть переходит
от «кофейни с посадкой» к «кофе по дороге».
`

interface Transport { messages: HostOutbound[]; send(msg: HostOutbound): void }

function resultOf<T>(transport: Transport, id: number): T {
  const found = transport.messages.find((m): m is HostReply => !isHostEvent(m) && m.id === id)
  if (!found) throw new Error(`no reply to request ${id}`)
  if ('error' in found) throw new Error(`request ${id} failed: ${found.error.message}`)
  return found.result as T
}

let tmp: string
let savedAppData: string | undefined

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pc-pptx-live-'))
  savedAppData = process.env['APPDATA']
  process.env['APPDATA'] = join(tmp, 'appdata')
})
afterAll(() => {
  if (savedAppData === undefined) delete process.env['APPDATA']; else process.env['APPDATA'] = savedAppData
  // Left on disk on purpose: the deck and its renders are the evidence. The path is logged.
})

describe.skipIf(!enabled)('the pptx skill against the live model', () => {
  test('asked for a deck from a page of material, the model builds one that validates and renders', async () => {
    const workspace = join(tmp, 'zerno')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'brief.md'), BRIEF)

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
    const log = (line: string): void => { process.stdout.write(`[pptx-live +${((Date.now() - started) / 1000).toFixed(0)}s] ${line}\n`) }
    log(`workspace ${workspace}`)

    await call('init', { workspaceRoot: workspace, serverUrl: SERVER })
    await call('setMode', { mode: 'autopilot' })

    const answered = new Set<string>()
    const seen = new Set<number>()
    const sendPromise = call<SendResult>('send', {
      text: 'Сделай презентацию по brief.md для совета директоров, 8–10 слайдов, скиллом pptx. ' +
            'Сохрани её как deck.pptx в этой папке и отрендери слайды в папку qa.',
    })
    let settled = false
    void sendPromise.finally(() => { settled = true })
    while (!settled) {
      await new Promise((r) => setTimeout(r, 200))
      const events = transport.messages.filter(isHostEvent) as HostEvent[]
      events.forEach((e, i) => {
        if (seen.has(i)) return
        seen.add(i)
        const d = e.data as { name?: string; ok?: boolean; content?: string; args?: unknown; step?: number }
        if (e.event === 'tool.call') log(`→ ${d.name ?? '?'} ${JSON.stringify(d.args ?? {}).slice(0, 160)}`)
        if (e.event === 'tool.result') log(`← ${d.name ?? '?'} ${d.ok === false ? 'FAILED' : 'ok'}: ${String(d.content ?? '').replace(/\s+/g, ' ').slice(0, 220)}`)
      })
      for (const e of events) {
        const data = e.data as { requestId?: string; tool?: string; summary?: string; question?: string }
        if (data.requestId === undefined || answered.has(data.requestId)) continue
        if (e.event === 'approval.request') {
          answered.add(data.requestId)
          log(`approve ${data.tool ?? ''}: ${data.summary ?? ''}`)
          await host.handle({ id: ++id, method: 'approval.reply', params: { requestId: data.requestId, decision: { verdict: 'allow' } } })
        } else if (e.event === 'question.request') {
          answered.add(data.requestId)
          log(`question: ${data.question ?? ''} → yes`)
          await host.handle({ id: ++id, method: 'question.reply', params: { requestId: data.requestId, answer: 'yes' } })
        }
      }
    }
    const result = await sendPromise
    log(`turn: ${result.turn.stoppedBecause} after ${result.turn.steps} steps`)
    log(`final: ${result.turn.finalText.replace(/\s+/g, ' ').slice(0, 600)}`)
    const events = transport.messages.filter(isHostEvent) as HostEvent[]
    const tools = events.filter((e) => e.event === 'tool.call').map((e) => (e.data as { name?: string }).name ?? '?')
    const failures = events.filter((e) => e.event === 'tool.result' && (e.data as { ok?: boolean }).ok === false).length
    log(`tools (${tools.length}): ${tools.join(', ')}; failed results: ${failures}`)

    // What the skill promised: a deck in the folder that validates, with enough slides.
    const decks = readdirSync(workspace).filter((f) => f.toLowerCase().endsWith('.pptx'))
    log(`decks: ${decks.join(', ') || '(none)'}`)
    expect(decks.length).toBeGreaterThan(0)
    const deck = join(workspace, decks.includes('deck.pptx') ? 'deck.pptx' : decks[0]!)
    const v = await execa(process.execPath, [TOOL, 'validate', deck], { reject: false })
    log(`validate: ${v.stdout.trim().split('\n')[0]}`)
    expect(v.exitCode).toBe(0)
    const o = await execa(process.execPath, [TOOL, 'outline', deck, '--json'])
    const slides = JSON.parse(o.stdout) as Array<{ n: number; title: string }>
    log(`slides (${slides.length}): ${slides.map((s) => s.title).join(' | ')}`)
    expect(slides.length).toBeGreaterThanOrEqual(6)

    // Rendered by the model if it followed the procedure; rendered here otherwise, so the
    // evidence exists either way.
    const qa = join(workspace, 'qa')
    const rendered = existsSync(qa) && readdirSync(qa).some((f) => f.endsWith('.png'))
    log(`model rendered: ${rendered}`)
    if (!rendered) {
      const r = await execa(process.execPath, [TOOL, 'render', deck, '-o', qa, '--width', '1400', '--grid'], { reject: false })
      log(`render: ${r.stdout.trim().split('\n').pop()}`)
    } else {
      await execa(process.execPath, [TOOL, 'render', deck, '-o', join(workspace, 'qa-grid'), '--width', '1400', '--grid'], { reject: false })
    }
    log(`evidence in ${workspace}`)
    await host.shutdown()
  }, 900_000)
})
