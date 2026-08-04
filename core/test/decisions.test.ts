import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { DecisionQueue, queueingPort } from '../src/session/decisions.js'
import type { ApprovalRequest, InteractionPort } from '../src/interaction.js'

/**
 * A question nobody is awake to answer.
 *
 * The line these tests defend: parked, NEVER auto-approved. Auto-approving is what autopilot
 * is for, and a mode that quietly granted what it could not ask about would combine the
 * permissiveness of autopilot with the appearance of having asked.
 */

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pc-decisions-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const request: ApprovalRequest = {
  tool: 'run_command',
  summary: 'rm -rf build',
  detail: 'Run in PowerShell:\nrm -rf build',
  suggestedRules: ['run_command(rm -rf build)', 'run_command(rm:*)'],
}

describe('the queue file', () => {
  test('round-trips a parked approval', () => {
    const q = new DecisionQueue(root)
    q.add({
      kind: 'approval', id: 'd1', at: '2026-08-04T02:00:00Z', sessionId: 's1',
      tool: 'run_command', summary: 'npm test', detail: 'detail', suggestedRules: ['run_command'],
    })
    const pending = q.pending()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ kind: 'approval', tool: 'run_command', summary: 'npm test' })
  })

  test('a resolved entry leaves the pending list but stays in the record', () => {
    const q = new DecisionQueue(root)
    q.add({ kind: 'question', id: 'd2', at: 'now', sessionId: 's1', question: 'which db?', options: ['a', 'b'] })
    expect(q.pending()).toHaveLength(1)
    q.resolve({ id: 'd2', answer: 'a' })
    expect(q.pending()).toHaveLength(0)
    // Append-only: the answer is added, the question is not erased.
    expect(q.all()).toHaveLength(2)
  })

  test('survives a restart, because a night\'s questions outlive the process', () => {
    const first = new DecisionQueue(root)
    first.add({ kind: 'question', id: 'd3', at: 'now', sessionId: 's1', question: 'q', options: [] })
    expect(new DecisionQueue(root).pending()).toHaveLength(1)
  })

  test('one corrupt line costs one decision, not the queue', () => {
    // What a crash mid-append looks like.
    const q = new DecisionQueue(root)
    q.add({ kind: 'question', id: 'd4', at: 'now', sessionId: 's1', question: 'kept', options: [] })
    const path = join(root, '.privatecode', 'decisions.jsonl')
    const body = readFileSync(path, 'utf8')
    rmSync(path)
    const half = '{"kind":"question","id":"d5"'
    const fs = require('node:fs') as typeof import('node:fs')
    fs.writeFileSync(path, `${half}\n${body}`, 'utf8')
    expect(q.pending()).toHaveLength(1)
    expect(q.pending()[0]).toMatchObject({ question: 'kept' })
  })

  test('an empty queue is not an error', () => {
    const q = new DecisionQueue(root)
    expect(q.pending()).toEqual([])
    expect(q.problems).toEqual([])
  })
})

describe('the queueing port', () => {
  const neverAnswers: InteractionPort = {
    requestApproval: () => new Promise(() => {}),
    askUser: () => new Promise(() => {}),
  }

  test('an unanswered approval parks and tells the agent to do something else', async () => {
    const queue = new DecisionQueue(root)
    const port = queueingPort(neverAnswers, { queue, sessionId: 's1', approvalTimeoutMs: 30 })

    const decision = await port.requestApproval(request)
    // Never 'allow'. That is the whole line.
    expect(decision.verdict).toBe('defer')
    expect(decision.verdict === 'defer' && decision.reason).toMatch(/queued for the user/)
    expect(decision.verdict === 'defer' && decision.reason).toMatch(/do not retry this call/)

    const pending = queue.pending()
    expect(pending).toHaveLength(1)
    // The rules the live card would have offered are kept, so answering in the morning is
    // still one click rather than a rule written from memory.
    expect(pending[0]).toMatchObject({ kind: 'approval', suggestedRules: request.suggestedRules })
  })

  test('an answer that arrives in time is used, and nothing is queued', async () => {
    const queue = new DecisionQueue(root)
    const answering: InteractionPort = {
      requestApproval: async () => ({ verdict: 'allow' as const }),
      askUser: async () => 'yes',
    }
    const port = queueingPort(answering, { queue, sessionId: 's1', approvalTimeoutMs: 5_000 })
    expect((await port.requestApproval(request)).verdict).toBe('allow')
    expect(await port.askUser({ question: 'q', options: [] })).toBe('yes')
    expect(queue.pending()).toEqual([])
  })

  test('an unanswered question tells the model to state its assumption, not to guess quietly', async () => {
    // ask_user exists so the model does not guess. Being told to guess is a real trade, and
    // it is stated as one: the assumption has to be visible in the reply.
    const queue = new DecisionQueue(root)
    const port = queueingPort(neverAnswers, { queue, sessionId: 's1', approvalTimeoutMs: 30 })
    const answer = await port.askUser({ question: 'which database?', options: ['sqlite', 'postgres'] })
    expect(answer).toMatch(/Nobody is available/)
    expect(answer).toMatch(/which assumption you made/)
    expect(queue.pending()[0]).toMatchObject({ kind: 'question', question: 'which database?' })
  })

  test('with no host at all it parks immediately instead of waiting out the timeout', async () => {
    const queue = new DecisionQueue(root)
    const port = queueingPort(undefined, { queue, sessionId: 's1', approvalTimeoutMs: 60_000 })
    const started = Date.now()
    expect((await port.requestApproval(request)).verdict).toBe('defer')
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test('a host that throws parks rather than failing the turn', async () => {
    const queue = new DecisionQueue(root)
    const broken: InteractionPort = {
      requestApproval: () => Promise.reject(new Error('socket died')),
      askUser: () => Promise.reject(new Error('socket died')),
    }
    const port = queueingPort(broken, { queue, sessionId: 's1', approvalTimeoutMs: 5_000 })
    expect((await port.requestApproval(request)).verdict).toBe('defer')
    expect(queue.pending()).toHaveLength(1)
  })

  test('todosChanged still reaches the real host', async () => {
    const seen: number[] = []
    const inner: InteractionPort = {
      requestApproval: async () => ({ verdict: 'deny' as const }),
      askUser: async () => '',
      todosChanged: (todos) => { seen.push(todos.length) },
    }
    const port = queueingPort(inner, { queue: new DecisionQueue(root), sessionId: 's1' })
    port.todosChanged?.([{ text: 'a', status: 'pending' }])
    expect(seen).toEqual([1])
  })
})
