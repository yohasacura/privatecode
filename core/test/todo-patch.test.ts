import { expect, test } from 'vitest'
import { todoWriteTool } from '../src/tools/todo-write.js'
import { TodoStore } from '../src/interaction.js'
import type { TodoItem } from '../src/interaction.js'

/**
 * Ticking a box should cost about as much as a tick.
 *
 * `todo_write` had one shape: send the whole list. Writing a plan that way is natural —
 * you are writing all of it anyway. Updating it that way means re-emitting every step with
 * its text and its done_when, verbatim, or the plan silently mutates: a thousand-odd
 * characters of JSON, ten to twenty seconds of generation on this machine, to record one
 * boolean.
 *
 * Reported by the owner as "the model stopped using the plan — it creates it and then never
 * marks anything". That is the shape of the bill, not a failure of memory: creation is a
 * whole-list write and happens, and every update after it costs the same and does not.
 */

function store(...items: string[]): TodoStore {
  const s = new TodoStore()
  s.set(items.map((text) => ({ text, status: 'pending' as const })))
  return s
}

async function call(s: TodoStore, raw: unknown): Promise<{ ok: boolean; content: string }> {
  const v = todoWriteTool.validate(raw)
  if (!v.ok) return { ok: false, content: v.error }
  return await todoWriteTool.execute(v.args, { todos: s } as never)
}

test('one number marks one step done, and that is the whole call', async () => {
  const s = store('read the service', 'add the lock', 'write the test')
  const r = await call(s, { complete: [2] })
  expect(r.ok).toBe(true)
  expect(s.list().map((t) => t.status)).toEqual(['pending', 'completed', 'pending'])
})

test('finishing one step and starting the next is one call, because it is one thought', async () => {
  const s = store('a', 'b', 'c')
  await call(s, { complete: [1], start: 2 })
  expect(s.list().map((t) => t.status)).toEqual(['completed', 'in_progress', 'pending'])
})

test('moving forward finishes the step you were on — the measured heart of this', async () => {
  // Live, six times out of six: told the plan and asked to bring it up to date, the model
  // calls `start: 3` and says nothing about step 2. To a person "I am on the next one" IS
  // the whole message. The first version demoted step 2 to pending and scored 1/6 correct;
  // completing it scores 6/6.
  const s = store('a', 'b', 'c')
  await call(s, { start: 2 })
  await call(s, { start: 3 })
  expect(s.list().map((t) => t.status)).toEqual(['pending', 'completed', 'in_progress'])
})

test('but going BACK to an earlier step does not finish the one you are leaving', async () => {
  // Naming an earlier step is revisiting something, and calling the abandoned step done is
  // exactly the wrong reading of that.
  const s = store('a', 'b', 'c')
  await call(s, { start: 3 })
  await call(s, { start: 1 })
  expect(s.list().map((t) => t.status)).toEqual(['in_progress', 'pending', 'pending'])
})

test('only one step is ever in progress', async () => {
  const s = store('a', 'b', 'c')
  await call(s, { start: 1 })
  await call(s, { start: 3 })
  expect(s.list().filter((t) => t.status === 'in_progress')).toHaveLength(1)
})

test('steps the work uncovered append as pending', async () => {
  const s = store('a')
  await call(s, { add: [{ text: 'the migration nobody mentioned', done_when: 'it runs' }] })
  expect(s.list()).toHaveLength(2)
  expect(s.list()[1]).toEqual({
    text: 'the migration nobody mentioned', status: 'pending', done_when: 'it runs',
  })
})

test('a step number that does not exist is refused, with the range spelled out', async () => {
  // Silently skipping it is the quietest possible failure: the model believes step 7 is
  // done, the plan says otherwise, and nothing ever reconciles them.
  const s = store('a', 'b')
  const r = await call(s, { complete: [7] })
  expect(r.ok).toBe(false)
  expect(r.content).toContain('no step 7')
  expect(r.content).toContain('the plan has 2 steps')
  expect(s.list().map((t) => t.status)).toEqual(['pending', 'pending'])
})

test('an index-sized edit with no plan says to write one first', async () => {
  const s = new TodoStore()
  const r = await call(s, { complete: [1] })
  expect(r.ok).toBe(false)
  expect(r.content).toContain('no plan yet')
})

test('the result shows the whole plan back, numbered', async () => {
  // The result of a call is prefix the model reads on its next step, and information there
  // is the one channel this model is measured to follow. So the cheapest moment to show
  // what the plan now says is the moment it changed.
  const s = store('read the service', 'add the lock')
  const r = await call(s, { complete: [1], start: 2 })
  expect(r.content).toContain('1. [x] read the service')
  expect(r.content).toContain('2. [>] add the lock')
  expect(r.content).toContain('1 of 2 still open')
})

test('an empty call says what the two shapes are, rather than failing blankly', async () => {
  const v = todoWriteTool.validate({})
  expect(v.ok).toBe(false)
  if (v.ok) return
  expect(v.error).toContain('complete')
  expect(v.error).toContain('todos')
})

test('the full-list form still replaces the plan, unchanged', async () => {
  const s = store('old')
  const todos: TodoItem[] = [{ text: 'new one', status: 'in_progress' }, { text: 'new two', status: 'pending' }]
  const r = await call(s, { todos })
  expect(r.ok).toBe(true)
  expect(s.list().map((t) => t.text)).toEqual(['new one', 'new two'])
})

test('the description leads with the cheap form, since that is the call that was not happening', () => {
  const d = todoWriteTool.description
  expect(d).toContain('complete: [2, 3]')
  expect(d).toContain('Do not re-send the whole list to tick a box')
  expect(d.indexOf('complete')).toBeLessThan(d.indexOf('full list'))
})

test('naming the same step as finished AND current leaves it current, not cursorless', async () => {
  // Obeying the plan-focus note literally: it says finish step N and send `complete: [N]`,
  // and the model often adds `start: N` in the same breath. Completing it left the plan with
  // no in-progress step at all, and the note then points at the first PENDING one — which is
  // behind where the work is, so the next nudge pushes the model backwards.
  const s = store('a', 'b', 'c')
  await call(s, { start: 2 })
  await call(s, { complete: [2], start: 2 })
  expect(s.list().map((t) => t.status)).toEqual(['pending', 'in_progress', 'pending'])
})

test('add cannot walk the plan past the ceiling the whole-list form enforces', async () => {
  const s = store(...Array.from({ length: 49 }, (_, i) => `step ${i + 1}`))
  const ok = await call(s, { add: [{ text: 'one more that fits' }] })
  expect(ok.ok).toBe(true)
  expect(s.list()).toHaveLength(50)

  const refused = await call(s, { add: [{ text: 'the one too many' }] })
  expect(refused.ok).toBe(false)
  expect(refused.content).toContain('at most 50')
  // And it did not half-apply: the plan is exactly as it was.
  expect(s.list()).toHaveLength(50)
})

/**
 * Closing the plan.
 *
 * There was no way to do it. `todos: []` is refused as "at least 1 item", and the only two
 * callers that could empty the plan are the window's own button and the acceptance gate
 * retiring a satisfied contract. So a model that had finished could tick every box and leave
 * a completed card on screen, or replace the plan with a different one — which is what the
 * owner watched it do, and reported as "it cannot close a plan, only recreate one".
 */
test('clear closes the plan', async () => {
  const s = new TodoStore()
  s.set([
    { text: 'one', status: 'completed' },
    { text: 'two', status: 'completed' },
  ])

  const r = await call(s, { clear: true })

  expect(r.ok).toBe(true)
  expect(s.list()).toEqual([])
  expect(r.content).toContain('2 steps are gone')
})

test('clearing nothing says so rather than pretending', async () => {
  const s = new TodoStore()
  const r = await call(s, { clear: true })
  expect(r.ok).toBe(true)
  expect(r.content).toContain('no plan to close')
})

test('clear cannot be combined with edits to the plan it closes', async () => {
  const s = new TodoStore()
  s.set([{ text: 'one', status: 'pending' }])

  // Two different intentions in one call: applying them needs an order, and either order is
  // a guess about what was meant.
  const r = await call(s, { clear: true, complete: [1] })

  expect(r.ok).toBe(false)
  expect(r.content).toContain('cannot be combined')
  expect(s.list()).toHaveLength(1)
})

test('an empty todos list is still refused, so the two ways cannot be confused', async () => {
  const s = new TodoStore()
  s.set([{ text: 'one', status: 'pending' }])

  // `todos: []` reads as "restructure the plan into nothing", which is the same outcome by
  // a route that says something else. Closing is its own verb.
  const r = await call(s, { todos: [] })

  expect(r.ok).toBe(false)
  expect(s.list()).toHaveLength(1)
})
