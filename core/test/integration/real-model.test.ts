import { beforeAll, describe, expect, test } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent, type StepInfo, type StepStartInfo } from '../../src/agent/loop.js'
import { LlamaClient } from '../../src/llama/client.js'
import { Workspace } from '../../src/workspace.js'
import { buildRegistry } from '../../src/tools/default-set.js'

const SERVER = process.env.PRIVATECODE_SERVER ?? 'http://127.0.0.1:8080'
const enabled = process.env.PRIVATECODE_INTEGRATION === '1'

const ORIGINAL_SLUG =
  'export function slugify(title: string): string {\n' +
  '  return title.toLowerCase().replace(/ /g, "-")\n' +
  '}\n'

describe.runIf(enabled)('against the real Qwen3.6 server', () => {
  let root: string

  beforeAll(async () => {
    const client = new LlamaClient({ baseUrl: SERVER, model: 'Qwen3.6-35B-A3B' })
    if (!(await client.health())) {
      throw new Error(
        `llama.cpp is not reachable at ${SERVER}. Start D:\\LocalAgentAI\\Start-QwenServer.bat ` +
        'and wait for the dashboard to show RUNNING before running this test.',
      )
    }
  })

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'pc-int-'))
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'slug.ts'), ORIGINAL_SLUG)
  })

  /**
   * Prints exactly what Task 12's brief asks the run to report: per-step wall time,
   * tok/s, and whether a step continued after truncation. Nothing here is asserted on —
   * it is the human-readable record of what the live model actually did.
   */
  function loggingEvents(label: string) {
    return {
      onStepStart: (i: StepStartInfo) =>
        console.log(`  [${label}] step ${i.step} start (budget ${i.timeoutMs} ms)`),
      onContinuation: (step: number) =>
        console.log(`  [${label}] step ${step}: CONTINUATION (ran out of room, forcing action)`),
      onStepDone: (i: StepInfo) =>
        console.log(
          `  [${label}] step ${i.step} done: ${i.seconds.toFixed(1)}s` +
          `${i.tokensPerSecond ? `, ${i.tokensPerSecond.toFixed(1)} tok/s` : ''}` +
          `${i.completionTokens ? `, ${i.completionTokens} completion tokens` : ''}` +
          `${i.continued ? ' [TRUNCATED, continued]' : ''}`,
        ),
      onToolCall: (name: string, args: string) =>
        console.log(`  [${label}] tool call: ${name} ${args.slice(0, 200)}`),
      onToolResult: (name: string, r: { ok: boolean; content: string }) =>
        console.log(`  [${label}] tool result (${name}, ok=${r.ok}): ${r.content.split('\n')[0]?.slice(0, 200)}`),
      onAssistantText: (t: string) => console.log(`  [${label}] assistant: ${t.slice(0, 300)}`),
    }
  }

  // Deliberately does NOT pass allowedTools for mode: 'plan'. That omission is exactly
  // the configuration a reviewer showed writes to disk anyway — this proves Agent's own
  // derivation (loop.ts, mode === 'plan') closes it for real, against the live server and
  // its real grammar, not just against the fake server in the unit suite.
  function agent(mode: 'normal' | 'plan', label: string) {
    return new Agent({
      client: new LlamaClient({ baseUrl: SERVER, model: 'Qwen3.6-35B-A3B' }),
      registry: buildRegistry(),
      context: { workspace: new Workspace(root) },
      mode,
      maxSteps: 12,
      events: loggingEvents(label),
    })
  }

  test('finds and edits a real file', { timeout: 600_000 }, async () => {
    const started = Date.now()
    const result = await agent('normal', 'edit').runTurn(
      'In src/slug.ts, make slugify also strip characters that are not letters, digits or ' +
      'hyphens, after lowercasing. Change only that file.',
    )
    const elapsed = (Date.now() - started) / 1000

    console.log(
      `\n[edit] stoppedBecause=${result.stoppedBecause}, steps=${result.steps}, ` +
      `wall=${elapsed.toFixed(1)}s`,
    )
    console.log(`[edit] final text: ${result.finalText.slice(0, 300)}`)

    // The widened stoppedBecause vocabulary ('timeout' | 'truncated' are real outcomes on
    // a slow local model, not exotic errors) means the interesting fact is not which
    // label the turn ended on, but whether the edit actually happened. Report the label,
    // don't gate on one specific value.
    const after = readFileSync(join(root, 'src', 'slug.ts'), 'utf8')
    console.log(`[edit] file after run:\n${after}`)

    expect(after).toMatch(/replace\(/)
    expect(after).not.toBe(ORIGINAL_SLUG)
  })

  test('plan mode cannot write, because the tools are not offered',
    { timeout: 600_000 }, async () => {
    const before = readFileSync(join(root, 'src', 'slug.ts'), 'utf8')
    const started = Date.now()
    const result = await agent('plan', 'plan').runTurn('Add JSDoc to slugify.')
    const elapsed = (Date.now() - started) / 1000

    console.log(
      `\n[plan] stoppedBecause=${result.stoppedBecause}, steps=${result.steps}, ` +
      `wall=${elapsed.toFixed(1)}s`,
    )
    console.log(`[plan] final text: ${result.finalText.slice(0, 300)}`)

    const after = readFileSync(join(root, 'src', 'slug.ts'), 'utf8')
    // The observable outcome that actually matters: the file is byte-identical,
    // regardless of how the turn itself ended.
    expect(after).toBe(before)
  })
})
