import { describe, expect, it } from 'vitest'
import { type ChatAction, type ChatState, initialChatState, reduceChat } from './state'

function run(actions: ChatAction[]): ChatState {
  return actions.reduce(reduceChat, initialChatState())
}

describe('reduceChat: delta accumulation', () => {
  it('accumulates the reasoning TEXT on successive thinking.delta events', () => {
    const state = run([
      { type: 'step.start', step: 1, timeoutMs: 90_000, startedAtMs: 0 },
      { type: 'thinking.delta', text: 'abcd' },
      { type: 'thinking.delta', text: 'ef' },
    ])
    expect(state.items).toEqual([
      { kind: 'thinking', id: 1, step: 1, text: 'abcdef', done: false, startedAtMs: 0, endedAtMs: null },
    ])
  })

  it('closes the reasoning block (keeping its text) when text.delta arrives', () => {
    const state = run([
      { type: 'step.start', step: 1, timeoutMs: 90_000, startedAtMs: 0 },
      { type: 'thinking.delta', text: 'reasoning...' },
      { type: 'text.delta', text: 'Hello', atMs: 1_500 },
      { type: 'text.delta', text: ', world', atMs: 1_600 },
    ])
    // The reasoning survives -- being able to read it back is the whole point -- but it is
    // no longer live, so nothing animates it.
    expect(state.items).toEqual([
      { kind: 'thinking', id: 1, step: 1, text: 'reasoning...', done: true, startedAtMs: 0, endedAtMs: 1_500 },
      { kind: 'assistant', id: 2, text: 'Hello, world', interrupted: false },
    ])
  })

  it('closes the reasoning block when the step calls a tool instead of answering', () => {
    // The regression this whole rework exists for: a tool-calling step emits no text.delta,
    // so the original reducer left the block open and it animated forever.
    const state = run([
      { type: 'step.start', step: 1, timeoutMs: 90_000, startedAtMs: 0 },
      { type: 'thinking.delta', text: 'I should read the file' },
      { type: 'tool.call', name: 'read_file', args: '{"path":"a.ts"}', atMs: 900 },
    ])
    expect(state.items[0]).toEqual({
      kind: 'thinking', id: 1, step: 1, text: 'I should read the file', done: true, startedAtMs: 0, endedAtMs: 900,
    })
  })

  it('leaves no live reasoning block behind after a whole tool round-trip', () => {
    const state = run([
      { type: 'step.start', step: 1, timeoutMs: 90_000, startedAtMs: 0 },
      { type: 'thinking.delta', text: 'think' },
      { type: 'tool.call', name: 'read_file', args: '{}' },
      { type: 'tool.result', name: 'read_file', ok: true, content: 'contents' },
      { type: 'step.done', step: 1, seconds: 2 },
      { type: 'step.start', step: 2, timeoutMs: 90_000, startedAtMs: 3_000 },
      { type: 'thinking.delta', text: 'now answer' },
      { type: 'text.delta', text: 'done' },
      { type: 'turn.done', stoppedBecause: 'done' },
    ])
    const live = state.items.filter((i) => i.kind === 'thinking' && !i.done)
    expect(live).toEqual([])
  })

  it('ignores assistant.text when the same content already streamed via text.delta', () => {
    const state = run([
      { type: 'step.start', step: 1, timeoutMs: 90_000, startedAtMs: 0 },
      { type: 'text.delta', text: 'Hello' },
      { type: 'assistant.text', text: 'Hello' }, // duplicate of what already streamed
    ])
    expect(state.items).toEqual([{ kind: 'assistant', id: 1, text: 'Hello', interrupted: false }])
  })

  it('uses assistant.text directly when nothing streamed (non-streaming path)', () => {
    const state = run([
      { type: 'step.start', step: 1, timeoutMs: 90_000, startedAtMs: 0 },
      { type: 'thinking.delta', text: 'reasoning' },
      { type: 'assistant.text', text: 'final answer' },
    ])
    expect(state.items).toEqual([
      { kind: 'thinking', id: 1, step: 1, text: 'reasoning', done: true, startedAtMs: 0, endedAtMs: null },
      { kind: 'assistant', id: 2, text: 'final answer', interrupted: false },
    ])
  })
})

describe('reduceChat: step reset', () => {
  it('gives each step its own reasoning block instead of continuing the previous one', () => {
    const state = run([
      { type: 'step.start', step: 1, timeoutMs: 90_000, startedAtMs: 0 },
      { type: 'thinking.delta', text: 'first thought' },
      { type: 'text.delta', text: 'first step text', atMs: 500 },
      { type: 'step.done', step: 1, seconds: 1.2, tokensPerSecond: 40 },
      { type: 'step.start', step: 2, timeoutMs: 90_000, startedAtMs: 1000 },
      { type: 'thinking.delta', text: 'second thought' },
    ])
    const thinkingItems = state.items.filter((i) => i.kind === 'thinking')
    expect(thinkingItems).toEqual([
      { kind: 'thinking', id: 1, step: 1, text: 'first thought', done: true, startedAtMs: 0, endedAtMs: 500 },
      { kind: 'thinking', id: 3, step: 2, text: 'second thought', done: false, startedAtMs: 1000, endedAtMs: null },
    ])
  })

  /**
   * This assertion used to be the opposite, on the theory that a new turn must not show
   * "stale numbers". It is the wrong frame, and the app showed why: clearing here made the
   * context bar, tok/s and MTP vanish the instant you pressed Enter and reappear when the
   * first step landed — a blink on every single message, reported from the running window.
   *
   * The last measurement does not stop being the last measurement because a new turn began.
   * The step in flight is genuinely unknown and IS cleared; what was measured stays until
   * something measures again.
   */
  it('keeps the last step\'s numbers across turn-started, and clears only the step in flight', () => {
    const midway = run([
      { type: 'step.start', step: 1, timeoutMs: 90_000, startedAtMs: 0 },
      { type: 'step.done', step: 1, seconds: 2, tokensPerSecond: 30, promptTokens: 4200 },
    ])
    expect(midway.lastStepDone?.promptTokens).toBe(4200)

    const fresh = reduceChat(midway, { type: 'turn-started' })
    expect(fresh.currentStep).toBeNull()
    expect(fresh.lastStepDone?.promptTokens).toBe(4200)
    expect(fresh.turnRunning).toBe(true)
  })

  /**
   * A resumed session has no step in THIS process, so the bar had nothing to show until the
   * user spoke — while the host knew the size of the transcript it had just restored.
   */
  it('seeds the context reading from a restored session, marked as an estimate', () => {
    const restored = reduceChat(initialChatState(), {
      type: 'session-switched',
      sessionId: 's1',
      mode: 'normal',
      contextLength: 131_072,
      title: 'yesterday',
      contextUsed: { promptTokens: null, approxTokens: 18_400 },
    })
    expect(restored.lastStepDone?.promptTokens).toBe(18_400)
    expect(restored.lastStepDone?.estimated).toBe(true)
    // Nothing was timed, so nothing claims to have been.
    expect(restored.lastStepDone?.tokensPerSecond).toBeUndefined()
  })

  /**
   * Browsing used to cost you the running turn, because selecting a session and BECOMING it
   * were one click. They are two now, and the part that matters is what happens to the live
   * session while you read: nothing.
   */
  it('reading an earlier session leaves the live one accumulating behind it', () => {
    const live = run([
      { type: 'user-message', text: 'do the thing' },
      { type: 'turn-started' },
    ])
    const reading = reduceChat(live, {
      type: 'viewing-started',
      sessionId: 'older',
      title: 'yesterday',
      entries: [{ kind: 'user', text: 'what did I ask then' }],
    })
    expect(reading.viewing?.items.map((i) => i.kind)).toEqual(['user'])
    // The live transcript is untouched, and the turn is still running.
    expect(reading.items).toEqual(live.items)
    expect(reading.turnRunning).toBe(true)

    // Events that arrive while reading still land in the live session, not in the view.
    const later = reduceChat(reading, { type: 'assistant.text', text: 'done' })
    expect(later.viewing?.items.map((i) => i.kind)).toEqual(['user'])
    expect(later.items.length).toBe(live.items.length + 1)

    // And going back shows what happened meanwhile.
    const back = reduceChat(later, { type: 'viewing-ended' })
    expect(back.viewing).toBeNull()
    expect(back.items.length).toBe(live.items.length + 1)
  })

  it('becoming a session ends the reading', () => {
    const reading = reduceChat(initialChatState(), {
      type: 'viewing-started', sessionId: 'older', title: 'yesterday', entries: [],
    })
    expect(reading.viewing).not.toBeNull()
    const adopted = reduceChat(reading, {
      type: 'session-switched',
      sessionId: 'older',
      mode: 'normal',
      contextLength: null,
      title: 'yesterday',
    })
    expect(adopted.viewing).toBeNull()
  })

  it('prefers the server\'s own count over the estimate when this process has one', () => {
    const restored = reduceChat(initialChatState(), {
      type: 'session-switched',
      sessionId: 's1',
      mode: 'normal',
      contextLength: 131_072,
      title: 'live',
      contextUsed: { promptTokens: 20_100, approxTokens: 18_400 },
    })
    expect(restored.lastStepDone?.promptTokens).toBe(20_100)
    expect(restored.lastStepDone?.estimated).toBe(false)
  })

  it('clears currentStep once step.done arrives', () => {
    const state = run([{ type: 'step.start', step: 1, timeoutMs: 90_000, startedAtMs: 0 }])
    expect(state.currentStep).not.toBeNull()
    const after = reduceChat(state, { type: 'step.done', step: 1, seconds: 1, tokensPerSecond: 10 })
    expect(after.currentStep).toBeNull()
  })
})

describe('reduceChat: interrupt', () => {
  it('marks a partial assistant item interrupted when the turn ends aborted', () => {
    const state = run([
      { type: 'turn-started' },
      { type: 'step.start', step: 1, timeoutMs: 90_000, startedAtMs: 0 },
      { type: 'text.delta', text: 'partial resp' },
      { type: 'turn.done', stoppedBecause: 'aborted' },
    ])
    expect(state.items).toEqual([
      { kind: 'assistant', id: 1, text: 'partial resp', interrupted: true },
      // An interrupted turn also gets an explicit note: a turn that ends for any reason
      // other than the model finishing must say so, not just go quiet.
      { kind: 'stopped', id: 2, reason: 'aborted' },
    ])
    expect(state.turnRunning).toBe(false)
  })

  it('records why a turn stopped when the loop ended it, not the model', () => {
    // The case the user actually hit: the agent goes quiet mid-task because it reached the
    // 40-step ceiling, and nothing on screen said so.
    const state = run([
      { type: 'turn-started' },
      { type: 'step.start', step: 1, timeoutMs: 90_000, startedAtMs: 0 },
      { type: 'text.delta', text: 'working on it' },
      { type: 'turn.done', stoppedBecause: 'max_steps' },
    ])
    expect(state.items[state.items.length - 1]).toEqual({ kind: 'stopped', id: 2, reason: 'max_steps' })
  })

  it('does not mark anything interrupted when the turn ends normally', () => {
    const state = run([
      { type: 'turn-started' },
      { type: 'step.start', step: 1, timeoutMs: 90_000, startedAtMs: 0 },
      { type: 'text.delta', text: 'complete response' },
      { type: 'turn.done', stoppedBecause: 'done' },
    ])
    expect(state.items).toEqual([{ kind: 'assistant', id: 1, text: 'complete response', interrupted: false }])
  })

  it('is a no-op on the transcript when the turn aborts with no assistant text yet', () => {
    const state = run([
      { type: 'turn-started' },
      { type: 'step.start', step: 1, timeoutMs: 90_000, startedAtMs: 0 },
      { type: 'turn.done', stoppedBecause: 'aborted', atMs: 700 },
    ])
    // Nothing to mark interrupted, and no empty reasoning card either: a step that never
    // produced reasoning never opens a block. The stop note is still there.
    expect(state.items).toEqual([{ kind: 'stopped', id: 1, reason: 'aborted' }])
    expect(state.turnRunning).toBe(false)
  })
})

describe('reduceChat: tool calls', () => {
  it('attaches the result to the call even when an approval record came between them', () => {
    // The real event order for a gated edit: tool.call -> approval.request ->
    // approval.answered (which APPENDS a record) -> tool.result. Matching only the last
    // item dropped the result and left the card spinning forever.
    const state = run([
      { type: 'tool.call', name: 'edit_file', args: '{"path":"a.ts"}' },
      {
        type: 'approval.request', requestId: 'r1', tool: 'edit_file',
        summary: 'edit a.ts', detail: 'detail', suggestedRules: [],
      },
      { type: 'approval.answered', decision: { verdict: 'allow' } },
      { type: 'tool.result', name: 'edit_file', ok: true, content: '--- a.ts\n+++ a.ts\n@@ line 1 @@\n+new' },
    ])
    const toolItem = state.items.find((i) => i.kind === 'tool')
    expect(toolItem?.kind === 'tool' && toolItem.result?.ok).toBe(true)
    // The record still sits after the call, where it happened.
    expect(state.items.map((i) => i.kind)).toEqual(['tool', 'approval-record'])
  })

  it('opens a tool row on tool.call and patches it in place on tool.result', () => {
    const opened = run([{ type: 'tool.call', name: 'read_file', args: '{"path":"a.ts"}' }])
    expect(opened.items).toEqual([{ kind: 'tool', id: 1, name: 'read_file', args: '{"path":"a.ts"}', startedAtMs: 0 }])

    const done = reduceChat(opened, { type: 'tool.result', name: 'read_file', ok: true, content: 'line one\nline two' })
    expect(done.items).toEqual([
      { kind: 'tool', id: 1, name: 'read_file', args: '{"path":"a.ts"}', startedAtMs: 0,
        // No `display` on the wire means the tool did not clip anything, so what the
        // person sees and what the model saw are the same string.
        result: { ok: true, preview: 'line one', content: 'line one\nline two', display: 'line one\nline two' } },
    ])
  })

  it('keeps the untruncated display copy separate from what the model was given', () => {
    // run_command hands the model a middle-elided 8 KB and the UI the whole log; showing
    // the model's copy is why a build log used to be unreadable in the transcript.
    const state = run([
      { type: 'tool.call', name: 'run_command', args: '{"command":"dotnet test"}' },
      { type: 'tool.result', name: 'run_command', ok: true, content: 'exit 0\nclipped…', display: 'exit 0\nevery single line' },
    ])
    const item = state.items[0]
    expect(item?.kind === 'tool' && item.result).toEqual({
      ok: true, preview: 'exit 0', content: 'exit 0\nclipped…', display: 'exit 0\nevery single line',
    })
  })

  it('a tool.result with no pending call is a harmless no-op', () => {
    const state = reduceChat(initialChatState(), { type: 'tool.result', name: 'x', ok: true, content: 'y' })
    expect(state.items).toEqual([])
  })
})

describe('reduceChat: user messages', () => {
  it('appends a user item independent of any in-flight step state', () => {
    const state = reduceChat(initialChatState(), { type: 'user-message', text: 'do the thing' })
    expect(state.items).toEqual([{ kind: 'user', id: 1, text: 'do the thing' }])
  })
})

describe('reduceChat: approval card state machine (pending -> answered, single-fire)', () => {
  it('opens a pending approval on approval.request', () => {
    const state = reduceChat(initialChatState(), {
      type: 'approval.request', requestId: 'r1', tool: 'edit_file', summary: 'change a.ts',
      detail: '- old\n+ new', suggestedRules: ['edit_file(a.ts)'],
    })
    expect(state.pendingApproval).toEqual({
      requestId: 'r1', tool: 'edit_file', summary: 'change a.ts', detail: '- old\n+ new',
      suggestedRules: ['edit_file(a.ts)'],
    })
    expect(state.items).toEqual([])
  })

  it('collapses the pending card into a one-line record on approval.answered, exactly once', () => {
    const opened = reduceChat(initialChatState(), {
      type: 'approval.request', requestId: 'r1', tool: 'edit_file', summary: 'change a.ts',
      detail: '- old\n+ new', suggestedRules: [],
    })
    const answered = reduceChat(opened, { type: 'approval.answered', decision: { verdict: 'allow' } })
    expect(answered.pendingApproval).toBeNull()
    expect(answered.items).toEqual([
      { kind: 'approval-record', id: 1, tool: 'edit_file', summary: 'change a.ts', decision: { verdict: 'allow' } },
    ])

    // Single-fire: a SECOND answer (e.g. a stale double-click) with nothing pending must
    // not append a second record.
    const secondAnswer = reduceChat(answered, { type: 'approval.answered', decision: { verdict: 'deny' } })
    expect(secondAnswer.items).toEqual(answered.items)
  })

  it('records a deny decision with its comment', () => {
    const opened = reduceChat(initialChatState(), {
      type: 'approval.request', requestId: 'r1', tool: 'run_command', summary: 'npm test',
      detail: 'npm test', suggestedRules: [],
    })
    const denied = reduceChat(opened, {
      type: 'approval.answered', decision: { verdict: 'deny', comment: 'use vitest instead' },
    })
    expect(denied.items).toEqual([
      { kind: 'approval-record', id: 1, tool: 'run_command', summary: 'npm test',
        decision: { verdict: 'deny', comment: 'use vitest instead' } },
    ])
  })
})

describe('reduceChat: question card state machine', () => {
  it('opens a pending question and collapses it into a record on answer, exactly once', () => {
    const opened = reduceChat(initialChatState(), {
      type: 'question.request', requestId: 'q1', question: 'which file?', options: ['a.ts', 'b.ts'],
    })
    expect(opened.pendingQuestion).toEqual({ requestId: 'q1', question: 'which file?', options: ['a.ts', 'b.ts'] })

    const answered = reduceChat(opened, { type: 'question.answered', answer: 'a.ts' })
    expect(answered.pendingQuestion).toBeNull()
    expect(answered.items).toEqual([{ kind: 'question-record', id: 1, question: 'which file?', answer: 'a.ts' }])

    const secondAnswer = reduceChat(answered, { type: 'question.answered', answer: 'b.ts' })
    expect(secondAnswer.items).toEqual(answered.items)
  })
})

describe('reduceChat: todos', () => {
  it('replaces the todo list wholesale on every todos event', () => {
    const first = reduceChat(initialChatState(), {
      type: 'todos', items: [{ text: 'step one', status: 'pending' }],
    })
    expect(first.todos).toEqual([{ text: 'step one', status: 'pending' }])

    const second = reduceChat(first, {
      type: 'todos', items: [{ text: 'step one', status: 'completed' }, { text: 'step two', status: 'in_progress' }],
    })
    expect(second.todos).toEqual([
      { text: 'step one', status: 'completed' },
      { text: 'step two', status: 'in_progress' },
    ])
  })
})

describe('reduceChat: step.done stats used by the status bar', () => {
  it('carries promptTokens and draftAcceptance into lastStepDone', () => {
    const state = reduceChat(initialChatState(), {
      type: 'step.done', step: 1, seconds: 2, tokensPerSecond: 40, promptTokens: 1234, draftAcceptance: 0.8,
    })
    expect(state.lastStepDone).toEqual({
      step: 1, seconds: 2, tokensPerSecond: 40, promptTokens: 1234, draftAcceptance: 0.8,
    })
  })

  it('leaves promptTokens/draftAcceptance undefined when the event did not carry them', () => {
    const state = reduceChat(initialChatState(), { type: 'step.done', step: 1, seconds: 2 })
    expect(state.lastStepDone?.promptTokens).toBeUndefined()
    expect(state.lastStepDone?.draftAcceptance).toBeUndefined()
  })
})

describe('reduceChat: session switching', () => {
  it('sets session info on session-switched', () => {
    const state = reduceChat(initialChatState(), {
      type: 'session-switched', sessionId: 's1', mode: 'normal', contextLength: 131072, title: 'my session',
    })
    expect(state.session).toEqual({ sessionId: 's1', mode: 'normal', contextLength: 131072, title: 'my session' })
  })

  it('wipes the transcript, pending cards, and todos on session-switched', () => {
    const busy = run([
      { type: 'user-message', text: 'hi' },
      { type: 'todos', items: [{ text: 'x', status: 'pending' }] },
      { type: 'approval.request', requestId: 'r1', tool: 'edit_file', summary: 's', detail: 'd', suggestedRules: [] },
    ])
    expect(busy.items).not.toEqual([])
    expect(busy.pendingApproval).not.toBeNull()
    expect(busy.todos).not.toEqual([])

    const switched = reduceChat(busy, {
      type: 'session-switched', sessionId: 's2', mode: 'plan', contextLength: null, title: 'fresh',
    })
    expect(switched.items).toEqual([])
    expect(switched.pendingApproval).toBeNull()
    expect(switched.todos).toEqual([])
    expect(switched.session).toEqual({ sessionId: 's2', mode: 'plan', contextLength: null, title: 'fresh' })
  })

  it('mode-changed updates the session mode badge without touching anything else', () => {
    const withSession = reduceChat(initialChatState(), {
      type: 'session-switched', sessionId: 's1', mode: 'normal', contextLength: 1000, title: 't',
    })
    const withMessage = reduceChat(withSession, { type: 'user-message', text: 'hi' })
    const changed = reduceChat(withMessage, { type: 'mode-changed', mode: 'autopilot' })
    expect(changed.session?.mode).toBe('autopilot')
    expect(changed.items).toEqual(withMessage.items) // untouched
  })

  it('mode-changed before any session exists is a harmless no-op', () => {
    const state = reduceChat(initialChatState(), { type: 'mode-changed', mode: 'plan' })
    expect(state.session).toBeNull()
  })
})

describe('reduceChat: configuration problems', () => {
  it('collects problems, deduplicates them, and clears them on a session switch', () => {
    // The same strings arrive twice for one session: the host emits `settings.problem`
    // while BUILDING it, and the init reply then carries the identical list. Both paths
    // are needed (the events land before the reset that would wipe them), so the dedupe
    // is what makes the double delivery harmless.
    const state = run([
      { type: 'settings-problem', text: 'settings.json line 3: unparseable rule' },
      { type: 'settings-problem', text: 'settings.json line 3: unparseable rule' },
      { type: 'settings-problem', text: 'could not probe the context length' },
    ])
    expect(state.problems).toEqual([
      'settings.json line 3: unparseable rule',
      'could not probe the context length',
    ])

    const switched = reduceChat(state, {
      type: 'session-switched', sessionId: 's2', mode: 'normal', contextLength: null, title: '',
    })
    expect(switched.problems).toEqual([])
  })

  it('caps the list so an unparseable file cannot produce a strip nobody reads', () => {
    const actions: ChatAction[] = []
    for (let i = 0; i < 25; i++) actions.push({ type: 'settings-problem', text: `problem ${i}` })
    expect(run(actions).problems).toHaveLength(10)
  })

  it('dismissal clears the strip without touching the transcript', () => {
    const state = run([
      { type: 'user-message', text: 'hi' },
      { type: 'settings-problem', text: 'a problem' },
      { type: 'problems-dismissed' },
    ])
    expect(state.problems).toEqual([])
    expect(state.items).toHaveLength(1)
  })
})

describe('reduceChat: a turn that outlived its session', () => {
  it('ignores a turn.done that arrives after the session was switched', () => {
    // Switching sessions mid-turn aborts the old turn host-side; its `turn.done` then
    // lands on a state that has already been reset. It used to append "Stopped by you."
    // as the first and only row of a session the user had not typed a word into.
    const midTurn = run([
      { type: 'turn-started' },
      { type: 'step.start', step: 1, timeoutMs: 90_000, startedAtMs: 0 },
      { type: 'text.delta', text: 'half an answer' },
    ])
    const switched = reduceChat(midTurn, {
      type: 'session-switched', sessionId: 's2', mode: 'normal', contextLength: null, title: '',
    })
    const late = reduceChat(switched, { type: 'turn.done', stoppedBecause: 'aborted' })
    expect(late.items).toEqual([])
    expect(late).toBe(switched)
  })

  it('keeps item ids unique across a switch, because they are identities elsewhere', () => {
    // tree.tsx remembers which tool items it has already acted on in a set that is never
    // cleared. Restarting ids at 1 made new items collide with remembered old ones, and
    // roughly every second write silently failed to refresh the file tree.
    const first = run([
      { type: 'user-message', text: 'one' },
      { type: 'tool.call', name: 'write_file', args: '{"path":"a.ts"}' },
    ])
    const switched = reduceChat(first, {
      type: 'session-switched', sessionId: 's2', mode: 'normal', contextLength: null, title: '',
    })
    const after = reduceChat(switched, { type: 'user-message', text: 'two' })
    expect(after.items[0]?.id).toBeGreaterThan(first.items[first.items.length - 1]?.id ?? 0)
  })
})

/**
 * Restoring a conversation off disk.
 *
 * The point of folding stored entries through this same reducer is that history and the
 * present are assembled by one piece of code. The first test is what proves it: the same
 * conversation, once as it arrives live and once as it comes back from the session file,
 * has to produce the same transcript.
 */
describe('reduceChat: transcript-restored', () => {
  it('produces the same transcript as the live events it stands in for', () => {
    const live = run([
      { type: 'user-message', text: 'add a docstring' },
      { type: 'step.start', step: 1, timeoutMs: 90_000, startedAtMs: 0 },
      { type: 'thinking.delta', text: 'read it first' },
      { type: 'tool.call', name: 'read_file', args: '{"path":"a.ts"}' },
      { type: 'tool.result', name: 'read_file', ok: true, content: 'a.ts (2 lines)' },
      { type: 'assistant.text', text: 'Done.' },
    ])

    const restored = run([
      {
        type: 'transcript-restored',
        entries: [
          { kind: 'user', text: 'add a docstring' },
          { kind: 'reasoning', step: 1, text: 'read it first' },
          { kind: 'tool-call', name: 'read_file', args: '{"path":"a.ts"}' },
          { kind: 'tool-result', name: 'read_file', ok: true, content: 'a.ts (2 lines)' },
          { kind: 'assistant', text: 'Done.' },
        ],
      },
    ])

    // `startedAtMs` is the one honest difference: live events carry a clock and a session
    // file does not record one. Everything the reader sees is identical.
    const forget = (items: ChatState['items']): unknown[] =>
      items.map((i) => (i.kind === 'thinking' ? { ...i, startedAtMs: 0 } : i))
    expect(forget(restored.items)).toEqual(forget(live.items))
  })

  it('keeps two consecutive reasoning steps as two blocks', () => {
    // Live, a tool call or an answer ends each block. A stored conversation can hold two
    // thinking steps back to back, and without the step boundary they would accumulate into
    // one wall of text.
    const state = run([
      {
        type: 'transcript-restored',
        entries: [
          { kind: 'reasoning', step: 1, text: 'first thought' },
          { kind: 'reasoning', step: 2, text: 'second thought' },
        ],
      },
    ])
    expect(state.items.map((i) => (i.kind === 'thinking' ? i.text : i.kind)))
      .toEqual(['first thought', 'second thought'])
    expect(state.items.every((i) => i.kind === 'thinking' && i.done)).toBe(true)
  })

  it('marks a restored failure as a failure', () => {
    const state = run([
      {
        type: 'transcript-restored',
        entries: [
          { kind: 'tool-call', name: 'run_command', args: '{}' },
          { kind: 'tool-result', name: 'run_command', ok: false, content: 'exit 1' },
        ],
      },
    ])
    expect(state.items[0]).toMatchObject({ kind: 'tool', result: { ok: false, content: 'exit 1' } })
  })

  it('restoring nothing leaves an empty transcript', () => {
    expect(run([{ type: 'transcript-restored', entries: [] }]).items).toEqual([])
  })
})

describe('reduceChat: a compaction read back off disk', () => {
  it('lands as a record in the transcript, carrying the briefing', () => {
    const state = run([
      {
        type: 'transcript-restored',
        entries: [
          { kind: 'compaction', summary: '# Continuation Briefing', droppedMessages: 214 },
          { kind: 'user', text: 'carry on' },
        ],
      },
    ])
    expect(state.items).toEqual([
      {
        kind: 'compaction-record',
        id: 1,
        state: 'applied',
        summary: '# Continuation Briefing',
        droppedMessages: 214,
      },
      { kind: 'user', id: 2, text: 'carry on' },
    ])
  })

  it('records no token sizes, because none were ever written down', () => {
    // The before/after numbers were live measurements of a moment that is over. Defaulting
    // them to zero is exactly how a real 214-message compaction once displayed as
    // "0 → 0 (0% freed)"; absent is the only honest value.
    const [item] = run([
      { type: 'transcript-restored', entries: [{ kind: 'compaction', summary: 'x' }] },
    ]).items
    expect(item).toEqual({ kind: 'compaction-record', id: 1, state: 'applied', summary: 'x' })
  })

  it('does not flash the status bar about something that happened days ago', () => {
    // `lastCompaction` drives a self-clearing "compacted — N messages summarised" flash.
    // Restoring through the live `compaction` action would fire it on every launch of a
    // session that had ever been compacted. A record is history; a flash is news.
    const state = run([
      { type: 'transcript-restored', entries: [{ kind: 'compaction', summary: 'x' }] },
    ])
    expect(state.lastCompaction).toBeNull()
  })
})

describe('reduceChat: a tool call arriving as it is written', () => {
  it('opens a card on the name, before a single argument character', () => {
    // The whole point. On a large edit the model spends most of the step writing the
    // argument; the name arrives on the first fragment, so the row can be there for all of
    // it instead of appearing at the end.
    const state = run([{ type: 'tool.call.delta', index: 0, name: 'edit_file', atMs: 5 }])
    expect(state.items).toEqual([
      { kind: 'tool', id: 1, name: 'edit_file', args: '', startedAtMs: 5, writing: true, callIndex: 0 },
    ])
  })

  it('grows the card as the argument is generated', () => {
    const state = run([
      { type: 'tool.call.delta', index: 0, name: 'edit_file' },
      { type: 'tool.call.delta', index: 0, args: '{"path":"a' },
      { type: 'tool.call.delta', index: 0, args: '.ts","old":"x"}' },
    ])
    expect(state.items).toHaveLength(1)
    expect((state.items[0] as { args: string }).args).toBe('{"path":"a.ts","old":"x"}')
  })

  it('is completed by the real call, not duplicated by it', () => {
    // `tool.call` is the authoritative event: it carries the assembled document the tool
    // actually runs on. Appending a second row for it would show every call twice.
    const state = run([
      { type: 'tool.call.delta', index: 0, name: 'edit_file' },
      { type: 'tool.call.delta', index: 0, args: '{"path":"a.ts"' },
      { type: 'tool.call', name: 'edit_file', args: '{"path":"a.ts","old":"x","new":"y"}' },
    ])
    expect(state.items).toEqual([
      {
        kind: 'tool', id: 1, name: 'edit_file', args: '{"path":"a.ts","old":"x","new":"y"}',
        startedAtMs: 0,
      },
    ])
  })

  it('still shows a call whose streaming this window never saw', () => {
    // Streaming is off, or the window was opened mid-step. The call happened either way.
    const state = run([{ type: 'tool.call', name: 'read_file', args: '{"path":"a.ts"}' }])
    expect(state.items).toHaveLength(1)
    expect(state.items[0]).toMatchObject({ kind: 'tool', name: 'read_file' })
    expect(state.items[0]).not.toHaveProperty('writing')
  })

  it('keeps two parallel calls to the same tool apart', () => {
    // They interleave in one stream and are told apart only by index. Completing them in
    // the wrong order hands one call's arguments to the other — which would show the wrong
    // file against the wrong diff.
    const state = run([
      { type: 'tool.call.delta', index: 0, name: 'read_file' },
      { type: 'tool.call.delta', index: 1, name: 'read_file' },
      { type: 'tool.call.delta', index: 1, args: '{"path":"second' },
      { type: 'tool.call.delta', index: 0, args: '{"path":"first' },
      { type: 'tool.call', name: 'read_file', args: '{"path":"first.ts"}' },
      { type: 'tool.call', name: 'read_file', args: '{"path":"second.ts"}' },
    ])
    expect(state.items.map((i) => (i as { args: string }).args))
      .toEqual(['{"path":"first.ts"}', '{"path":"second.ts"}'])
  })

  it('does not hand a result to a call that is still being written', () => {
    // A card with no result and a card still generating look alike to a recency match, and
    // the second cannot possibly be what a result belongs to.
    const state = run([
      { type: 'tool.call', name: 'read_file', args: '{"path":"a.ts"}' },
      { type: 'tool.call.delta', index: 0, name: 'edit_file' },
      { type: 'tool.result', name: 'read_file', ok: true, content: 'a.ts (2 lines)' },
    ])
    expect(state.items[0]).toMatchObject({ name: 'read_file', result: { ok: true } })
    expect(state.items[1]).toMatchObject({ name: 'edit_file', writing: true })
    expect(state.items[1]).not.toHaveProperty('result')
  })

  it('ignores an argument fragment for a call it never saw open', () => {
    expect(run([{ type: 'tool.call.delta', index: 3, args: '{"path":"a' }]).items).toEqual([])
  })
})

describe('reduceChat: a tool call that never runs', () => {
  it('closes a card the turn ended in the middle of writing', () => {
    // A card opens when the model names a tool and closes when the matching tool.call
    // arrives. A turn can end between those two — aborted, timed out, truncated twice — and
    // then no tool.call is ever coming. The card pulsed for the rest of the session, and the
    // next call of the same name completed it: one call's arguments, and later one call's
    // result, shown against another call's card.
    const state = run([
      { type: 'turn-started' },
      { type: 'tool.call.delta', index: 0, name: 'edit_file' },
      { type: 'tool.call.delta', index: 0, args: '{"path":"a.ts"' },
      { type: 'turn.done', stoppedBecause: 'aborted', atMs: 10 },
    ])
    const card = state.items.find((i) => i.kind === 'tool')
    expect(card).toMatchObject({ name: 'edit_file', result: { ok: false } })
    expect(card).not.toHaveProperty('writing')
  })

  it('does not let a later call of the same name inherit an abandoned card', () => {
    // The failure the closing exists to prevent, stated directly.
    const first = run([
      { type: 'turn-started' },
      { type: 'tool.call.delta', index: 0, name: 'edit_file' },
      { type: 'turn.done', stoppedBecause: 'aborted', atMs: 10 },
    ])
    const after = [
      { type: 'turn-started' as const },
      { type: 'tool.call' as const, name: 'edit_file', args: '{"path":"b.ts"}' },
    ].reduce(reduceChat, first)
    const cards = after.items.filter((i) => i.kind === 'tool')
    expect(cards).toHaveLength(2)
    expect(cards[1]).toMatchObject({ args: '{"path":"b.ts"}' })
  })
})
