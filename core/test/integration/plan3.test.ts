import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent, type AgentEvents, type StepInfo, type StepStartInfo } from '../../src/agent/loop.js'
import { TodoStore } from '../../src/interaction.js'
import { LlamaClient } from '../../src/llama/client.js'
import { PermissionEngine } from '../../src/permissions/engine.js'
import { COMPACTION_BRIEFING_PREFIX } from '../../src/session/compaction.js'
import { Session, type CompactionEvent } from '../../src/session/session.js'
import { SessionStore } from '../../src/session/store.js'
import { BackgroundTasks } from '../../src/tools/background-task.js'
import { createToolset, buildRegistry, type Toolset } from '../../src/tools/default-set.js'
import { ToolRegistry } from '../../src/tools/registry.js'
import { Workspace } from '../../src/workspace.js'

/**
 * Task 10's live acceptance gate for Plan 3 (streaming, interrupt, compaction): the fakes
 * a unit suite can script (a scripted SSE server, a scripted abort) are checked here
 * against the real Qwen3.6 server, exactly like plan2.test.ts did for Plan 2 and
 * real-model.test.ts did for Plan 1. Running this file re-runs those two as well (all
 * three live in test/integration/, all under vitest.integration.config.ts) -- the brief's
 * "ALL must pass" covers all 14, not just the five new cases below.
 *
 * Kept to exactly the five cases the brief names:
 *   1. a Session-driven streaming edit, deltas captured before the step completes
 *   2. mid-thought interrupt, partial + marker preserved, a follow-up completes normally
 *   3. the squeezed-budget (maxTokensPerStep 96) truncation-continuation, through chatStream
 *   4. background auto-compaction end-to-end: trigger, briefing, swap, post-swap recall
 *   5. contextUsage().promptTokens cross-checked against an independent server request
 * Nothing else belongs in this file.
 */

const SERVER = process.env.PRIVATECODE_SERVER ?? 'http://127.0.0.1:8080'
const enabled = process.env.PRIVATECODE_INTEGRATION === '1'
const MODEL = 'Qwen3.6-35B-A3B'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Polls `events` (a live array `onCompaction` pushes onto) until one of `states` shows up
 * or `timeoutMs` elapses -- the background compaction promise settles on its own schedule,
 * off any `send()` call, so there is nothing else to await here. */
async function waitForCompactionState(
  events: CompactionEvent[], states: ReadonlyArray<CompactionEvent['state']>, timeoutMs: number,
): Promise<CompactionEvent | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hit = events.find((e) => states.includes(e.state))
    if (hit || Date.now() >= deadline) return hit
    await sleep(300)
  }
}

describe.runIf(enabled)('Plan 3 live acceptance suite', () => {
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
  // 1. Streaming turn: a Session-driven simple edit, deltas captured before the step ends.
  // -------------------------------------------------------------------------
  test(
    'streaming turn: a Session-driven edit streams >= 10 deltas before the step completes',
    { timeout: 150_000 },
    async () => {
      const root = newWorkspace('pc-plan3-stream-edit-')
      const ORIGINAL = 'This sentance has a typo in it.\n'
      writeFileSync(join(root, 'typo.txt'), ORIGINAL)

      const toolset = createToolset()
      const engine = new PermissionEngine({ layers: [], mode: 'auto-edit', workspaceRoot: root })

      interface DeltaMark { step: number; at: number }
      const deltas: DeltaMark[] = []
      const stepDoneAt = new Map<number, number>()
      let currentStep = 0

      const events: AgentEvents = {
        onStepStart: (i) => {
          currentStep = i.step
          console.log(`  [stream-edit] step ${i.step} start (budget ${i.timeoutMs} ms)`)
        },
        onThinkingDelta: () => { deltas.push({ step: currentStep, at: Date.now() }) },
        onTextDelta: () => { deltas.push({ step: currentStep, at: Date.now() }) },
        onStepDone: (i) => {
          stepDoneAt.set(i.step, Date.now())
          console.log(`  [stream-edit] step ${i.step} done: ${i.seconds.toFixed(1)}s`)
        },
        onToolCall: (n, a) => console.log(`  [stream-edit] tool call: ${n} ${a.slice(0, 200)}`),
        onAssistantText: (t) => console.log(`  [stream-edit] assistant: ${t.slice(0, 200)}`),
      }

      const session = new Session({
        client: new LlamaClient({ baseUrl: SERVER, model: MODEL }),
        toolset,
        workspaceRoot: root,
        mode: 'auto-edit',
        engine,
        maxSteps: 8,
        events,
      })

      const started = Date.now()
      const result = await session.send(
        'There is a spelling mistake in typo.txt: "sentance" should be "sentence". Fix it. ' +
        'Change only that file.',
      )
      const elapsed = (Date.now() - started) / 1000
      console.log(
        `\n[stream-edit] stoppedBecause=${result.stoppedBecause}, steps=${result.steps}, ` +
        `wall=${elapsed.toFixed(1)}s, total deltas=${deltas.length}`,
      )

      // The deltas that matter are the ones tied to step 1 -- the brief's "BEFORE step
      // completion" -- so this checks the timestamped ordering directly rather than just
      // counting deltas anywhere in the whole turn.
      const doneAt1 = stepDoneAt.get(1)
      expect(doneAt1, 'step 1 never completed').toBeDefined()
      const beforeStep1Done = deltas.filter((d) => d.step === 1 && d.at <= doneAt1!)
      console.log(`[stream-edit] deltas before step 1's onStepDone: ${beforeStep1Done.length}`)
      expect(beforeStep1Done.length).toBeGreaterThanOrEqual(10)

      expect(result.finalText.trim()).not.toBe('')

      const after = readFileSync(join(root, 'typo.txt'), 'utf8')
      console.log(`[stream-edit] file after run: ${after}`)
      expect(after).not.toBe(ORIGINAL)
      expect(after.toLowerCase()).toContain('sentence')
      expect(after.toLowerCase()).not.toContain('sentance')
    },
  )

  // -------------------------------------------------------------------------
  // 2. Interrupt: abort mid-thought, the partial + marker survive, then a clean follow-up.
  // -------------------------------------------------------------------------
  test(
    'interrupt: aborting mid-thought preserves the partial with an [interrupted marker, ' +
    'then a follow-up send completes normally',
    { timeout: 120_000 },
    async () => {
      const root = newWorkspace('pc-plan3-interrupt-')
      const store = new SessionStore(root)
      const toolset = createToolset()
      const engine = new PermissionEngine({ layers: [], mode: 'normal', workspaceRoot: root })

      const controller = new AbortController()
      let firstDeltaAt: number | undefined

      const session = new Session({
        client: new LlamaClient({ baseUrl: SERVER, model: MODEL }),
        toolset,
        workspaceRoot: root,
        mode: 'normal',
        engine,
        store,
        maxSteps: 8,
        events: {
          onThinkingDelta: () => {
            // Abort exactly once, 2 s after the FIRST thinking delta arrives -- the
            // brief's "abort at first thinking delta + 2 s". Later deltas re-trigger
            // nothing: firstDeltaAt guards this to a single setTimeout.
            if (firstDeltaAt === undefined) {
              firstDeltaAt = Date.now()
              setTimeout(() => controller.abort(), 2000)
            }
          },
        },
      })

      const LONG_THINK_TASK =
        'Before doing anything else, think through in detail at least ten different ' +
        'possible strategies for finding every call site of a function across a large ' +
        'codebase, weighing the tradeoffs of each one carefully, one at a time. Do not ' +
        'call any tool and do not give your final answer until you have finished ' +
        'analyzing all ten.'

      const started = Date.now()
      const result = await session.send(LONG_THINK_TASK, controller.signal)
      const elapsed = (Date.now() - started) / 1000
      console.log(
        `\n[interrupt] stoppedBecause=${result.stoppedBecause}, steps=${result.steps}, ` +
        `wall=${elapsed.toFixed(1)}s`,
      )
      expect(firstDeltaAt, 'no thinking delta ever arrived to abort on').toBeDefined()
      expect(result.stoppedBecause).toBe('aborted')

      const { transcript } = store.load(session.id)
      const msgs = transcript.messages()
      const last = msgs[msgs.length - 1]
      console.log(
        `[interrupt] last transcript message: role=${last?.role}, ` +
        `content=${(last?.content ?? '').slice(0, 200)}, ` +
        `reasoning_len=${last?.reasoning_content?.length ?? 0}`,
      )
      // appendInterrupted (loop.ts) puts the marker in `content` and the actual partial
      // reasoning text in `reasoning_content` -- an abort caught this early is almost
      // always still mid-thought with no visible content yet, so the marker alone (with
      // no prefix text) in `content` is the expected shape, and the partial itself lives
      // in `reasoning_content`.
      expect(last?.role).toBe('assistant')
      expect(last?.content ?? '').toContain('[interrupted')
      expect((last?.reasoning_content ?? '').length).toBeGreaterThan(0)

      // A follow-up send on the SAME session completes normally.
      const result2 = await session.send('Just reply with the single word "ok".')
      console.log(
        `[interrupt] follow-up stoppedBecause=${result2.stoppedBecause}, ` +
        `finalText=${result2.finalText.slice(0, 100)}`,
      )
      expect(result2.stoppedBecause).toBe('done')
      expect(result2.finalText.trim()).not.toBe('')
    },
  )

  // -------------------------------------------------------------------------
  // 3. Continuation streamed: the squeezed-budget truncation-continuation, via chatStream.
  // -------------------------------------------------------------------------
  test(
    'continuation streamed: the squeezed-budget (maxTokensPerStep 96) truncation-' +
    'continuation still works through the streaming path',
    { timeout: 150_000 },
    async () => {
      const root = newWorkspace('pc-plan3-trunc-stream-')
      mkdirSync(join(root, 'src'))
      const TOKENIZER_SRC =
        'export function unescapeBody(body: string): string {\n' +
        '  return body.replace(/\\\\(.)/g, (_match, ch: string) => {\n' +
        '    if (ch === "n") return "\\n"\n' +
        '    if (ch === "t") return "\\t"\n' +
        '    return ch\n' +
        '  })\n' +
        '}\n'
      writeFileSync(join(root, 'src', 'tok.ts'), TOKENIZER_SRC)

      interface RunRecord { continuations: number[]; steps: StepInfo[] }
      const record: RunRecord = { continuations: [], steps: [] }
      let sawContinuation = false
      let deltasBefore = 0
      let deltasAfter = 0

      const agent = new Agent({
        client: new LlamaClient({ baseUrl: SERVER, model: MODEL }),
        registry: buildRegistry(),
        context: { workspace: new Workspace(root) },
        // Far below anything the model can finish a thought in, so finish_reason 'length'
        // -- and therefore the continuation -- is certain rather than hoped for. Note
        // toolChoice is left at Agent's own default ('auto'), per the brief.
        maxTokensPerStep: 96,
        maxSteps: 2,
        events: {
          onStepStart: (i: StepStartInfo) =>
            console.log(`  [trunc-stream] step ${i.step} start (budget ${i.timeoutMs} ms)`),
          onContinuation: (step: number) => {
            sawContinuation = true
            record.continuations.push(step)
            console.log(`  [trunc-stream] step ${step}: CONTINUATION (forcing an action)`)
          },
          onStepDone: (i: StepInfo) => {
            record.steps.push(i)
            console.log(
              `  [trunc-stream] step ${i.step} done: ${i.seconds.toFixed(1)}s` +
              `${i.continued ? ' [TRUNCATED, continued]' : ''}`,
            )
          },
          // Presence alone switches Agent.chat() onto chatStream() -- see loop.ts.
          onThinkingDelta: () => { if (sawContinuation) deltasAfter++; else deltasBefore++ },
          onTextDelta: () => { if (sawContinuation) deltasAfter++; else deltasBefore++ },
        },
      })

      const result = await agent.runTurn(
        'In src/tok.ts, work out whether the escape handling in unescapeBody is correct ' +
        'for a backslash at the very end of a string body, and fix it if it is not.',
      )
      console.log(
        `\n[trunc-stream] stoppedBecause=${result.stoppedBecause}, steps=${result.steps}, ` +
        `continuations=${record.continuations.length}`,
      )
      console.log(
        `[trunc-stream] deltas before continuation=${deltasBefore}, after=${deltasAfter}`)
      console.log(`[trunc-stream] final text: ${result.finalText.slice(0, 200)}`)

      // The continuation really fired, through the streaming path both times: deltas
      // arrived for the first (truncated) call AND for the forced continuation, not just
      // one of the two.
      expect(record.continuations.length).toBeGreaterThan(0)
      expect(record.steps.some((s) => s.continued)).toBe(true)
      expect(deltasBefore).toBeGreaterThan(0)
      expect(deltasAfter).toBeGreaterThan(0)
      expect(['truncated', 'done', 'max_steps']).toContain(result.stoppedBecause)
      expect(result.finalText).not.toBe('')
    },
  )

  // -------------------------------------------------------------------------
  // 4. Compaction end-to-end: trigger, briefing, swap, and post-swap recall.
  // -------------------------------------------------------------------------
  test(
    'compaction end-to-end: a short session trips the trigger, the briefing is applied, ' +
    'and the post-swap turn recalls a pre-compaction fact',
    // Deliberately above the other four cases' ~150 s ceiling: measured live, the
    // background briefing generation alone (generateCompaction, non-streaming) has taken
    // anywhere from 22 s to well over 150 s run to run for a similarly-sized transcript --
    // the model's own summarization verbosity, not this test's design, is what varies.
    // A tighter budget traded a slow pass for a flaky failure; this trades a few extra
    // minutes of headroom for an honest, non-flaky result.
    { timeout: 280_000 },
    async () => {
      const root = newWorkspace('pc-plan3-compaction-')
      const store = new SessionStore(root)

      // A bare registry, not createToolset()'s full default set: measured live, the
      // default toolset's own schemas alone cost ~2500 prompt tokens on every request
      // (mostly cache-hit after the first, but still counted by fillRatio) -- against a
      // contextLength this low, that fixed floor would trip the trigger before the
      // CONVERSATION itself ever grew at all, which is not what the brief's "a 3-turn
      // session trips it" is asking this test to prove. Dropping to zero tools removes
      // that floor, so crossing the threshold is genuinely driven by the three turns'
      // own growth. (An empty tool list also means toolChoice: 'auto' can never produce
      // a tool call, and every turn here is answered turns of plain prose.)
      const toolset: Toolset = {
        registry: new ToolRegistry(),
        background: new BackgroundTasks(),
        todos: new TodoStore(),
      }
      const engine = new PermissionEngine({ layers: [], mode: 'normal', workspaceRoot: root })
      const compactionEvents: CompactionEvent[] = []

      const session = new Session({
        client: new LlamaClient({ baseUrl: SERVER, model: MODEL }),
        toolset,
        workspaceRoot: root,
        mode: 'normal',
        engine,
        store,
        maxSteps: 4,
        // Lied down from the model's real context so a handful of ordinary turns trips
        // it, per the brief ("~3000"). Nudged down further after live measurement: the
        // background summarizer's OWN generation time is a highly variable, dominant cost
        // here (22 s-160+ s across otherwise-identical runs against a real multi-turn
        // transcript, occasionally exhausting its retry budget and reporting 'failed') --
        // and, measured directly, a minimal 2-message-pair transcript with no carried
        // reasoning_content compacts cleanly in ~40 s every time, while a real Session
        // transcript carrying several turns' worth of real reasoning_content is what
        // triggers the slow/failing runs. Fewer real turns before tripping means less
        // accumulated reasoning_content feeding the summarizer, so this is lower than
        // "~3000" would suggest, deliberately trading turn count for reliability.
        // keepRecent: 2 keeps only the LAST exchange verbatim, so the codename fact from
        // turn 1 survives (if it survives at all) only via the briefing -- this is what
        // actually exercises the summarizer, not the tail. 1600 (not lower) also matters
        // for the OTHER side of the same trigger: the post-swap transcript (system +
        // briefing + ack + a 2-message tail) is itself a few hundred tokens, and too low a
        // contextLength made the post-swap turn immediately re-trip a SECOND background
        // compaction that nothing in this test would ever await or observe settle.
        compaction: { contextLength: 1600, triggerRatio: 0.5, keepRecent: 2 },
        onCompaction: (e) => {
          compactionEvents.push(e)
          console.log(
            `  [compaction] ${e.state}` +
            `${e.droppedMessages !== undefined ? ` (${e.droppedMessages} dropped)` : ''}`,
          )
        },
      })

      const FACT_TURN =
        'Decision for this project, which you must remember for the rest of this ' +
        'conversation: from now on, refer to this project only by the codename ' +
        'GRIFFIN-9, never by any other name. Reply with exactly one short sentence ' +
        'acknowledging this, nothing else.'
      // Short, tightly-bounded single-sentence asks rather than open-ended paragraphs:
      // measured live, this model's own completion length for a "write N words about X"
      // prose task varies hugely run to run (933-2483 completion tokens against the same
      // "150-200 words" wording across two live runs) -- and since the trigger check
      // (maybeStartBackgroundCompaction) fires AFTER a turn's own reply is already
      // appended, whichever turn happens to trip it hands its OWN size to the background
      // summarizer too. A one-sentence, word-capped ask keeps that contribution small and
      // predictable turn to turn, so the transcript being compacted stays a bounded size
      // regardless of which growth turn ends up tripping it. Coding-flavored questions,
      // not arbitrary trivia: COMPACTION_INSTRUCTION (compaction.ts) frames its briefing
      // around "Task state"/"Files touched"/"Next step" -- a coding-session shape a run of
      // short technical Q&A fits naturally, rather than a mismatch the summarizer has to
      // reconcile. Distinct topics, not the same one repeated, so nothing here could be
      // mistaken for the recalled fact.
      const GROWTH_TASKS = [
        'In one sentence of no more than 20 words, name the average-case time complexity ' +
        'of binary search.',
        'In one sentence of no more than 20 words, name one common use case for a hash map.',
        'In one sentence of no more than 20 words, name one advantage of a linked list ' +
        'over an array.',
        'In one sentence of no more than 20 words, name one downside of recursion ' +
        'compared to iteration.',
        'In one sentence of no more than 20 words, name one reason to prefer a set over a ' +
        'list for membership checks.',
        'In one sentence of no more than 20 words, name one common cause of a stack ' +
        'overflow error.',
      ]

      const r1 = await session.send(FACT_TURN)
      console.log(`[compaction] turn 1 (fact) stoppedBecause=${r1.stoppedBecause}`)

      let tripped = compactionEvents.some((e) => e.state === 'started')
      for (const task of GROWTH_TASKS) {
        if (tripped) break
        const r = await session.send(task)
        console.log(
          `[compaction] growth turn stoppedBecause=${r.stoppedBecause}, ` +
          `promptTokens=${session.contextUsage().promptTokens}`,
        )
        tripped = compactionEvents.some((e) => e.state === 'started')
      }
      expect(
        tripped,
        `compaction never triggered after ${GROWTH_TASKS.length} growth turns; observed ` +
        `states: ${compactionEvents.map((e) => e.state).join(',') || '(none)'}`,
      ).toBe(true)

      // The background generation runs off the request path. A send() arriving while it
      // is still in flight would only ABORT it (single-slot discipline, session.ts) --
      // so the swap must be awaited here before the post-swap turn, not assumed.
      const settled = await waitForCompactionState(
        compactionEvents, ['ready', 'postponed', 'failed'], 150_000,
      )
      console.log(`[compaction] background generation settled: ${settled?.state}`)
      expect(
        settled?.state,
        `compaction did not settle in time; states so far: ${compactionEvents.map((e) => e.state).join(',')}`,
      ).toBe('ready')

      const beforePostSwap = compactionEvents.length
      const postSwap = await session.send(
        'What is this project\'s codename? Reply with just the codename, nothing else.',
      )
      console.log(`[compaction] post-swap answer: ${postSwap.finalText}`)

      // started -> ready -> applied, in that order (brief: "event states started->ready->applied").
      const states = compactionEvents.map((e) => e.state)
      expect(states).toContain('started')
      expect(states).toContain('ready')
      expect(states).toContain('applied')
      expect(states.indexOf('started')).toBeLessThan(states.indexOf('ready'))
      expect(states.indexOf('ready')).toBeLessThan(states.indexOf('applied'))
      // The swap happens at the HEAD of the post-swap send(), before its own turn runs.
      expect(compactionEvents.slice(beforePostSwap).some((e) => e.state === 'applied')).toBe(true)

      expect(postSwap.finalText.toUpperCase()).toContain('GRIFFIN-9')

      // The fact survives via the briefing or the kept tail (brief's explicit either/or) --
      // checked directly against the persisted transcript, not just the model's paraphrase.
      const { transcript } = store.load(session.id)
      const msgs = transcript.messages()
      const briefingMsg = msgs.find((m) => (m.content ?? '').includes(COMPACTION_BRIEFING_PREFIX))
      expect(briefingMsg, 'no compaction briefing message found in the post-swap transcript').toBeDefined()
      console.log(`[compaction] briefing: ${(briefingMsg?.content ?? '').slice(0, 500)}`)
      const wholeTranscriptText = msgs.map((m) => m.content ?? '').join('\n')
      expect(wholeTranscriptText.toUpperCase()).toContain('GRIFFIN-9')

      // JSONL audit: the marker is on disk, immediately followed by the fresh transcript.
      const jsonlPath = join(root, '.privatecode', 'sessions', `${session.id}.jsonl`)
      const raw = readFileSync(jsonlPath, 'utf8')
      const lines = raw.split('\n').filter((l) => l.trim() !== '')
      const markerIdx = lines.findIndex((l) => {
        try { return (JSON.parse(l) as { __event?: string }).__event === 'compaction' } catch { return false }
      })
      expect(markerIdx, 'no compaction marker line found in the session .jsonl').toBeGreaterThanOrEqual(0)
      expect(markerIdx).toBeLessThan(lines.length - 1) // fresh transcript lines follow it
      const lineAfterMarker = JSON.parse(lines[markerIdx + 1]!) as { role?: string }
      // The swap's rebuilt system message is always the new transcript's first line.
      expect(lineAfterMarker.role).toBe('system')

      // Defensive drain, not an assertion: the post-swap turn's OWN tail check can, at
      // this low a contextLength, immediately re-trip a second background generation
      // (single-slot discipline means it would otherwise keep the server busy after this
      // test has already finished). Wait it out if so, so nothing is left in flight for
      // the next test in this file. A fresh poll against the SAME live array (not a
      // one-off slice) so a later push is actually seen.
      if (compactionEvents.slice(beforePostSwap).some((e) => e.state === 'started')) {
        const settledStates: ReadonlyArray<CompactionEvent['state']> = ['ready', 'postponed', 'failed']
        const deadline = Date.now() + 90_000
        let drained: CompactionEvent | undefined
        while (Date.now() < deadline) {
          drained = compactionEvents.slice(beforePostSwap).find((e) => settledStates.includes(e.state))
          if (drained) break
          await sleep(300)
        }
        console.log(`[compaction] post-swap re-trigger drained: ${drained?.state ?? '(timed out)'}`)
      }
    },
  )

  // -------------------------------------------------------------------------
  // 5. Accounting: contextUsage().promptTokens against an independent server request.
  // -------------------------------------------------------------------------
  test(
    'accounting: contextUsage().promptTokens is within 15% of the server\'s own reported ' +
    'usage for the same turn',
    { timeout: 90_000 },
    async () => {
      const root = newWorkspace('pc-plan3-accounting-')
      const store = new SessionStore(root)
      const toolset = createToolset()
      const engine = new PermissionEngine({ layers: [], mode: 'normal', workspaceRoot: root })
      const client = new LlamaClient({ baseUrl: SERVER, model: MODEL })

      const session = new Session({
        client,
        toolset,
        workspaceRoot: root,
        mode: 'normal',
        engine,
        store,
        maxSteps: 4,
        // Wired only to switch Agent.chat() onto chatStream() (loop.ts), matching the
        // brief's "the server's own final-chunk usage" -- the streaming response's
        // trailing usage-only chunk.
        events: { onTextDelta: () => {} },
      })

      const result = await session.send('Reply with exactly the single word "ready", nothing else.')
      console.log(
        `\n[accounting] stoppedBecause=${result.stoppedBecause}, ` +
        `finalText=${result.finalText.slice(0, 100)}`,
      )
      expect(result.stoppedBecause).toBe('done')

      const usage = session.contextUsage()
      console.log(`[accounting] session.contextUsage() = ${JSON.stringify(usage)}`)
      expect(usage.promptTokens).not.toBeNull()

      // Independent cross-check: replay the EXACT prompt the turn's last (here, only)
      // step sent -- every transcript message except the assistant reply that step
      // itself produced -- as a fresh request, and compare ITS final-chunk usage against
      // Session's own number. This is what makes it a real accounting check rather than
      // a tautology: captureStepDone (session.ts) copies info.promptTokens verbatim, so
      // comparing Session's number against itself would prove nothing; a SEPARATE request
      // against the live server is the only independent source of truth available here.
      const { transcript } = store.load(session.id)
      const all = transcript.messages()
      console.log(`[accounting] transcript has ${all.length} messages`)
      const promptSent = all.slice(0, -1)

      const verify = await client.chatStream({
        messages: [...promptSent],
        tools: toolset.registry.schemas(),
        toolChoice: 'auto',
        maxTokens: 16,
      })
      console.log(`[accounting] independent verify usage = ${JSON.stringify(verify.usage)}`)
      expect(verify.usage?.prompt_tokens).toBeDefined()

      const serverTokens = verify.usage!.prompt_tokens!
      const sessionTokens = usage.promptTokens!
      const diff = Math.abs(sessionTokens - serverTokens) / serverTokens
      console.log(
        `[accounting] session=${sessionTokens}, server=${serverTokens}, ` +
        `diff=${(diff * 100).toFixed(1)}%`,
      )
      expect(diff).toBeLessThanOrEqual(0.15)
    },
  )
})
