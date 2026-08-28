import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ATTACH_BUDGET_CHARS, attachFiles } from '../src/host/attachments.js'
import { Workspace } from '../src/workspace.js'

/**
 * Files attached to a message with `@`.
 *
 * What is really being tested here is honesty under a budget: the contents land in an
 * append-only transcript forever, so they have to be bounded — and a bounded attachment that
 * did not SAY it was bounded would leave the model answering confidently about code it was
 * never shown.
 */

let root: string
let ws: Workspace

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-attach-'))
  ws = new Workspace(root)
  mkdirSync(join(root, 'src'), { recursive: true })
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const write = (rel: string, body: string): void => writeFileSync(join(root, rel), body, 'utf8')

describe('attaching files to a message', () => {
  test('nothing attached leaves the message exactly as typed', async () => {
    expect(await attachFiles(ws, [], 'just a question')).toEqual({ text: 'just a question', notes: [] })
  })

  test('the file comes first and the ask comes last', async () => {
    // Instruction-following degrades when the ask is buried above a few hundred lines of
    // source, and the ask is the part that must not be missed.
    write('src/a.ts', 'export const a = 1')
    const { text } = await attachFiles(ws, ['src/a.ts'], 'rename it')
    expect(text.indexOf('src/a.ts')).toBeLessThan(text.indexOf('rename it'))
    expect(text.endsWith('rename it')).toBe(true)
  })

  test('contents arrive in read_file\'s own numbered format', async () => {
    write('src/a.ts', 'one\ntwo')
    const { text } = await attachFiles(ws, ['src/a.ts'], 'q')
    expect(text).toContain('1\tone')
    expect(text).toContain('2\ttwo')
  })

  test('the same file twice is attached once', async () => {
    write('src/a.ts', 'body')
    const { text } = await attachFiles(ws, ['src/a.ts', 'src/a.ts'], 'q')
    expect(text.split('--- src/a.ts').length - 1).toBe(1)
  })

  test('a clipped file says so, to the model and to the user', async () => {
    write('src/big.ts', 'x'.repeat(50_000))
    const { text, notes } = await attachFiles(ws, ['src/big.ts'], 'q')
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('clipped')
    expect(notes[0]).toContain('read_file')
    // The model is told inside the block itself, not only in the UI.
    expect(text).toContain('clipped')
  })

  test('the budget is spent, not exceeded, and what missed out is named', async () => {
    write('src/one.ts', 'a'.repeat(30_000))
    write('src/two.ts', 'b'.repeat(30_000))
    write('src/three.ts', 'c')
    const { text, notes } = await attachFiles(ws, ['src/one.ts', 'src/two.ts', 'src/three.ts'], 'q')
    expect(text.length).toBeLessThan(ATTACH_BUDGET_CHARS * 1.3) // + headers and line numbers
    expect(notes.some((n) => n.includes('src/three.ts') && n.includes('budget'))).toBe(true)
  })

  test('a missing file is reported, and the rest still go', async () => {
    write('src/a.ts', 'real')
    const { text, notes } = await attachFiles(ws, ['src/gone.ts', 'src/a.ts'], 'q')
    expect(notes.some((n) => n.includes('src/gone.ts'))).toBe(true)
    expect(text).toContain('1\treal')
  })

  test('a path outside the workspace is refused by the jail, not read', async () => {
    // The picker only offers paths inside, but `send` is a protocol method and its params
    // are not trusted for that reason alone.
    const { notes } = await attachFiles(ws, ['../../../etc/passwd'], 'q')
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatch(/could not be read/)
  })
})

/**
 * Attaching a FOLDER.
 *
 * Before this existed the path went straight to `readFile`, which fails on a directory with
 * EISDIR, so dropping a folder onto the window produced "could not be read (EISDIR: illegal
 * operation on a directory)" — an implementation detail offered as an answer to a reasonable
 * request. A folder attaches as the LISTING of what is in it, because contents would spend
 * the whole budget on whichever files were walked first.
 */
describe('attaching a folder', () => {
  test('a folder attaches as the files under it, not their contents', async () => {
    mkdirSync(join(root, 'src', 'deep'), { recursive: true })
    write('src/a.ts', 'export const a = 1')
    write('src/deep/b.ts', 'SHOULD-NOT-APPEAR-VERBATIM')

    const r = await attachFiles(ws, ['src'], 'what is in there?')

    expect(r.text).toContain('src/a.ts')
    expect(r.text).toContain('src/deep/b.ts')
    // The whole point of a listing: the bodies stay on disk until read_file asks for one.
    expect(r.text).not.toContain('SHOULD-NOT-APPEAR-VERBATIM')
    expect(r.text).toContain('what is in there?')
    expect(r.notes.join(' ')).toContain('2 files')
  })

  test('the EISDIR message is gone', async () => {
    mkdirSync(join(root, 'empty-ish'), { recursive: true })
    write('empty-ish/x.txt', 'x')
    const r = await attachFiles(ws, ['empty-ish'], 'hi')
    expect(r.notes.join(' ')).not.toContain('EISDIR')
    expect(r.notes.join(' ')).not.toContain('could not be read')
  })

  test('a folder with no files says so rather than attaching nothing', async () => {
    mkdirSync(join(root, 'hollow'), { recursive: true })
    const r = await attachFiles(ws, ['hollow'], 'hi')
    expect(r.notes.join(' ')).toContain('no files in it')
  })

  test('the listing skips dependency directories', async () => {
    mkdirSync(join(root, 'proj', 'node_modules', 'pkg'), { recursive: true })
    write('proj/node_modules/pkg/index.js', 'x')
    mkdirSync(join(root, 'proj', 'src'), { recursive: true })
    write('proj/src/main.ts', 'y')

    const r = await attachFiles(ws, ['proj'], 'hi')

    expect(r.text).toContain('proj/src/main.ts')
    expect(r.text).not.toContain('node_modules')
  })

  test('a file and a folder attach together', async () => {
    write('src/a.ts', 'export const a = 1')
    mkdirSync(join(root, 'docs'), { recursive: true })
    write('docs/readme.md', '# hi')

    const r = await attachFiles(ws, ['src/a.ts', 'docs'], 'both please')

    // The file arrives with its contents, numbered; the folder as paths.
    expect(r.text).toContain('export const a = 1')
    expect(r.text).toContain('docs/readme.md')
  })
})
