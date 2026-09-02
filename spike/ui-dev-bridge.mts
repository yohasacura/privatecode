/**
 * The window against a scripted model, for looking at the UI without touching the real
 * server: a fake llama-server that plays a small scenario (read a file, edit it, run the
 * build, answer in prose) for every message, plus the dev WebSocket bridge over a throwaway
 * copy of WindowsOptimizer. Prints the URL to open in the Vite dev server.
 *
 *   npx tsx spike/ui-dev-bridge.mts            # then open the printed http://localhost:1420/?ws=...
 *
 * User settings are read from a scratch APPDATA, so the window asks for the server URL on
 * its first screen — paste the fake server's — and the owner's own ui.json is never touched.
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RawResponse, TrickleResponse, startFakeServer } from '../core/test/fake-server.js'
import { SHAPES, makeWorkspace } from '../eval/workspace.js'

const usage = { prompt_tokens: 18_400, completion_tokens: 140 }
const timings = { prompt_n: 18_400, prompt_ms: 900, predicted_n: 140, predicted_ms: 3300 }

const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`
const opening = frame({ choices: [{ delta: { role: 'assistant', content: null }, finish_reason: null }] })
const done = 'data: [DONE]\n\n'

/** A tool call the way llama-server streams one: a role chunk, the call, the finish chunk. */
function call(id: string, name: string, args: Record<string, unknown>): TrickleResponse {
  return new TrickleResponse([
    opening,
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] }),
    frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage, timings }),
    done,
  ], 120)
}

/** Prose streamed word by word, so the transcript's live rendering is exercised too. */
function text(body: string, gapMs = 35): TrickleResponse {
  const words = body.split(/(?<=\s)/)
  return new TrickleResponse([
    opening,
    ...words.map((w) => frame({ choices: [{ delta: { content: w }, finish_reason: null }] })),
    frame({ choices: [{ delta: {}, finish_reason: 'stop' }], usage, timings }),
    done,
  ], gapMs)
}

const ANSWER = [
  'Done. `SaveSnapshot` now stamps the snapshot before it is written:',
  '',
  '- **`Snapshot.SavedAt`** — a new `DateTimeOffset` property, set in `SnapshotStore.SaveSnapshot` just before serialising.',
  '- Loading is unchanged; an older `snapshot.json` without the field deserialises with the default value.',
  '',
  'The build passed after the edit. One thing worth a look: `FallbackRestoreSnapshot` does not go through `SaveSnapshot`, so a fallback snapshot has no `SavedAt` until it is saved.',
].join('\n')

async function main(): Promise<void> {
  const { root } = makeWorkspace(SHAPES['winopt']!)
  let step = 0
  const fake = await startFakeServer((body, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: 196_608 }, model_path: 'KAT-Coder-V2.5-Dev.gguf' }
    if (req.url === '/health') return { status: 'ok' }
    if (req.url?.startsWith('/slots')) return new RawResponse(501, '{"error":"not supported"}', 'application/json')
    if (req.url === '/v1/models' || req.url === '/models') return { data: [{ id: 'KAT-Coder-V2.5-Dev' }] }
    const messages = (body as { messages?: { role: string; content?: string }[] }).messages ?? []
    const last = messages[messages.length - 1]
    // Forced-JSON gates (contract, audits): an answer that parses and satisfies nothing, so
    // the gates stand down rather than fire — this is a look at the window, not at them.
    if ((body as { response_format?: unknown }).response_format !== undefined) return text('{}', 5)
    // Where the scenario is, read from the transcript itself rather than remembered: the
    // number of tool calls the model has made since the person's last message.
    let lastUser = 0
    for (const [i, m] of messages.entries()) {
      if (m.role === 'user' && !String(m.content).startsWith('[')) lastUser = i
    }
    step = messages.slice(lastUser).filter((m) => m.role === 'assistant' && Array.isArray((m as { tool_calls?: unknown[] }).tool_calls)).length
    if (last?.role !== 'tool' && last?.role !== 'user') step = 99
    switch (step) {
      case 0: return call('c1', 'read_file', { path: 'src/WinOptimizer/Core/Snapshot.cs' })
      case 1: return call('c2', 'edit_file', {
        path: 'src/WinOptimizer/Core/Snapshot.cs',
        search_text: '    public List<string> ClosedProcesses { get; set; } = new();  // history/display only',
        replace_text: '    public List<string> ClosedProcesses { get; set; } = new();  // history/display only\n    public DateTimeOffset SavedAt { get; set; }',
      })
      case 2: return call('c3', 'run_command', { commands: ['dotnet build src/WinOptimizer/WinOptimizer.csproj --no-restore --nologo -v q'] })
      default: return text(ANSWER)
    }
  })
  console.log(`fake model server: ${fake.url}`)

  const appData = join(tmpdir(), 'pc-ui-appdata')
  mkdirSync(appData, { recursive: true })
  const bridge = spawn(process.execPath, [
    join('core', 'node_modules', 'tsx', 'dist', 'cli.mjs'), join('core', 'src', 'host', 'ws-bridge.ts'),
    '--workspace', root, '--port', '8765',
  ], { env: { ...process.env, APPDATA: appData }, stdio: ['ignore', 'pipe', 'pipe'] })
  bridge.stdout.on('data', (d: Buffer) => {
    const text = d.toString()
    process.stdout.write(text)
    const m = /ws:\/\/[^\s]+token=[a-f0-9]+/.exec(text)
    if (m) console.log(`\nOPEN: http://localhost:1420/?ws=${encodeURIComponent(m[0])}\nworkspace copy: ${root}\nserver URL to enter: ${fake.url}\n`)
  })
  bridge.stderr.on('data', (d: Buffer) => process.stderr.write(d.toString()))
  bridge.on('exit', (code) => { console.log(`bridge exited ${code}`); process.exit(0) })
}

main().catch((e) => { console.error(e); process.exit(1) })
