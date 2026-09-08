import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../src/workspace.js'
import { editFileTool } from '../src/tools/edit-file.js'
import { readFileTool } from '../src/tools/read-file.js'
import { writeFileTool } from '../src/tools/write-file.js'
import { ReadMemory } from '../src/tools/read-memory.js'
import { editorconfigGlobToRegExp, endOfLineFrom, endingConvention } from '../src/tools/endings-convention.js'
import { applySearchReplace } from '../src/edit/search-replace.js'

/**
 * The file tools' polish, from what the sessions showed: an Edit that misses says where the
 * anchor and the file part ways; an ambiguous anchor names its places, or replace_all takes
 * them all; a Write that replaces a file this session never read whole, or shrinks it, says
 * so; a new file takes the line endings its neighbours or the .editorconfig use.
 */

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pc-polish-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const ctx = () => ({ workspace: new Workspace(root), reads: new ReadMemory() })

describe('Edit hints and replace_all', () => {
  const SRC = [
    'function total(items) {',
    '  let sum = 0;',
    '  for (const item of items) sum += item.price;',
    '  return sum;',
    '}',
    'function count(items) {',
    '  let sum = 0;',
    '  for (const item of items) sum += 1;',
    '  return sum;',
    '}',
    '',
  ].join('\n')

  test('a missed anchor is told the line where it differs from the closest match', () => {
    const out = applySearchReplace(SRC, '  let sum = 0;\n  for (const item of items) sum += item.cost;\n  return sum;', 'x')
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.hint).toContain('starts at line 2')
    expect(out.hint).toContain('It differs at line 2 of your anchor: you wrote "for (const item of items) sum += item.cost;", the file has "for (const item of items) sum += item.price;"')
  })

  test('an ambiguous anchor names the lines it occurs at and offers replace_all', () => {
    const out = applySearchReplace(SRC, '  let sum = 0;', '  let sum = 0.0;')
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.hint).toContain('occurs in 2 places (lines 2, 7)')
    expect(out.hint).toContain('replace_all')
  })

  test('replace_all changes every exact occurrence and counts them', () => {
    const out = applySearchReplace(SRC, 'sum', 'acc', { all: true })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.replaced).toBe(6)
    expect(out.text).not.toContain('sum')
    expect(out.text).toContain('let acc = 0;')
    // Nothing to rename is still not found — with the usual hint, never a silent no-op.
    const none = applySearchReplace(SRC, 'total_amount', 'x', { all: true })
    expect(none.ok).toBe(false)
  })

  test('the tool takes replace_all, notes the count, and previews it for approval', async () => {
    writeFileSync(join(root, 'a.ts'), SRC, 'utf8')
    const c = ctx()
    const refused = editFileTool.validate({ path: 'a.ts', search_text: 'sum', replace_text: 'acc', replace_all: 'yes' })
    expect(refused.ok).toBe(false)
    const preview = editFileTool.approvalPreview!({ path: 'a.ts', search_text: 'sum', replace_text: 'acc', replace_all: true }, c)
    expect(preview.summary).toBe('edit a.ts (every occurrence)')
    const r = await editFileTool.execute({ path: 'a.ts', search_text: 'sum', replace_text: 'acc', replace_all: true }, c)
    expect(r.ok).toBe(true)
    expect(r.content).toContain('replaced 6 occurrences')
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).not.toContain('sum')
    // Without it, the same anchor is refused as ambiguous, with the places named.
    writeFileSync(join(root, 'b.ts'), SRC, 'utf8')
    const amb = await editFileTool.execute({ path: 'b.ts', search_text: '  let sum = 0;', replace_text: '  let sum = 1;' }, c)
    expect(amb.ok).toBe(false)
    expect(amb.content).toContain('lines 2, 7')
  })
})

describe('Edit names an anchor that is mostly context', () => {
  const FILE = [
    'export function total(items) {',
    '  let sum = 0;',
    '  for (const item of items) {',
    '    sum += item.price;',
    '  }',
    '  return sum;',
    '}',
    '',
  ].join('\n')

  test('a whole block copied around a one-line change is noted; a tight anchor is not', async () => {
    writeFileSync(join(root, 'w.ts'), FILE, 'utf8')
    const c = ctx()
    const heavy = await editFileTool.execute({
      path: 'w.ts',
      search_text: FILE.trimEnd(),
      replace_text: FILE.trimEnd().replace('sum += item.price;', 'sum += item.price * item.qty;'),
    }, c)
    expect(heavy.ok).toBe(true)
    expect(heavy.content).toContain('the anchor carried 6 unchanged lines around a 1-line change')

    writeFileSync(join(root, 't.ts'), FILE, 'utf8')
    const tight = await editFileTool.execute({
      path: 't.ts',
      search_text: '    sum += item.price;\n  }',
      replace_text: '    sum += item.price * item.qty;\n  }',
    }, c)
    expect(tight.ok).toBe(true)
    expect(tight.content).not.toContain('unchanged lines')
  })
})

describe('Write says what only it can know', () => {
  test('replacing a file this session never read whole, or shrinking it, is noted', async () => {
    writeFileSync(join(root, 'big.ts'), `${'export const x = 1;\n'.repeat(50)}`, 'utf8')
    const c = ctx()
    const blind = await writeFileTool.execute({ path: 'big.ts', content: 'export const x = 2;\n' }, c)
    expect(blind.ok).toBe(true)
    expect(blind.content).toContain('had not read the whole file it replaced')
    expect(blind.content).toMatch(/shrank from \d+ to \d+ bytes/)
  })

  test('a file read whole and rewritten to a similar size gets neither note', async () => {
    writeFileSync(join(root, 'small.ts'), 'export const x = 1;\n', 'utf8')
    const c = ctx()
    await readFileTool.execute({ path: 'small.ts' }, c)
    const r = await writeFileTool.execute({ path: 'small.ts', content: 'export const x = 2;\n' }, c)
    expect(r.ok).toBe(true)
    expect(r.content).not.toContain('had not read')
    expect(r.content).not.toContain('shrank')
  })

  test('a new file takes the line ending of the files beside it', async () => {
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'A.cs'), 'class A {\r\n}\r\n', 'utf8')
    writeFileSync(join(root, 'src', 'B.cs'), 'class B {\r\n}\r\n', 'utf8')
    const r = await writeFileTool.execute({ path: 'src/C.cs', content: 'class C {\n}\n' }, ctx())
    expect(r.ok).toBe(true)
    expect(r.content).toContain("line endings follow the folder's other files (CRLF)")
    expect(readFileSync(join(root, 'src', 'C.cs'), 'utf8')).toBe('class C {\r\n}\r\n')
  })

  test('an .editorconfig outranks the neighbours, and root = true stops the walk', async () => {
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'A.cs'), 'class A {\r\n}\r\n', 'utf8')
    writeFileSync(join(root, '.editorconfig'), 'root = true\n\n[*]\nindent_style = space\n\n[*.{cs,ts}]\nend_of_line = lf\n', 'utf8')
    const lf = await writeFileTool.execute({ path: 'src/C.cs', content: 'class C {\n}\n' }, ctx())
    expect(lf.ok).toBe(true)
    expect(lf.content).not.toContain('line endings')
    expect(readFileSync(join(root, 'src', 'C.cs'), 'utf8')).toBe('class C {\n}\n')

    // A nearer file that says nothing about endings but ends the search: the neighbours
    // decide — two CRLF files against the LF one written just above.
    writeFileSync(join(root, 'src', '.editorconfig'), 'root = true\n[*]\nindent_size = 4\n', 'utf8')
    writeFileSync(join(root, 'src', 'B.cs'), 'class B {\r\n}\r\n', 'utf8')
    expect(await endingConvention(join(root, 'src', 'D.cs'), root)).toEqual({ eol: '\r\n', source: 'siblings' })
    // And a folder with nothing beside the new file, and no .editorconfig above it,
    // expresses no preference.
    rmSync(join(root, '.editorconfig'))
    mkdirSync(join(root, 'empty'))
    expect(await endingConvention(join(root, 'empty', 'E.cs'), root)).toBeNull()
  })

  test('.editorconfig sections are read the way the format means them', () => {
    const text = '# comment\nroot = true\n\n[*]\nend_of_line = lf\n\n[*.cs]\nend_of_line = crlf\n\n[docs/**.md]\nend_of_line = lf\n'
    expect(endOfLineFrom(text, 'src/A.cs')).toEqual({ eol: '\r\n', root: true })
    expect(endOfLineFrom(text, 'src/a.ts')).toEqual({ eol: '\n', root: true })
    expect(endOfLineFrom(text, 'docs/x/y.md')).toEqual({ eol: '\n', root: true })
    expect(endOfLineFrom('[*.cs]\nindent_size = 4\n', 'A.cs')).toEqual({ eol: null, root: false })
    expect(editorconfigGlobToRegExp('*.cs').test('a/b.cs')).toBe(false)
    expect(editorconfigGlobToRegExp('**.cs').test('a/b.cs')).toBe(true)
    expect(editorconfigGlobToRegExp('*.{cs,ts}').test('b.ts')).toBe(true)
    expect(editorconfigGlobToRegExp('Makefile').test('Makefile')).toBe(true)
  })
})
