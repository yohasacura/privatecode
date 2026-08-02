import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvents } from '../../src/agent/loop.js'
import type { ApprovalDecision, ApprovalRequest, InteractionPort, TodoItem } from '../../src/interaction.js'
import { LlamaClient } from '../../src/llama/client.js'
import { PermissionEngine } from '../../src/permissions/engine.js'
import { Session } from '../../src/session/session.js'
import { SessionStore } from '../../src/session/store.js'
import { createToolset } from '../../src/tools/default-set.js'
import { snapshotTree } from './helpers.js'

/**
 * Task 12's live acceptance suite: five behaviors the unit suite fakes with a scripted
 * server and a scripted port, run here against the real Qwen3.6 server so the fakes are
 * checked against reality. Each test builds its own workspace and its own `Session` --
 * `Session` (not the bare `Agent`) is what the real CLI drives, so this is the same path
 * a user's keystrokes go through, not just the loop underneath it.
 *
 * Kept to exactly the five cases the brief names: run_command through autopilot,
 * permission-deny steering, auto-edit non-consultation, todo_write in plan mode, and
 * session-resume continuity. Nothing else belongs in this file.
 */

const SERVER = process.env.PRIVATECODE_SERVER ?? 'http://127.0.0.1:8080'
const enabled = process.env.PRIVATECODE_INTEGRATION === '1'
const MODEL = 'Qwen3.6-35B-A3B'

const RUN_COMMAND_TASK =
  'Run the command "Get-ChildItem" and tell me how many entries it printed.'

interface CallRecord { name: string; args: string }

/** Mirrors real-model.test.ts's loggingEvents, plus recording every tool call by name so
 * the assertions below can check which tools actually ran without re-parsing console
 * output. */
function loggingEvents(label: string, calls: CallRecord[] = []): AgentEvents {
  return {
    onStepStart: (i) => console.log(`  [${label}] step ${i.step} start (budget ${i.timeoutMs} ms)`),
    onContinuation: (step) => console.log(`  [${label}] step ${step}: CONTINUATION (forcing an action)`),
    onStepDone: (i) => console.log(
      `  [${label}] step ${i.step} done: ${i.seconds.toFixed(1)}s` +
      `${i.tokensPerSecond ? `, ${i.tokensPerSecond.toFixed(1)} tok/s` : ''}` +
      `${i.continued ? ' [TRUNCATED, continued]' : ''}`,
    ),
    onToolCall: (name, args) => {
      calls.push({ name, args })
      console.log(`  [${label}] tool call: ${name} ${args.slice(0, 200)}`)
    },
    onToolResult: (name, r) =>
      console.log(`  [${label}] tool result (${name}, ok=${r.ok}): ${r.content.split('\n')[0]?.slice(0, 200)}`),
    onAssistantText: (t) => console.log(`  [${label}] assistant: ${t.slice(0, 300)}`),
  }
}

/** A port that fails the test the moment either method is actually invoked -- used to
 * prove a code path is never consulted, rather than merely asserting on a side effect of
 * it having run. */
function neverCalledPort(overrides: Partial<InteractionPort> = {}): InteractionPort {
  return {
    requestApproval: overrides.requestApproval ??
      (async () => { throw new Error('requestApproval must not be called here') }),
    askUser: overrides.askUser ??
      (async () => { throw new Error('askUser must not be called here') }),
    ...(overrides.todosChanged ? { todosChanged: overrides.todosChanged } : {}),
  }
}

describe.runIf(enabled)('Plan 2 live acceptance suite', () => {
  const tempDirs: string[] = []

  beforeAll(async () => {
    const client = new LlamaClient({ baseUrl: SERVER, model: MODEL })
    if (!(await client.health())) {
      throw new Error(
        `llama.cpp is not reachable at ${SERVER}. Start the server and wait for it to be ` +
        'RUNNING before running this suite.',
      )
    }
  })

  afterAll(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function newWorkspace(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix))
    tempDirs.push(root)
    return root
  }

  // -------------------------------------------------------------------------
  // 1. run_command through the model, in autopilot -- no interactive port at all.
  // -------------------------------------------------------------------------
  test('autopilot runs a shell command through the model without any approval port',
    { timeout: 120_000 }, async () => {
    const root = newWorkspace('pc-plan2-autopilot-')
    writeFileSync(join(root, 'alpha.txt'), 'a\n')
    writeFileSync(join(root, 'beta.txt'), 'b\n')
    mkdirSync(join(root, 'sub'))

    const toolset = createToolset()
    // An engine IS present -- this proves autopilot's real modeDefault ('allow' with no
    // ask at all, engine.ts) rather than the degenerate case of no permissions object.
    const engine = new PermissionEngine({ layers: [], mode: 'autopilot', workspaceRoot: root })
    const calls: CallRecord[] = []

    const session = new Session({
      client: new LlamaClient({ baseUrl: SERVER, model: MODEL }),
      toolset,
      workspaceRoot: root,
      mode: 'autopilot',
      engine,
      // No `interaction` at all: autopilot must never need one.
      maxSteps: 12,
      events: loggingEvents('autopilot', calls),
    })

    const started = Date.now()
    const result = await session.send(RUN_COMMAND_TASK)
    console.log(
      `\n[autopilot] stoppedBecause=${result.stoppedBecause}, steps=${result.steps}, ` +
      `wall=${((Date.now() - started) / 1000).toFixed(1)}s`,
    )
    console.log(`[autopilot] final text: ${result.finalText.slice(0, 300)}`)

    expect(result.stoppedBecause).toBe('done')
    expect(calls.some((c) => c.name === 'run_command')).toBe(true)
    expect(result.finalText.trim()).not.toBe('')
  })

  // -------------------------------------------------------------------------
  // 2. permission deny reaches the model and steers its next move.
  // -------------------------------------------------------------------------
  test('a scripted permission denial steers the model away from the shell command',
    { timeout: 120_000 }, async () => {
    const root = newWorkspace('pc-plan2-deny-')
    writeFileSync(join(root, 'alpha.txt'), 'a\n')
    writeFileSync(join(root, 'beta.txt'), 'b\n')
    const before = snapshotTree(root)

    const toolset = createToolset()
    const engine = new PermissionEngine({ layers: [], mode: 'normal', workspaceRoot: root })
    const calls: CallRecord[] = []
    const approvalRequests: ApprovalRequest[] = []

    const interaction = neverCalledPort({
      requestApproval: async (req: ApprovalRequest): Promise<ApprovalDecision> => {
        approvalRequests.push(req)
        return { verdict: 'deny', comment: 'use list_dir instead of a shell command' }
      },
    })

    const session = new Session({
      client: new LlamaClient({ baseUrl: SERVER, model: MODEL }),
      toolset,
      workspaceRoot: root,
      mode: 'normal',
      engine,
      interaction,
      maxSteps: 12,
      events: loggingEvents('deny', calls),
    })

    const started = Date.now()
    const result = await session.send(RUN_COMMAND_TASK)
    console.log(
      `\n[deny] stoppedBecause=${result.stoppedBecause}, steps=${result.steps}, ` +
      `wall=${((Date.now() - started) / 1000).toFixed(1)}s`,
    )
    console.log(`[deny] final text: ${result.finalText.slice(0, 300)}`)

    // The deny really happened, through normal mode's real 'ask' verdict for run_command.
    expect(approvalRequests.length).toBeGreaterThan(0)
    expect(calls.some((c) => c.name === 'run_command')).toBe(true)

    // Either proves the deny text steered it: the model tries the suggested tool, or it
    // gives up and says so in its closing prose.
    const triedListDir = calls.some((c) => c.name === 'list_dir')
    const acknowledgedRefusal = /declin|refus|denied|permission|not allowed|cannot run|couldn't run|blocked/i
      .test(result.finalText)
    console.log(`[deny] triedListDir=${triedListDir}, acknowledgedRefusal=${acknowledgedRefusal}`)
    expect(triedListDir || acknowledgedRefusal).toBe(true)

    // The denied command must never have actually run.
    const after = snapshotTree(root)
    expect(after.files).toEqual(before.files)
    expect(after.hash).toBe(before.hash)
  })

  // -------------------------------------------------------------------------
  // 3. auto-edit mode edits without ever consulting the approval port.
  // -------------------------------------------------------------------------
  test('auto-edit mode fixes a real typo without consulting the approval port',
    { timeout: 120_000 }, async () => {
    const root = newWorkspace('pc-plan2-autoedit-')
    const ORIGINAL = 'This sentance has a typo in it.\n'
    writeFileSync(join(root, 'typo.txt'), ORIGINAL)

    const toolset = createToolset()
    const engine = new PermissionEngine({ layers: [], mode: 'auto-edit', workspaceRoot: root })
    const calls: CallRecord[] = []
    let approvalCalled = false

    // requestApproval both flips the flag AND throws: if auto-edit's own decide() ever
    // regressed to 'ask' for a file-write tool, this proves it two ways at once -- the
    // flag survives even though the throw is caught and reported as a failed tool call
    // by loop.ts's own gate try/catch, so the test does not merely rely on an uncaught
    // exception to fail loudly.
    const interaction = neverCalledPort({
      requestApproval: async (): Promise<ApprovalDecision> => {
        approvalCalled = true
        throw new Error('requestApproval must not be called in auto-edit mode')
      },
    })

    const session = new Session({
      client: new LlamaClient({ baseUrl: SERVER, model: MODEL }),
      toolset,
      workspaceRoot: root,
      mode: 'auto-edit',
      engine,
      interaction,
      maxSteps: 12,
      events: loggingEvents('auto-edit', calls),
    })

    const started = Date.now()
    const result = await session.send(
      'There is a spelling mistake in typo.txt: "sentance" should be "sentence". Fix it. ' +
      'Change only that file.',
    )
    console.log(
      `\n[auto-edit] stoppedBecause=${result.stoppedBecause}, steps=${result.steps}, ` +
      `wall=${((Date.now() - started) / 1000).toFixed(1)}s`,
    )
    console.log(`[auto-edit] final text: ${result.finalText.slice(0, 300)}`)

    const after = readFileSync(join(root, 'typo.txt'), 'utf8')
    console.log(`[auto-edit] file after run: ${after}`)

    expect(approvalCalled).toBe(false)
    expect(after).not.toBe(ORIGINAL)
    expect(after.toLowerCase()).toContain('sentence')
    expect(after.toLowerCase()).not.toContain('sentance')
  })

  // -------------------------------------------------------------------------
  // 4. todo_write in plan mode: the plan is recorded, the tree is untouched.
  // -------------------------------------------------------------------------
  test('plan mode records a todo-list plan and touches nothing on disk',
    { timeout: 120_000 }, async () => {
    const root = newWorkspace('pc-plan2-plantodo-')
    mkdirSync(join(root, 'src'))
    writeFileSync(
      join(root, 'src', 'foo.ts'),
      'export function foo(x: number): number {\n' +
      '  return x + 1\n' +
      '}\n\n' +
      'export function useFoo(): number {\n' +
      '  return foo(41)\n' +
      '}\n',
    )

    const toolset = createToolset()
    const calls: CallRecord[] = []
    const todosEvents: TodoItem[][] = []

    const interaction = neverCalledPort({
      todosChanged: (todos: readonly TodoItem[]) => { todosEvents.push([...todos]) },
    })

    const session = new Session({
      client: new LlamaClient({ baseUrl: SERVER, model: MODEL }),
      toolset,
      workspaceRoot: root,
      mode: 'plan',
      interaction,
      maxSteps: 12,
      events: loggingEvents('plan-todo', calls),
    })

    const before = snapshotTree(root)
    const started = Date.now()
    const result = await session.send(
      'Plan how you would rename function foo to bar across this workspace. Record your ' +
      'plan with todo_write, do not change anything.',
    )
    console.log(
      `\n[plan-todo] stoppedBecause=${result.stoppedBecause}, steps=${result.steps}, ` +
      `wall=${((Date.now() - started) / 1000).toFixed(1)}s`,
    )
    console.log(`[plan-todo] final text: ${result.finalText.slice(0, 300)}`)
    const after = snapshotTree(root)

    expect(result.stoppedBecause).toBe('done')
    expect(todosEvents.length).toBeGreaterThan(0)
    expect(todosEvents.some((t) => t.length >= 2)).toBe(true)
    // Listing first, so a failure names the file that appeared instead of printing two
    // hex digests; the hash then covers content changes the listing cannot see.
    expect(after.files).toEqual(before.files)
    expect(after.hash).toBe(before.hash)
  })

  // -------------------------------------------------------------------------
  // 5. session-resume continuity.
  // -------------------------------------------------------------------------
  test('a resumed session remembers what an earlier turn was told',
    { timeout: 180_000 }, async () => {
    const root = newWorkspace('pc-plan2-resume-')
    const store = new SessionStore(root)
    const toolset = createToolset()

    const session1 = new Session({
      client: new LlamaClient({ baseUrl: SERVER, model: MODEL }),
      toolset,
      workspaceRoot: root,
      mode: 'normal',
      store,
      maxSteps: 8,
      events: loggingEvents('resume-1'),
    })

    const started1 = Date.now()
    const result1 = await session1.send('Remember this codeword: PARSNIP. Just acknowledge.')
    console.log(
      `\n[resume-1] stoppedBecause=${result1.stoppedBecause}, steps=${result1.steps}, ` +
      `wall=${((Date.now() - started1) / 1000).toFixed(1)}s`,
    )
    console.log(`[resume-1] final text: ${result1.finalText.slice(0, 300)}`)

    const sessionId = session1.id

    const session2 = new Session({
      client: new LlamaClient({ baseUrl: SERVER, model: MODEL }),
      toolset,
      workspaceRoot: root,
      store,
      resume: sessionId,
      maxSteps: 8,
      events: loggingEvents('resume-2'),
    })

    const started2 = Date.now()
    const result2 = await session2.send('What was the codeword? Answer with the single word.')
    console.log(
      `\n[resume-2] stoppedBecause=${result2.stoppedBecause}, steps=${result2.steps}, ` +
      `wall=${((Date.now() - started2) / 1000).toFixed(1)}s`,
    )
    console.log(`[resume-2] final text: ${result2.finalText.slice(0, 300)}`)

    expect(result2.finalText.toUpperCase()).toContain('PARSNIP')
  })
})
