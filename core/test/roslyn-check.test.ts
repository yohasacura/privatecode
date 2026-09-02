import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session } from '../src/session/session.js'
import { LlamaClient } from '../src/llama/client.js'
import { createToolset } from '../src/tools/default-set.js'
import { PermissionEngine } from '../src/permissions/engine.js'
import { startFakeServer } from './fake-server.js'
import type { CsharpDiagnostics } from '../src/csharp/nav-process.js'

/**
 * The instant C# check: after an edit to a .cs file the session asks the Roslyn helper for
 * the compilation's errors instead of running the build, which on the projects this is
 * measured against is 300 ms instead of 2–10 s per edit. The build still runs once when
 * the turn ends — the helper's compilation is faithful enough to say "you broke X" and not
 * faithful enough to replace the owner's command.
 *
 * The helper is injected here so this pins the SESSION's behaviour; what the helper answers
 * is pinned against a real tree in `roslyn-nav.test.ts`.
 */

let root: string
let stop: (() => Promise<void>) | undefined
const roots: string[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-roslyn-check-'))
  roots.push(root)
  mkdirSync(join(root, '.privatecode'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
})
afterEach(async () => {
  await stop?.()
  stop = undefined
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true })
})

const usage = { prompt_tokens: 100, completion_tokens: 5 }
const write = (n: number, path: string) => ({
  choices: [{
    message: {
      role: 'assistant',
      tool_calls: [{
        id: `c${n}`, type: 'function',
        function: { name: 'Write', arguments: JSON.stringify({ path, content: `// ${n}\n` }) },
      }],
    },
    finish_reason: 'tool_calls',
  }],
  usage,
})
const done = { choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage }

function clean(): CsharpDiagnostics {
  return { errors: [], reported: 0, suppressed: 0, baseline: 0, bound: 1, trees: 3, ms: 12 }
}

function broken(file: string): CsharpDiagnostics {
  return {
    errors: [{ file, line: 3, column: 9, code: 'CS0103', message: "The name 'x' does not exist in the current context" }],
    reported: 1, suppressed: 0, baseline: 0, bound: 1, trees: 3, ms: 15,
  }
}

async function run(opts: {
  check: (root: string, files: string[]) => Promise<CsharpDiagnostics | null>
  writes: string[]
}): Promise<{ seen: { command: string; ok: boolean }[]; prompts: string[]; asked: string[][] }> {
  let call = 0
  const prompts: string[] = []
  const fake = await startFakeServer((body, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: 8000 } }
    if (req.url === '/health') return { status: 'ok' }
    const messages = (body as { messages?: { role: string; content?: string }[] }).messages ?? []
    for (const m of messages) if (m.role === 'user' && typeof m.content === 'string') prompts.push(m.content)
    call++
    const path = opts.writes[call - 1]
    return path !== undefined ? write(call, path) : done
  })
  stop = fake.close
  const seen: { command: string; ok: boolean }[] = []
  const asked: string[][] = []
  const session = new Session({
    client: new LlamaClient({ baseUrl: fake.url, model: 'm' }),
    toolset: createToolset({}),
    workspaceRoot: root,
    mode: 'autopilot',
    engine: new PermissionEngine({ layers: [], mode: 'autopilot', workspaceRoot: root }),
    verify: { command: 'cmd /c exit 0', timeoutMs: 30_000, source: 'test' },
    onVerify: (info) => seen.push({ command: info.command, ok: info.ok }),
    csharpCheck: async (r, files) => {
      asked.push(files)
      return opts.check(r, files)
    },
  })
  await session.send('write some files')
  return { seen, prompts: [...new Set(prompts)], asked }
}

test('an edit to a .cs file is checked by the compiler, and the build waits for the end of the turn', async () => {
  const { seen, prompts, asked } = await run({ check: async () => clean(), writes: ['src/A.cs', 'src/B.cs'] })
  // Two writes, two instant checks; the build once, at the end.
  expect(asked).toHaveLength(2)
  expect(asked[0]!.map((f) => f.replace(/\\/g, '/'))).toEqual([join(root, 'src', 'A.cs').replace(/\\/g, '/')])
  const builds = seen.filter((s) => s.command === 'cmd /c exit 0')
  expect(builds).toHaveLength(1)
  expect(seen.filter((s) => s.command === 'C# compiler check')).toHaveLength(2)
  // The model reads the verdict as one line, once — "still fine" is not repeated.
  expect(prompts.filter((p) => p.startsWith('[C# compiler check: ok'))).toHaveLength(1)
})

test('errors reach the model with the file, line and code, addressed the way it addresses files', async () => {
  const file = join(root, 'src', 'A.cs')
  const { prompts } = await run({ check: async () => broken(file), writes: ['src/A.cs'] })
  const note = prompts.find((p) => p.includes('C# compiler check') && p.includes('CS0103'))
  expect(note).toBeDefined()
  expect(note).toContain('src/A.cs:3:9: CS0103')
  expect(note).not.toContain(root)
})

test('a helper that cannot answer leaves the build to do what it always did', async () => {
  const { seen, asked } = await run({ check: async () => null, writes: ['src/A.cs'] })
  expect(asked).toHaveLength(1)
  // Mid-turn build plus the end-of-turn one is deduplicated to one passing run; the point
  // is that a build RAN rather than the edit going unchecked.
  expect(seen.some((s) => s.command === 'cmd /c exit 0' && s.ok)).toBe(true)
  expect(seen.some((s) => s.command === 'C# compiler check')).toBe(false)
})

test('a turn that also edits something that is not C# runs the build, not the compiler check', async () => {
  const { seen, asked } = await run({ check: async () => clean(), writes: ['src/A.cs', 'README.md'] })
  // The first write is C# alone and is checked instantly; the second batch has a .md in it,
  // and a compiler check would say nothing about that file.
  expect(asked).toHaveLength(1)
  expect(seen.filter((s) => s.command === 'cmd /c exit 0').length).toBeGreaterThanOrEqual(1)
})
