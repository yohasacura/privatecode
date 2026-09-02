import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { LlamaClient } from '../src/llama/client.js'
import { Session } from '../src/session/session.js'
import { SessionStore } from '../src/session/store.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { Toolset } from '../src/tools/default-set.js'
import { startFakeServer } from './fake-server.js'
import type { Tool } from '../src/tools/types.js'

/**
 * The model running the project's own check IS the check.
 *
 * Watched live: every write cycle ended with the model asking to run exactly the configured
 * verify command, after which the write-boundary check ran the SAME command over the SAME
 * bytes — in one recorded cycle the command ran four times. The model saw the output; the
 * question is answered, and `noteModelRanVerify` records it so the end-of-turn pass does
 * not repeat it.
 *
 * Since the boundary check moved to right after the step that wrote (session.ts,
 * `verifyMidTurn`), the order is the other way round: the harness answers first, and a
 * model that still runs the command by hand is the one repeating the question — which the
 * prompt now tells it not to do. What must not happen is a THIRD run at the end of the turn.
 */

let stop: (() => Promise<void>) | undefined
const dirs: string[] = []
afterEach(async () => {
  await stop?.()
  stop = undefined
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Appends one byte to runs.txt each time the check executes, wherever it is run from. */
const VERIFY_CMD = 'node -e "require(\'fs\').appendFileSync(\'runs.txt\',\'x\')"'

function fakeTool(name: string, content: string): Tool<Record<string, unknown>> {
  return {
    name,
    readOnly: false,
    description: name,
    parameters: { type: 'object', properties: {} },
    validate: (args) => ({ ok: true, args: args as Record<string, unknown> }),
    execute: async () => ({ ok: true, content }),
  }
}

test("the model's own successful run of the verify command replaces the automatic one", async () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-verify-dedup-'))
  dirs.push(root)

  const registry = new ToolRegistry()
  registry.register(fakeTool('Write', 'wrote a.txt'))
  // The fake Bash REALLY runs the check, like the live tool would: the byte it
  // appends is the model's run, and any byte after it is the app repeating the question.
  registry.register({
    name: 'Bash',
    readOnly: false,
    description: 'run',
    parameters: { type: 'object', properties: {} },
    validate: (args) => ({ ok: true, args: args as Record<string, unknown> }),
    execute: async () => {
      const { execSync } = await import('node:child_process')
      execSync(VERIFY_CMD, { cwd: root })
      return { ok: true, content: 'exit 0 in 0.1 s' }
    },
  } as Tool<Record<string, unknown>>)

  let call = 0
  const fake = await startFakeServer((_body, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: 131_072 } }
    if (req.url === '/health') return { status: 'ok' }
    call++
    if (call === 1) {
      return {
        choices: [{
          message: {
            role: 'assistant', content: null,
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Write', arguments: '{"path":"a.txt","content":"hi"}' } }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 1_000, completion_tokens: 10 },
      }
    }
    if (call === 2) {
      return {
        choices: [{
          message: {
            role: 'assistant', content: null,
            tool_calls: [{ id: 'c2', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: VERIFY_CMD }) } }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 1_200, completion_tokens: 10 },
      }
    }
    return {
      choices: [{ message: { role: 'assistant', content: 'done, checks pass' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1_400, completion_tokens: 5 },
    }
  })
  stop = fake.close

  const session = new Session({
    client: new LlamaClient({ baseUrl: fake.url, model: 'm' }),
    toolset: { registry } as Toolset,
    workspaceRoot: root,
    mode: 'autopilot',
    store: new SessionStore(root),
    verify: { command: VERIFY_CMD, timeoutMs: 20_000, source: 'test' },
  })
  const result = await session.send('change a.txt and check it')
  expect(result.stoppedBecause).toBe('done')

  // The boundary check right after the write, then the model's own run — and nothing at the
  // end of the turn, because the question was answered twice over by then. Before
  // `noteModelRanVerify` this file held one byte more.
  expect(readFileSync(join(root, 'runs.txt'), 'utf8')).toBe('xx')
})
