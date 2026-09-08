/**
 * What the model does when it continues a session recorded BEFORE the tool renames.
 *
 * A scratch workspace gets a stored session whose transcript calls the tools by their old
 * names (`list_dir`, `run_command`, `background_task` — the vocabulary of every session from
 * before 2026-09-07), the session is resumed through the host exactly as the window does it,
 * and one request that needs the shell is sent. Every tool call the model makes and the
 * head of every answer is printed, so imitation of the old names — and what the harness
 * answers to it — is visible as such.
 *
 *   npx tsx spike/legacy-session-probe.mts [--mode auto-edit] [--timeout-min 5]
 *
 * Needs the llama.cpp server (`LLAMA_URL`, default http://127.0.0.1:8080).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionHost } from '../core/src/host/host.js'
import { isHostEvent, type HostOutbound } from '../core/src/host/protocol.js'

function argAfter(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback
}
const LLAMA_URL = process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080'
const MODE = argAfter('--mode', 'auto-edit')
const TIMEOUT_MS = Number(argAfter('--timeout-min', '5')) * 60_000

const root = mkdtempSync(join(tmpdir(), 'pc-legacy-'))
const write = (rel: string, body = 'x\n'): void => {
  mkdirSync(join(root, rel, '..'), { recursive: true })
  writeFileSync(join(root, rel), body)
}
write('README.md', '# scratch\n')
write('package.json', '{ "name": "scratch", "scripts": { "test": "echo ok", "build": "echo built" } }\n')
write('src/app.ts', 'export const app = 1\n')
write('build/keep.txt', 'keep\n')
for (let i = 0; i < 6; i++) write(`build/out${i}.tmp`)
for (let i = 0; i < 3; i++) write(`build/nested/part${i}.tmp`)

// The stored session, in the old vocabulary. Shapes as the store writes them: one JSON
// message per line, and a pretty-printed meta file beside it.
const id = 's-20260901-120000-abcd'
const call = (n: string, name: string, args: Record<string, unknown>) => ({
  role: 'assistant', content: null,
  tool_calls: [{ id: n, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
})
const reply = (n: string, name: string, content: string) => ({ role: 'tool', tool_call_id: n, name, content })
const transcript = [
  { role: 'system', content: `You are PrivateCode, a coding agent working in the local workspace ${root}.` },
  { role: 'user', content: 'What is in build/?' },
  call('c1', 'list_dir', { path: 'build' }),
  reply('c1', 'list_dir', 'keep.txt\nnested/\nout0.tmp\nout1.tmp\nout2.tmp\nout3.tmp\nout4.tmp\nout5.tmp'),
  { role: 'assistant', content: 'build/ holds keep.txt, a nested/ folder and six .tmp files.' },
  { role: 'user', content: 'Run the tests.' },
  call('c2', 'run_command', { command: 'npm test' }),
  reply('c2', 'run_command', 'exit 0 in 0.4 s\n> scratch@ test\n> echo ok\n\nok'),
  { role: 'assistant', content: 'The tests pass.' },
  { role: 'user', content: 'Build it in the background and tell me when it is done.' },
  call('c3', 'background_task', { action: 'start', command: 'npm run build' }),
  reply('c3', 'background_task', 'Started in the background as task-1. Poll it with action "poll".'),
  call('c4', 'background_task', { action: 'poll', id: 'task-1', wait_seconds: 10 }),
  reply('c4', 'background_task', 'task-1: exited with code 0\nNew output since last poll:\n> scratch@ build\n> echo built\n\nbuilt'),
  { role: 'assistant', content: 'The build finished: "built".' },
]
const dir = join(root, '.privatecode', 'state', 'sessions')
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, `${id}.jsonl`), transcript.map((m) => JSON.stringify(m)).join('\n') + '\n')
writeFileSync(join(dir, `${id}.meta.json`), JSON.stringify({
  id, title: 'old vocabulary', createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-09-01T12:10:00.000Z',
  workspaceRoot: root, mode: MODE,
}, null, 2))

const calls: string[] = []
let host: SessionHost
let rpc = 10
const transport = {
  send(msg: HostOutbound) {
    if (!isHostEvent(msg)) return
    const data = (msg as { data?: unknown }).data as Record<string, unknown> | undefined
    if (msg.event === 'tool.call') {
      const line = `${String(data?.['name'])}(${String(data?.['args'] ?? '').slice(0, 120)})`
      calls.push(String(data?.['name']))
      console.log(`      ${line}`)
    } else if (msg.event === 'tool.result') {
      console.log(`        -> ${String(data?.['name'])} ${data?.['ok'] === false ? 'FAIL' : 'ok'}: ${String(data?.['content'] ?? '').replace(/\s+/g, ' ').slice(0, 170)}`)
    } else if (msg.event === 'approval.request') {
      console.log(`      [approval: ${String(data?.['summary'] ?? data?.['tool'])}] -> allow`)
      void host.handle({ id: rpc++, method: 'approval.reply', params: { requestId: data?.['requestId'], decision: { verdict: 'allow' } } })
    } else if (msg.event === 'question.request') {
      const options = (data?.['options'] as string[] | undefined) ?? []
      console.log(`      [question: ${String(data?.['question']).slice(0, 100)}] -> ${options[0] ?? 'yes'}`)
      void host.handle({ id: rpc++, method: 'question.reply', params: { requestId: data?.['requestId'], answer: options[0] ?? 'yes' } })
    } else if (msg.event === 'turn.done') {
      console.log(`    turn.done: ${JSON.stringify(data).slice(0, 200)}`)
    } else if (msg.event === 'assistant.text' || msg.event === 'text') {
      console.log(`    text: ${String(data?.['text'] ?? '').replace(/\s+/g, ' ').slice(0, 300)}`)
    } else if (!/delta|step|thinking|status|slots|progress|todos|prompt/.test(msg.event)) {
      console.log(`    [${msg.event}] ${JSON.stringify(data).slice(0, 120)}`)
    }
  },
}
host = new SessionHost({ transport, prewarm: false })
await host.handle({ id: 1, method: 'init', params: { workspaceRoot: root, serverUrl: LLAMA_URL } })
await host.handle({ id: 2, method: 'sessions.resume', params: { id } })
console.log(`=== resumed ${id} (${MODE}) in ${root}`)

const request = 'Find every .tmp file under build/ and delete them. Leave everything else alone.'
console.log(`    > ${request}`)
const started = Date.now()
const timer = setTimeout(() => { console.log('    (timeout — aborting)'); void host.handle({ id: 3, method: 'abort', params: {} }) }, TIMEOUT_MS)
try {
  await host.handle({ id: 4, method: 'send', params: { text: request } })
} finally {
  clearTimeout(timer)
}
const left = (function all(d: string, prefix = ''): string[] {
  const out: string[] = []
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name === '.privatecode') continue
    const rel = prefix === '' ? e.name : `${prefix}/${e.name}`
    if (e.isDirectory()) out.push(...all(join(d, e.name), rel)); else out.push(rel)
  }
  return out
})(root).filter((f) => f.endsWith('.tmp'))
const byTool = calls.reduce<Record<string, number>>((m, n) => { m[n] = (m[n] ?? 0) + 1; return m }, {})
console.log(`    → ${left.length === 0 ? 'DONE' : 'NOT DONE'} (tmp left: ${left.length}, keep.txt: ${existsSync(join(root, 'build', 'keep.txt'))}); ${((Date.now() - started) / 1000).toFixed(0)}s; calls: ${JSON.stringify(byTool)}`)
await host.handle({ id: 5, method: 'shutdown', params: {} }).catch(() => {})
rmSync(root, { recursive: true, force: true })
process.exit(0)
