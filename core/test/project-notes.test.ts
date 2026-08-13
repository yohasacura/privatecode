import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addProjectNote, loadProjectNotes, notesPath } from '../src/memory/project-notes.js'
import { rememberTool } from '../src/tools/remember.js'
import { Workspace } from '../src/workspace.js'
import { PRIVATE_DIR } from '../src/private-dir.js'

/**
 * The agent's own accumulated understanding, and the single property that makes it safe to
 * let it write here unsupervised: **a note cannot outlive the code it describes.**
 *
 * Everything else in this file is detail. If the invalidation ever stops working, the
 * feature becomes a file of confident sentences about code that has moved on — which is
 * strictly worse than not having it, because it is read first and trusted most.
 */

let root: string
const roots: string[] = []
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-notes-'))
  roots.push(root)
  mkdirSync(join(root, PRIVATE_DIR), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'act.ts'), 'export class ActNumberGenerator {}\n', 'utf8')
  writeFileSync(join(root, 'src', 'invoice.ts'), 'export class InvoiceService {}\n', 'utf8')
})
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('a note dies with the code it describes', () => {
  test('it loads while its files are untouched', () => {
    expect(addProjectNote(root, 'Act numbers come from a row-locked counter.', ['src/act.ts']).ok).toBe(true)
    const loaded = loadProjectNotes(root)
    expect(loaded.fresh).toHaveLength(1)
    expect(loaded.stale).toHaveLength(0)
    expect(loaded.text).toContain('row-locked counter')
  })

  test('it stops loading the moment one of them changes', () => {
    addProjectNote(root, 'Act numbers come from a row-locked counter.', ['src/act.ts'])
    writeFileSync(join(root, 'src', 'act.ts'), 'export class ActNumberGenerator { /* rewritten */ }\n', 'utf8')

    const loaded = loadProjectNotes(root)
    expect(loaded.fresh).toHaveLength(0)
    expect(loaded.stale).toHaveLength(1)
    // Out of the prompt entirely — not shown with a warning, because a warned-about claim
    // is still a claim, and this one is known to be unverified.
    expect(loaded.text).not.toContain('row-locked counter')
  })

  test('one changed file out of several is enough to drop it', () => {
    addProjectNote(root, 'Acts and invoices use separate sequences.', ['src/act.ts', 'src/invoice.ts'])
    writeFileSync(join(root, 'src', 'invoice.ts'), 'export class InvoiceService { /* moved on */ }\n', 'utf8')
    expect(loadProjectNotes(root).fresh).toHaveLength(0)
  })

  test('a deleted file drops it too', () => {
    addProjectNote(root, 'Acts come from a counter.', ['src/act.ts'])
    rmSync(join(root, 'src', 'act.ts'))
    expect(loadProjectNotes(root).fresh).toHaveLength(0)
  })

  test('a stale note is kept in the FILE, so the human can see what was believed', () => {
    addProjectNote(root, 'Acts come from a counter.', ['src/act.ts'])
    writeFileSync(join(root, 'src', 'act.ts'), 'changed\n', 'utf8')
    addProjectNote(root, 'Invoices are separate.', ['src/invoice.ts'])
    expect(readFileSync(notesPath(root), 'utf8')).toContain('Acts come from a counter')
  })
})

describe('what cannot be stored', () => {
  test('a claim with no evidence is refused — that is the whole safety property', () => {
    const r = addProjectNote(root, 'This project prefers composition over inheritance.', [])
    expect(r.ok).toBe(false)
    expect(r.problem).toContain('never be checked')
    // And nothing was written, so a refused note cannot half-exist.
    expect(loadProjectNotes(root).fresh).toHaveLength(0)
  })

  test('a claim whose files do not exist is refused', () => {
    const r = addProjectNote(root, 'Something about a file that is not here.', ['src/ghost.ts'])
    expect(r.ok).toBe(false)
    expect(r.problem).toContain('nothing to tie this note to')
  })

  test('the tool refuses an empty file list before touching the disk', () => {
    const v = rememberTool.validate({ note: 'a fact', files: [] })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.error).toContain('at least one')
  })

  test('an essay is refused; a note is a fact, not a document', () => {
    const r = addProjectNote(root, 'x'.repeat(500), ['src/act.ts'])
    expect(r.ok).toBe(false)
    expect(r.problem).toContain('under 400 characters')
  })
})

describe('the file a person reads', () => {
  test('it is markdown, and says how it works', () => {
    addProjectNote(root, 'Acts come from a counter.', ['src/act.ts'])
    const text = readFileSync(notesPath(root), 'utf8')
    expect(text).toContain('# What PrivateCode has learned')
    // The sentence that tells a reader why they can trust the file, not just what it is.
    expect(text).toContain('quietly describe code that has moved on')
    // The evidence rides in an HTML comment: invisible when rendered, trivial to parse.
    expect(text).toMatch(/<!-- from: src\/act\.ts@[0-9a-f]{12} -->/)
  })

  test('the prompt block says the code outranks the note', () => {
    addProjectNote(root, 'Acts come from a counter.', ['src/act.ts'])
    const { text } = loadProjectNotes(root)
    expect(text).toContain('the code is right and the note is out of date')
  })
})

describe('end to end through the tool', () => {
  test('a note recorded now is loaded next session', async () => {
    const ctx = { workspace: new Workspace(root) }
    const v = rememberTool.validate({
      note: 'Acts and invoices keep separate gap-free counters.',
      files: ['src/act.ts', 'src/invoice.ts'],
    })
    expect(v.ok).toBe(true)
    if (!v.ok) return
    const r = await rememberTool.execute(v.args, ctx)
    expect(r.ok).toBe(true)
    expect(r.content).toContain('src/act.ts')

    expect(loadProjectNotes(root).text).toContain('separate gap-free counters')
  })

  test('a workspace with no notes file adds nothing to the prompt', () => {
    const loaded = loadProjectNotes(root)
    expect(loaded.text).toBe('')
    expect(loaded.problems).toEqual([])
  })
})
