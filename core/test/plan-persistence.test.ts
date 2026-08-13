import { afterEach, beforeEach, expect, test } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TodoStore } from '../src/interaction.js'
import { todoWriteTool } from '../src/tools/todo-write.js'
import { continuationInventory } from '../src/session/compaction.js'
import { statePath } from '../src/private-dir.js'
import { Workspace } from '../src/workspace.js'

/**
 * The plan outlives the conversation that made it.
 *
 * It always survived compaction — it lives in the store, not the transcript. What it did
 * not survive was closing the app, which is the case that matters for a task spanning days.
 */

let root: string
const roots: string[] = []
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-plan-'))
  roots.push(root)
  mkdirSync(join(root, '.privatecode'), { recursive: true })
})
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true })
})

test('a plan written by one store is read by the next one', () => {
  const first = new TodoStore(root)
  first.set([
    { text: 'thread Currency through the handlers', status: 'in_progress', done_when: 'dotnet build passes' },
    { text: 'update the DTOs', status: 'pending' },
  ])
  // A new store is what a restarted app has.
  const second = new TodoStore(root)
  expect(second.list()).toHaveLength(2)
  expect(second.list()[0]).toMatchObject({ status: 'in_progress', done_when: 'dotnet build passes' })
})

test('the file lands under state/, not where a person is invited to write', () => {
  new TodoStore(root).set([{ text: 'a step', status: 'pending' }])
  expect(existsSync(statePath(root, 'plan.json'))).toBe(true)
})

test('a store with no workspace keeps the plan in memory and writes nothing', () => {
  const store = new TodoStore()
  store.set([{ text: 'a step', status: 'pending' }])
  expect(store.list()).toHaveLength(1)
  expect(existsSync(statePath(root, 'plan.json'))).toBe(false)
})

test('a corrupt plan file is an empty plan, not a broken session', () => {
  mkdirSync(join(root, '.privatecode', 'state'), { recursive: true })
  writeFileSync(statePath(root, 'plan.json'), '{ not json', 'utf8')
  expect(() => new TodoStore(root)).not.toThrow()
  expect(new TodoStore(root).list()).toEqual([])
})

test('done_when is validated, normalised, and stray keys are dropped', () => {
  const v = todoWriteTool.validate({
    todos: [{ text: 'a step', status: 'pending', done_when: '  tests green  ', nonsense: 1 }],
  })
  expect(v.ok).toBe(true)
  if (!v.ok) return
  expect(v.args.todos[0]).toEqual({ text: 'a step', status: 'pending', done_when: 'tests green' })

  const tooLong = todoWriteTool.validate({
    todos: [{ text: 'a step', status: 'pending', done_when: 'x'.repeat(300) }],
  })
  expect(tooLong.ok).toBe(false)
})

test('the done criterion survives into the post-compaction briefing', async () => {
  // The point of recording it: after a swap, "what counts as finished" is precisely what
  // the replaced conversation was carrying.
  const store = new TodoStore(root)
  const ctx = { workspace: new Workspace(root), todos: store }
  const v = todoWriteTool.validate({
    todos: [{ text: 'thread Currency through', status: 'in_progress', done_when: 'dotnet build passes' }],
  })
  expect(v.ok).toBe(true)
  if (!v.ok) return
  await todoWriteTool.execute(v.args, ctx)

  const briefing = continuationInventory([], store.list())
  expect(briefing).toContain('thread Currency through')
  expect(briefing).toContain('done when: dotnet build passes')
})

test('a completed step is not carried into the briefing', () => {
  const store = new TodoStore(root)
  store.set([
    { text: 'done already', status: 'completed', done_when: 'was checked' },
    { text: 'still open', status: 'pending' },
  ])
  const briefing = continuationInventory([], store.list())
  expect(briefing).not.toContain('done already')
  expect(briefing).toContain('still open')
})
