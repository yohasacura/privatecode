/**
 * The pruned-prompt probe counted 0/4 English replies to Russian asks in BOTH arms —
 * including the arm with the shipped prompt, whose pin exists because the owner reported
 * exactly this. Before that becomes a finding, look at the words, and test the one variable
 * the probe got wrong: it sampled at 0.7/0.8 while the app ships 0.6/0.95/top_k 20.
 *
 *   npx tsx spike/language-pin-check.mts
 */
import { buildSystemPrompt } from '../core/src/agent/prompt.js'
import { QWEN_SAMPLING } from '../core/src/llama/sampling.js'

const BASE = process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080'
const ROOT = 'D:\\Projects\\LocalAgent\\local-private-code-app'
const SYSTEM = buildSystemPrompt({ workspaceRoot: ROOT, mode: 'normal' })
const ASK = 'Объясни своими словами, что такое чекпойнт в этом проекте и зачем он нужен. Не открывай файлы, просто расскажи.'

async function once(label: string, params: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: ASK }],
      max_tokens: 400, stream: false, ...params,
    }),
  })
  const body = await res.json() as { choices?: { message?: { content?: string } }[] }
  const text = (body.choices?.[0]?.message?.content ?? '').replace(/\s+/g, ' ').trim()
  const cyr = /[а-яА-ЯёЁ]/.test(text)
  console.log(`  ${label.padEnd(26)} ${cyr ? 'RUSSIAN' : 'english'}  «${text.slice(0, 90)}»`)
}

console.log('the shipped prompt, three sampling profiles, twice each:\n')
for (let i = 0; i < 2; i++) await once('probe sampling 0.7/0.8', { temperature: 0.7, top_p: 0.8 })
for (let i = 0; i < 2; i++) {
  await once('app sampling (QWEN_SAMPLING)', {
    temperature: QWEN_SAMPLING.temperature, top_p: QWEN_SAMPLING.top_p, top_k: QWEN_SAMPLING.top_k,
  })
}
