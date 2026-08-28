import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { recallTool } from '../src/tools/recall.js'
import { rememberTool } from '../src/tools/remember.js'
import { Workspace } from '../src/workspace.js'
import type { ToolContext } from '../src/tools/types.js'

/**
 * Reading back what `remember` stored.
 *
 * The behaviour that matters is the refusal, not the retrieval: the notes FILE holds every
 * note ever written, and the loader is what drops the ones whose evidence has changed.
 * Asked how to read its notes and having no tool for it, the model found the file and told
 * the user to `read_file('.privatecode/project-notes.md')` — which returns exactly the
 * stale, confident sentences about moved-on code that the whole design exists to prevent.
 * These tests pin that this tool cannot become that workaround.
 */

let root: string
let ctx: ToolContext

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-recall-'))
  // The app makes this on open; a bare temp directory does not have it, and `remember`
  // writes into it rather than creating it.
  mkdirSync(join(root, '.privatecode'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')
  ctx = { workspace: new Workspace(root) } as ToolContext
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const remember = async (note: string, files: string[]): Promise<void> => {
  const r = await rememberTool.execute({ note, files }, ctx)
  if (!r.ok) throw new Error(`the fixture could not store a note: ${r.content}`)
}

test('with nothing recorded it says so, rather than nothing', async () => {
  const r = await recallTool.execute({}, ctx)
  expect(r.ok).toBe(true)
  expect(r.content).toContain('No project notes are recorded yet')
})

test('a note recorded THIS session is readable at once', async () => {
  // The hole message 0 cannot cover: it is frozen when the session is built, so a note the
  // model just wrote is invisible to it until tomorrow — including for the purpose of not
  // writing the same note twice.
  await remember('The tree panel refreshes on window focus.', ['src/a.ts'])

  const r = await recallTool.execute({}, ctx)
  expect(r.content).toContain('The tree panel refreshes on window focus.')
})

test('a note whose evidence changed is NOT returned, and its absence is explained', async () => {
  await remember('a.ts exports exactly one constant', ['src/a.ts'])
  // The file moves on. The note is now folklore.
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1\nexport const b = 2\n', 'utf8')

  const r = await recallTool.execute({}, ctx)
  expect(r.content).not.toContain('a.ts exports exactly one constant')
  // Silence here would read as "you never recorded anything", which is a different and
  // wrong fact — the note is in the file, it just is not evidence of anything any more.
  expect(r.content).toContain('No project notes still hold')
  expect(r.content).toContain('1 more note is stored but not shown')
})

test('fresh and stale together: only the fresh one comes back, with a count of the rest', async () => {
  writeFileSync(join(root, 'src', 'b.ts'), 'export const b = 1\n', 'utf8')
  await remember('the stale one, about a.ts', ['src/a.ts'])
  await remember('the fresh one, about b.ts', ['src/b.ts'])
  writeFileSync(join(root, 'src', 'a.ts'), 'changed\n', 'utf8')

  const r = await recallTool.execute({}, ctx)
  expect(r.content).toContain('the fresh one, about b.ts')
  expect(r.content).not.toContain('the stale one, about a.ts')
  expect(r.content).toContain('1 more note is stored but not shown')
})

test('it steers away from the workaround it exists to replace', async () => {
  await remember('something', ['src/a.ts'])
  writeFileSync(join(root, 'src', 'a.ts'), 'changed\n', 'utf8')

  const r = await recallTool.execute({}, ctx)
  // Said in the result rather than left to the tool description, because the description is
  // read once and this is read at the moment the temptation appears.
  expect(r.content).toContain('Do not go read the file')
})

test('it is read-only, so plan mode can use it', () => {
  // A plan built without what earlier sessions worked out is a plan that re-derives them,
  // which is the cost `remember` exists to remove.
  expect(recallTool.readOnly).toBe(true)
})
