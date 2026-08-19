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

describe('evidence is located the way the model addresses it', () => {
  /** A workspace of two folders, which is when paths grow a folder prefix. */
  function twoFolders(): { ws: Workspace; libRoot: string } {
    const libRoot = mkdtempSync(join(tmpdir(), 'pc-notes-lib-'))
    roots.push(libRoot)
    writeFileSync(join(libRoot, 'engine.ts'), 'export const version = 1\n', 'utf8')
    const ws = new Workspace([
      { name: 'app', root, access: 'write', primary: true },
      { name: 'lib', root: libRoot, access: 'write', primary: false },
    ])
    return { ws, libRoot }
  }

  test('a note about a file in an ATTACHED folder is stored, not refused', () => {
    // The reported failure, in the shape it actually reaches people: the model names the
    // file the way every tool showed it to it — `lib/engine.ts` — and the note is refused
    // because `join(primaryRoot, 'lib/engine.ts')` names nothing.
    const { ws } = twoFolders()
    const r = addProjectNote(root, 'The engine version is pinned in one place.', ['lib/engine.ts'], ws)
    expect(r.problem).toBeUndefined()
    expect(r.ok).toBe(true)
    expect(r.note?.evidence[0]?.path).toBe('lib/engine.ts')
  })

  test('and it loads as fresh, then goes stale when that file changes', () => {
    const { ws, libRoot } = twoFolders()
    addProjectNote(root, 'The engine version is pinned in one place.', ['lib/engine.ts'], ws)
    expect(loadProjectNotes(root, ws).fresh).toHaveLength(1)

    writeFileSync(join(libRoot, 'engine.ts'), 'export const version = 2\n', 'utf8')
    const after = loadProjectNotes(root, ws)
    expect(after.fresh).toHaveLength(0)
    expect(after.stale).toHaveLength(1)
  })

  test('the primary folder keeps working, prefix and all', () => {
    const { ws } = twoFolders()
    expect(addProjectNote(root, 'Acts come from a counter.', ['app/src/act.ts'], ws).ok).toBe(true)
    expect(loadProjectNotes(root, ws).fresh).toHaveLength(1)
  })

  test('a path outside every folder is still refused, and says what to do', () => {
    const { ws } = twoFolders()
    const r = addProjectNote(root, 'Something about elsewhere.', ['../outside.ts'], ws)
    expect(r.ok).toBe(false)
    expect(r.problem).toMatch(/nothing to tie this note to/)
    // The refusal has to be actionable, or the model repeats the same call forever.
    expect(r.problem).toMatch(/exactly as the tools address it/)
  })

  test('without a locator the old single-folder behaviour is unchanged', () => {
    // The CLI one-shot mode and every test that predates the locator take this path.
    expect(addProjectNote(root, 'Acts come from a counter.', ['src/act.ts']).ok).toBe(true)
    expect(loadProjectNotes(root).fresh).toHaveLength(1)
  })
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

  test('a novel is refused; a rich write-up is not', () => {
    // Raised from 400 live: the model kept losing genuinely important long findings.
    const r = addProjectNote(root, 'x'.repeat(21_000), ['src/act.ts'])
    expect(r.ok).toBe(false)
    expect(r.problem).toContain('under 20000 characters')
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

describe('long notes', () => {
  test('a multi-line write-up with markdown headings survives the round trip', () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-notes-'))
    try {
      mkdirSync(join(root, '.privatecode'), { recursive: true })
      writeFileSync(join(root, 'a.ts'), 'x', 'utf8')
      const text = [
        'Карта подсистемы компакта:', '',
        '## Триггеры', '1. ratio', '2. triggerTokens (140k default)', '',
        '## Своп', 'buildSwapTranscript is shared with the prewarm.',
      ].join('\n')
      const added = addProjectNote(root, text, ['a.ts'])
      expect(added.ok).toBe(true)
      const loaded = loadProjectNotes(root)
      expect(loaded.fresh).toHaveLength(1)
      // The reserved `^## ` is neutralised with a leading space; nothing after it is lost.
      expect(loaded.fresh[0]!.text).toContain(' ## Триггеры')
      expect(loaded.fresh[0]!.text).toContain('buildSwapTranscript is shared')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('a long note renders as an indented block, not one flattened line', () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-notes-'))
    try {
      mkdirSync(join(root, '.privatecode'), { recursive: true })
      writeFileSync(join(root, 'a.ts'), 'x', 'utf8')
      const long = `Первая строка.\n${'Подробность про архитектуру. '.repeat(12)}\nПоследняя строка.`
      expect(addProjectNote(root, long, ['a.ts']).ok).toBe(true)
      const block = loadProjectNotes(root).text
      expect(block).toContain('- [a.ts]\n  Первая строка.')
      expect(block).toContain('\n  Последняя строка.')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('the cap now admits a real write-up and still refuses a novel', () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-notes-'))
    try {
      mkdirSync(join(root, '.privatecode'), { recursive: true })
      writeFileSync(join(root, 'a.ts'), 'x', 'utf8')
      expect(addProjectNote(root, 'x'.repeat(19_000), ['a.ts']).ok).toBe(true)
      expect(loadProjectNotes(root).text).toContain('x'.repeat(19_000))
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
