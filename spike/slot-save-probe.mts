/**
 * Does a saved slot state survive a SERVER RESTART and spare the resumed conversation its
 * re-prefill? Two phases, because the honest eviction is the restart itself: the RAM prompt
 * cache holds a dozen 20k-token states and cannot be talked out of them.
 *
 * The first version sent the ORIGINAL conversation back after restoring and measured a full
 * re-prefill (19,874 of 19,874 tokens). That was the probe's mistake, not the feature's: the
 * saved state ends AFTER the reply the model generated, and this model's recurrent (DeltaNet)
 * state cannot be rewound to a point before it — so a prompt that diverges before the end of
 * the saved sequence gets nothing. A resumed session in the app never does that: its next
 * request is the whole transcript, reply included, plus one new message.
 *
 *   npx tsx spike/slot-save-probe.mts save [tokens≈20000]      # prefill, reply, save; writes the transcript
 *   ... restart the server (spike/server-restart.ps1) ...
 *   npx tsx spike/slot-save-probe.mts restore                    # restore, continue the conversation, measure
 *
 * Requires the server started with `--slot-save-path <dir>`.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080'
const SAVE_DIR = process.env['SLOT_SAVE_DIR'] ?? 'D:\\Projects\\LocalAgent\\slot-cache'
const STATE_FILE = new URL('./speed-results/slot-probe-state.json', import.meta.url)
const PHASE = process.argv[2] ?? 'save'
const TARGET_TOKENS = Number(process.argv[3] ?? 20_000)

type Msg = { role: string; content: string; reasoning_content?: string }

async function chat(messages: Msg[], maxTokens: number, thinking: boolean) {
  const t0 = performance.now()
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'kat', messages, max_tokens: maxTokens, temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0,
      cache_prompt: true, ...(thinking ? {} : { chat_template_kwargs: { enable_thinking: false } }),
    }),
  })
  const data = await res.json() as {
    timings?: Record<string, number>
    choices?: { message?: { content?: string; reasoning_content?: string } }[]
  }
  return {
    wall: (performance.now() - t0) / 1000,
    promptN: data.timings?.['prompt_n'] ?? -1,
    promptMs: Math.round(data.timings?.['prompt_ms'] ?? -1),
    message: data.choices?.[0]?.message ?? {},
  }
}

async function slot(action: string, filename?: string) {
  const t0 = performance.now()
  const res = await fetch(`${BASE}/slots/0?action=${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(filename ? { filename } : {}),
  })
  return { status: res.status, wall: (performance.now() - t0) / 1000, body: (await res.text()).slice(0, 240) }
}

if (PHASE === 'save') {
  const files = [
    'D:\\Projects\\WindowsOptimizer\\src\\WinOptimizer\\ViewModels\\MainViewModel.cs',
    'D:\\Projects\\WindowsOptimizer\\src\\WinOptimizer\\Services\\PowerTweaker.cs',
    'D:\\Projects\\WindowsOptimizer\\src\\WinOptimizer\\Services\\ProcessCleaner.cs',
    'D:\\Projects\\WindowsOptimizer\\src\\WinOptimizer\\MainWindow.xaml',
  ]
  let body = ''
  for (let i = 0; body.length < TARGET_TOKENS * 3.6; i++) {
    const f = files[i % files.length]!
    const text = readFileSync(f, 'utf8').split(/\r?\n/).map((l, n) => `${n + 1}\t${l}`).join('\n')
    body += `\n\n=== read ${i + 1}: ${f} ===\n${text}`
  }
  const conversation: Msg[] = [
    { role: 'system', content: 'You are PrivateCode, a coding agent working in the local workspace D:\\x.' },
    { role: 'user', content: `Here is what has been read so far.${body}\n\nIn one sentence, what does PowerTweaker do?` },
  ]
  // Thinking ON, as the app runs: the reply carries reasoning_content, which is re-rendered
  // into every later prompt under --reasoning-preserve.
  const first = await chat(conversation, 400, true)
  console.log(`1. cold prefill + reply  ${first.wall.toFixed(1)}s  prompt_n=${first.promptN} prompt_ms=${first.promptMs}`)
  const reply: Msg = {
    role: 'assistant',
    content: first.message.content ?? '',
    ...(first.message.reasoning_content ? { reasoning_content: first.message.reasoning_content } : {}),
  }
  const filename = 'probe-resume.bin'
  const saved = await slot('save', filename)
  let size = 0
  try { size = statSync(join(SAVE_DIR, filename)).size } catch { /* reported as 0 */ }
  console.log(`2. save                  ${saved.wall.toFixed(1)}s  HTTP ${saved.status}  ${(size / 1048576).toFixed(0)} MiB  ${saved.body.replace(/\s+/g, ' ')}`)
  mkdirSync(new URL('./speed-results/', import.meta.url), { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify({ conversation: [...conversation, reply], filename }), 'utf8')
  console.log('transcript written; now restart the server and run the restore phase')
} else {
  const { conversation, filename } = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { conversation: Msg[]; filename: string }
  const next: Msg[] = [...conversation, { role: 'user', content: 'And in one sentence, what does ProcessCleaner do?' }]

  const restored = await slot('restore', filename)
  console.log(`3. restore after restart ${restored.wall.toFixed(1)}s  HTTP ${restored.status}  ${restored.body.replace(/\s+/g, ' ')}`)
  const cont = await chat(next, 200, true)
  console.log(`4. continue              ${cont.wall.toFixed(1)}s  prompt_n=${cont.promptN} prompt_ms=${cont.promptMs}  -> ${(cont.message.content ?? '').replace(/\s+/g, ' ').slice(0, 80)}`)
  console.log(cont.promptN < 200
    ? '   RESUME IS WARM: only the new message was prefilled.'
    : '   resume paid a re-prefill: the restored state was not matched.')
}
