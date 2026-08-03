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

  it('clears currentStep/lastStepDone on turn-started so a new turn never shows stale numbers', () => {
    const midway = run([
      { type: 'step.start', step: 1, timeoutMs: 90_000, startedAtMs: 0 },
      { type: 'step.done', step: 1, seconds: 2, tokensPerSecond: 30 },
    ])
    expect(midway.lastStepDone).toEqual({ step: 1, seconds: 2, tokensPerSecond: 30 })

    const fresh = reduceChat(midway, { type: 'turn-started' })
    expect(fresh.currentStep).toBeNull()
    expect(fresh.lastStepDone).toBeNull()
    expect(fresh.turnRunning).toBe(true)
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
      { type: 'step.start', step: 1, timeoutMs: 90_000, startedAtMs: 0 },
      { type: 'text.delta', text: 'working on it' },
      { type: 'turn.done', stoppedBecause: 'max_steps' },
    ])
    expect(state.items[state.items.length - 1]).toEqual({ kind: 'stopped', id: 2, reason: 'max_steps' })
  })

  it('does not mark anything interrupted when the turn ends normally', () => {
    const state = run([
      { type: 'step.start', step: 1, timeoutMs: 90_000, startedAtMs: 0 },
      { type: 'text.delta', text: 'complete response' },
      { type: 'turn.done', stoppedBecause: 'done' },
    ])
    expect(state.items).toEqual([{ kind: 'assistant', id: 1, text: 'complete response', interrupted: false }])
  })

  it('is a no-op on the transcript when the turn aborts with no assistant text yet', () => {
    const state = run([
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
    expect(opened.items).toEqual([{ kind: 'tool', id: 1, name: 'read_file', args: '{"path":"a.ts"}' }])

    const done = reduceChat(opened, { type: 'tool.result', name: 'read_file', ok: true, content: 'line one\nline two' })
    expect(done.items).toEqual([
      { kind: 'tool', id: 1, name: 'read_file', args: '{"path":"a.ts"}',
        result: { ok: true, preview: 'line one', content: 'line one\nline two' } },
    ])
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
