import { describe, expect, it } from 'vitest'
import { type ChatAction, type ChatState, initialChatState, reduceChat } from './state'

function run(actions: ChatAction[]): ChatState {
  return actions.reduce(reduceChat, initialChatState())
}

describe('reduceChat: delta accumulation', () => {
  it('grows a thinking item on successive thinking.delta events', () => {
    const state = run([
      { type: 'step.start', step: 1, timeoutMs: 90_000, startedAtMs: 0 },
      { type: 'thinking.delta', text: 'abcd' }, // 4 chars
      { type: 'thinking.delta', text: 'ef' }, // +2 chars
    ])
    expect(state.items).toEqual([{ kind: 'thinking', id: 1, step: 1, chars: 6 }])
  })

  it('replaces the thinking item with a growing assistant item once text.delta arrives', () => {
    const state = run([
      { type: 'step.start', step: 1, timeoutMs: 90_000, startedAtMs: 0 },
      { type: 'thinking.delta', text: 'reasoning...' },
      { type: 'text.delta', text: 'Hello' },
      { type: 'text.delta', text: ', world' },
    ])
    // The thinking line is GONE, not merely frozen -- exactly one item, the assistant text.
    expect(state.items).toEqual([{ kind: 'assistant', id: 2, text: 'Hello, world', interrupted: false }])
  })

  it('ignores assistant.text when the same content already streamed via text.delta', () => {
    const state = run([
      { type: 'step.start', step: 1, timeoutMs: 90_000, startedAtMs: 0 },
      { type: 'text.delta', text: 'Hello' },
      { type: 'assistant.text', text: 'Hello' }, // duplicate of what already streamed
    ])
    expect(state.items).toEqual([{ kind: 'assistant', id: 2, text: 'Hello', interrupted: false }])
  })

  it('uses assistant.text directly when nothing streamed (non-streaming path)', () => {
    const state = run([
      { type: 'step.start', step: 1, timeoutMs: 90_000, startedAtMs: 0 },
      { type: 'thinking.delta', text: 'reasoning' },
      { type: 'assistant.text', text: 'final answer' },
    ])
    // Thinking item stays (it's only removed by text.delta, not by assistant.text), and
    // the assistant item is appended alongside it.
    expect(state.items).toEqual([
      { kind: 'thinking', id: 1, step: 1, chars: 9 },
      { kind: 'assistant', id: 2, text: 'final answer', interrupted: false },
    ])
  })
})

describe('reduceChat: step reset', () => {
  it('starts a new step\'s thinking count at zero, independent of the previous step', () => {
    const state = run([
      { type: 'step.start', step: 1, timeoutMs: 90_000, startedAtMs: 0 },
      { type: 'thinking.delta', text: 'a'.repeat(40) }, // step 1 reaches 40 chars
      { type: 'text.delta', text: 'first step text' },
      { type: 'step.done', step: 1, seconds: 1.2, tokensPerSecond: 40 },
      { type: 'step.start', step: 2, timeoutMs: 90_000, startedAtMs: 1000 },
      { type: 'thinking.delta', text: 'bb' }, // step 2's OWN count, must be 2, not 42
    ])
    const thinkingItems = state.items.filter((i) => i.kind === 'thinking')
    expect(thinkingItems).toEqual([{ kind: 'thinking', id: 3, step: 2, chars: 2 }])
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
    expect(state.items).toEqual([{ kind: 'assistant', id: 2, text: 'partial resp', interrupted: true }])
    expect(state.turnRunning).toBe(false)
  })

  it('does not mark anything interrupted when the turn ends normally', () => {
    const state = run([
      { type: 'step.start', step: 1, timeoutMs: 90_000, startedAtMs: 0 },
      { type: 'text.delta', text: 'complete response' },
      { type: 'turn.done', stoppedBecause: 'done' },
    ])
    expect(state.items).toEqual([{ kind: 'assistant', id: 2, text: 'complete response', interrupted: false }])
  })

  it('is a no-op on the transcript when the turn aborts with no assistant text yet', () => {
    const state = run([
      { type: 'step.start', step: 1, timeoutMs: 90_000, startedAtMs: 0 },
      { type: 'turn.done', stoppedBecause: 'aborted' },
    ])
    // Only the (still-open) thinking item from step.start -- nothing to mark interrupted.
    expect(state.items).toEqual([{ kind: 'thinking', id: 1, step: 1, chars: 0 }])
    expect(state.turnRunning).toBe(false)
  })
})

describe('reduceChat: tool calls', () => {
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
