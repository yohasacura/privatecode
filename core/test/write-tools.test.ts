import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Workspace } from '../src/workspace.js'
import { editFileTool } from '../src/tools/edit-file.js'
import { writeFileTool } from '../src/tools/write-file.js'
import { tempBasename, writeFileAtomic } from '../src/tools/atomic-write.js'

let root: string
let ctx: { workspace: Workspace }

/** Files the tests mark read-only, restored in afterEach so the temp tree can be removed. */
let readOnly: string[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-write-'))
  writeFileSync(join(root, 'a.ts'), 'const x = 1\nconst y = 2\n')
  ctx = { workspace: new Workspace(root) }
  readOnly = []
})

afterEach(() => {
  for (const p of readOnly) {
    try {
      chmodSync(p, 0o666)
    } catch {
      // Already gone; nothing to restore.
    }
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 3 })
})

/** The `-`/`+` rows of a rendered diff, i.e. everything after the `@@` header. */
function diffBody(content: string): string[] {
  const lines = content.split('\n')
  const at = lines.findIndex((l) => l.startsWith('@@'))
  return at === -1 ? [] : lines.slice(at + 1)
}

test('edit_file applies a unique anchor and reports a diff', async () => {
  const r = await editFileTool.execute(
    { path: 'a.ts', search_text: 'const y = 2', replace_text: 'const y = 3' }, ctx)
  expect(r.ok).toBe(true)
  expect(readFileSync(join(root, 'a.ts'), 'utf8')).toContain('const y = 3')
  expect(r.content).toContain('-const y = 2')
  expect(r.content).toContain('+const y = 3')
})

test('edit_file returns an actionable message when the anchor is missing', async () => {
  const r = await editFileTool.execute(
    { path: 'a.ts', search_text: 'const z = 9', replace_text: 'x' }, ctx)
  expect(r.ok).toBe(false)
  expect(r.content).toMatch(/not found/i)
  // The file must be untouched after a failed edit.
  expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('const x = 1\nconst y = 2\n')
})

test('edit_file rejects an empty search_text before touching the disk', () => {
  const v = editFileTool.validate({ path: 'a.ts', search_text: '', replace_text: 'x' })
  expect(v.ok).toBe(false)
  if (v.ok) return
  expect(v.error).toMatch(/search_text/)
})

test('edit_file rejects a no-op edit', () => {
  const v = editFileTool.validate({ path: 'a.ts', search_text: 'same', replace_text: 'same' })
  expect(v.ok).toBe(false)
})

test('write_file creates a new file and reports the byte count', async () => {
  const r = await writeFileTool.execute({ path: 'sub/new.ts', content: 'export const n = 1\n' }, ctx)
  expect(r.ok).toBe(true)
  expect(readFileSync(join(root, 'sub', 'new.ts'), 'utf8')).toBe('export const n = 1\n')
  expect(r.content).toMatch(/19 bytes/)
})

test('write_file refuses to leave the workspace', async () => {
  const r = await writeFileTool.execute({ path: '../evil.ts', content: 'x' }, ctx)
  expect(r.ok).toBe(false)
  expect(r.content).toMatch(/escapes the workspace/)
})

// --- Line endings -----------------------------------------------------------------
//
// read_file splits on /\r?\n/, so an anchor the model copies out of a CRLF file always
// comes back LF-joined. These fixtures are CRLF because the target platform is Windows
// and the user's projects are C# and TypeScript: CRLF is the normal case, not the exotic
// one, and an LF-only fixture cannot see any of this.

const CRLF = 'const x = 1\r\nconst y = 2\r\nconst z = 3\r\n'

/** U+FEFF. Built from its code point because the character itself is invisible. */
const BOM = String.fromCharCode(0xfeff)

test('edit_file matches a multi-line anchor against a CRLF file', async () => {
  writeFileSync(join(root, 'crlf.ts'), CRLF)
  // Exactly what read_file would have shown the model, joined with LF.
  const r = await editFileTool.execute(
    { path: 'crlf.ts', search_text: 'const x = 1\nconst y = 2', replace_text: 'const x = 9' },
    ctx,
  )
  expect(r.ok).toBe(true)
  expect(readFileSync(join(root, 'crlf.ts'), 'utf8')).toBe('const x = 9\r\nconst z = 3\r\n')
})

test('edit_file leaves a CRLF file entirely CRLF after an exact single-line edit', async () => {
  writeFileSync(join(root, 'crlf.ts'), CRLF)
  const r = await editFileTool.execute(
    { path: 'crlf.ts', search_text: 'const y = 2', replace_text: 'const y = 3' }, ctx)
  expect(r.ok).toBe(true)
  const after = readFileSync(join(root, 'crlf.ts'), 'utf8')
  expect(after).toBe('const x = 1\r\nconst y = 3\r\nconst z = 3\r\n')
  // No lone LF anywhere: every newline is still preceded by a carriage return.
  expect(after.replace(/\r\n/g, '')).not.toContain('\n')
})

test('edit_file keeps CRLF when the anchor only matches after ignoring whitespace', async () => {
  // Double spaces defeat the exact path (the anchor is not a substring), so this is the
  // only test that actually reaches the whitespace-tolerant fallback in applySearchReplace
  // — the branch that rebuilds the file with join('\n').
  writeFileSync(join(root, 'ws.ts'), 'function f() {\r\n  const  y  =  2\r\n}\r\n')
  const r = await editFileTool.execute(
    { path: 'ws.ts', search_text: 'const y = 2', replace_text: 'const y = 3' }, ctx)
  expect(r.ok).toBe(true)
  expect(r.content).toMatch(/ignoring whitespace/)
  const after = readFileSync(join(root, 'ws.ts'), 'utf8')
  expect(after).toBe('function f() {\r\nconst y = 3\r\n}\r\n')
  expect(after.replace(/\r\n/g, '')).not.toContain('\n')
})

test('edit_file normalises a mixed-ending file to the dominant ending and says so', async () => {
  writeFileSync(join(root, 'mixed.ts'), 'a\r\nb\nc\r\nd\r\n')
  const r = await editFileTool.execute(
    { path: 'mixed.ts', search_text: 'b', replace_text: 'B' }, ctx)
  expect(r.ok).toBe(true)
  expect(r.content).toMatch(/mixed line endings/i)
  expect(r.content).toMatch(/CRLF/)
  expect(readFileSync(join(root, 'mixed.ts'), 'utf8')).toBe('a\r\nB\r\nc\r\nd\r\n')
})

test('edit_file leaves an LF file LF', async () => {
  const r = await editFileTool.execute(
    { path: 'a.ts', search_text: 'const y = 2', replace_text: 'const y = 3' }, ctx)
  expect(r.ok).toBe(true)
  expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('const x = 1\nconst y = 3\n')
  expect(r.content).not.toMatch(/mixed/i)
})

test('edit_file preserves a UTF-8 BOM through the whitespace fallback', async () => {
  // normalise().trim() treats U+FEFF as whitespace, so a line-1 anchor matches and the
  // rebuilt line used to be written back without the BOM. MSBuild cares about the BOM.
  writeFileSync(join(root, 'bom.cs'), `${BOM}int  y  =  2;\n`)
  const r = await editFileTool.execute(
    { path: 'bom.cs', search_text: 'int y = 2;', replace_text: 'int y = 3;' }, ctx)
  expect(r.ok).toBe(true)
  const bytes = readFileSync(join(root, 'bom.cs'))
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
  expect(bytes.toString('utf8')).toBe(`${BOM}int y = 3;\n`)
})

// --- Encoding ---------------------------------------------------------------------

test('edit_file refuses a binary file instead of rewriting it as U+FFFD', async () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]),
    Buffer.from('IHDR'),
    Buffer.from([0x00, 0x00, 0x01, 0x00]),
  ])
  writeFileSync(join(root, 'logo.png'), png)
  const r = await editFileTool.execute(
    { path: 'logo.png', search_text: 'IHDR', replace_text: 'IHDRXX' }, ctx)
  expect(r.ok).toBe(false)
  expect(r.content).toMatch(/binary|NUL/i)
  // Byte-for-byte untouched — read_file refuses this file, edit_file must not destroy it.
  expect(readFileSync(join(root, 'logo.png')).equals(png)).toBe(true)
})

test('edit_file refuses a file that is not valid UTF-8', async () => {
  // Latin-1 e-acute: no NUL and no BOM, so the binary sniff alone does not catch it.
  // Decoding maps it to U+FFFD and writing back would replace one byte with three.
  const latin1 = Buffer.concat([
    Buffer.from('const s = "'), Buffer.from([0xe9]), Buffer.from('";\n'),
  ])
  writeFileSync(join(root, 'latin1.ts'), latin1)
  const r = await editFileTool.execute(
    { path: 'latin1.ts', search_text: 'const s', replace_text: 'const t' }, ctx)
  expect(r.ok).toBe(false)
  expect(r.content).toMatch(/UTF-8/i)
  expect(readFileSync(join(root, 'latin1.ts')).equals(latin1)).toBe(true)
})

// --- Bounds -----------------------------------------------------------------------

test('edit_file refuses a file larger than the read_file ceiling', async () => {
  writeFileSync(join(root, 'huge.log'), Buffer.alloc(10 * 1024 * 1024 + 1, 0x61))
  const r = await editFileTool.execute(
    { path: 'huge.log', search_text: 'aaaa', replace_text: 'bbbb' }, ctx)
  expect(r.ok).toBe(false)
  expect(r.content).toMatch(/larger than/i)
  expect(r.content).toMatch(/10\.0 MB/)
})

test('edit_file bounds the diff it returns', async () => {
  // One minified line: the old renderDiff echoed it twice, so an 11-character edit cost
  // 1.6 million characters of permanent transcript.
  writeFileSync(join(root, 'min.js'), `const a="${'x'.repeat(300_000)}";const b = 1;`)
  const r = await editFileTool.execute(
    { path: 'min.js', search_text: 'const b = 1', replace_text: 'const b = 2' }, ctx)
  expect(r.ok).toBe(true)
  expect(r.content.length).toBeLessThan(5_000)
  expect(r.content).toMatch(/more characters on this line/)
  // The edit itself still landed in full.
  expect(readFileSync(join(root, 'min.js'), 'utf8')).toContain('const b = 2')
})

test('edit_file bounds a diff made of many lines', async () => {
  const body = Array.from({ length: 800 }, (_, i) => `line ${i}`).join('\n')
  writeFileSync(join(root, 'many.txt'), `head\n${body}\ntail\n`)
  const r = await editFileTool.execute(
    { path: 'many.txt', search_text: body, replace_text: 'collapsed' }, ctx)
  expect(r.ok).toBe(true)
  expect(r.content.length).toBeLessThan(5_000)
  expect(r.content).toMatch(/more diff lines/)
})

// --- renderDiff -------------------------------------------------------------------

test('edit_file renders a pure deletion without phantom rows', async () => {
  writeFileSync(join(root, 'd.ts'), 'const x = 1\nconst y = 2\nconst z = 3\n')
  const r = await editFileTool.execute(
    { path: 'd.ts', search_text: 'const z = 3\n', replace_text: '' }, ctx)
  expect(r.ok).toBe(true)
  // Exactly one row. A bare `-` or `+` row is an artifact of the terminal-newline element.
  expect(diffBody(r.content)).toEqual(['-const z = 3'])
})

test('edit_file renders a middle deletion as a single removed row', async () => {
  writeFileSync(join(root, 'd.ts'), 'const x = 1\nconst y = 2\nconst z = 3\n')
  const r = await editFileTool.execute(
    { path: 'd.ts', search_text: 'const y = 2\n', replace_text: '' }, ctx)
  expect(r.ok).toBe(true)
  expect(diffBody(r.content)).toEqual(['-const y = 2'])
})

test('edit_file renders an insertion as a single added row', async () => {
  const r = await editFileTool.execute(
    { path: 'a.ts', search_text: 'const y = 2\n', replace_text: 'const y = 2\nconst z = 3\n' },
    ctx,
  )
  expect(r.ok).toBe(true)
  expect(diffBody(r.content)).toEqual(['+const z = 3'])
})

test('edit_file names a change to the final newline rather than showing a bare row', async () => {
  // The terminal empty element a final newline produces is not a line. Diffed as one it
  // renders as a bare `-` that corresponds to nothing the model can point at in the file.
  writeFileSync(join(root, 'nl.ts'), 'const x = 1\nconst y = 2\n')
  const r = await editFileTool.execute(
    { path: 'nl.ts', search_text: 'const y = 2\n', replace_text: 'const y = 2' }, ctx)
  expect(r.ok).toBe(true)
  expect(readFileSync(join(root, 'nl.ts'), 'utf8')).toBe('const x = 1\nconst y = 2')
  expect(r.content).toMatch(/final newline/)
  expect(diffBody(r.content)).toEqual([])
})

test('edit_file says so when the edit produced no change at all', async () => {
  // Reaches the fallback, which rebuilds the line to exactly what it already was.
  writeFileSync(join(root, 'n.ts'), 'foo(  a,  b )\n')
  const before = statSync(join(root, 'n.ts'))
  const r = await editFileTool.execute(
    { path: 'n.ts', search_text: 'foo( a, b )', replace_text: 'foo(  a,  b )' }, ctx)
  expect(r.content).toMatch(/no change|unchanged|identical/i)
  // And it must not look like a normal diff with an empty body.
  expect(diffBody(r.content)).toEqual([])
  expect(readFileSync(join(root, 'n.ts'), 'utf8')).toBe('foo(  a,  b )\n')
  // Nothing changed, so nothing was written: an identical rewrite still moves the mtime
  // and makes every watcher downstream rebuild.
  expect(statSync(join(root, 'n.ts')).ino).toBe(before.ino)
})

// --- write_file preserves the shape of the file it replaces ------------------------
//
// read_file shows the model an LF-only view of every file and strips the BOM, so the
// model cannot supply either even in principle — the same reason edit_file restores them
// rather than trusting its input. write_file rewrites every line of the file, so getting
// this wrong turns each agent change into a whole-file diff and disables the user's git,
// which the design names as the only safety net. The user's stack is C#/TS on Windows and
// MSBuild treats the BOM as meaningful.

const CS_CRLF_BOM = `${BOM}using System;\r\nnamespace A\r\n{\r\n    class B { }\r\n}\r\n`

test('write_file preserves an existing file\'s CRLF endings and its BOM', async () => {
  writeFileSync(join(root, 'A.cs'), CS_CRLF_BOM)
  const r = await writeFileTool.execute(
    { path: 'A.cs', content: 'using System;\nnamespace A\n{\n    class C { }\n}\n' }, ctx)
  expect(r.ok).toBe(true)
  const bytes = readFileSync(join(root, 'A.cs'))
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
  expect(bytes.toString('utf8')).toBe(
    `${BOM}using System;\r\nnamespace A\r\n{\r\n    class C { }\r\n}\r\n`)
  // No lone LF anywhere: every newline is still preceded by a carriage return.
  expect(bytes.toString('utf8').replace(/\r\n/g, '')).not.toContain('\n')
})

test('write_file says in the result when it matched the existing file\'s endings', async () => {
  writeFileSync(join(root, 'A.cs'), CS_CRLF_BOM)
  const r = await writeFileTool.execute(
    { path: 'A.cs', content: 'using System;\nnamespace A\n{\n}\n' }, ctx)
  expect(r.ok).toBe(true)
  expect(r.content).toMatch(/CRLF/)
  expect(r.content).toMatch(/byte-order mark/i)
  // The byte count reported is the count actually written, not the count handed in.
  expect(r.content).toMatch(/-> 37 bytes/)
  expect(statSync(join(root, 'A.cs')).size).toBe(37)
})

test('write_file leaves an LF file LF and says nothing about endings', async () => {
  writeFileSync(join(root, 'lf.ts'), 'const x = 1\nconst y = 2\n')
  const r = await writeFileTool.execute({ path: 'lf.ts', content: 'const x = 9\n' }, ctx)
  expect(r.ok).toBe(true)
  expect(readFileSync(join(root, 'lf.ts'), 'utf8')).toBe('const x = 9\n')
  expect(r.content).not.toMatch(/CRLF|byte-order mark/i)
})

test('write_file converts CRLF content to LF when the existing file is LF', async () => {
  writeFileSync(join(root, 'lf.ts'), 'const x = 1\nconst y = 2\n')
  const r = await writeFileTool.execute({ path: 'lf.ts', content: 'const x = 9\r\n' }, ctx)
  expect(r.ok).toBe(true)
  expect(readFileSync(join(root, 'lf.ts'), 'utf8')).toBe('const x = 9\n')
  expect(r.content).toMatch(/LF/)
})

test('write_file writes a genuinely new file exactly as given', async () => {
  // Nothing to preserve: a new file's endings are the model's to choose, and silently
  // rewriting them would be inventing a shape the workspace never asked for.
  const r = await writeFileTool.execute(
    { path: 'fresh.cs', content: 'line one\r\nline two\r\n' }, ctx)
  expect(r.ok).toBe(true)
  expect(readFileSync(join(root, 'fresh.cs'), 'utf8')).toBe('line one\r\nline two\r\n')
  expect(r.content).not.toMatch(/CRLF|byte-order mark/i)
})

test('write_file preserves the dominant ending of a mixed-ending file', async () => {
  writeFileSync(join(root, 'mixed.ts'), 'a\r\nb\nc\r\nd\r\n')
  const r = await writeFileTool.execute({ path: 'mixed.ts', content: 'x\ny\n' }, ctx)
  expect(r.ok).toBe(true)
  expect(readFileSync(join(root, 'mixed.ts'), 'utf8')).toBe('x\r\ny\r\n')
})

test('write_file does not invent endings for a file that has none', async () => {
  writeFileSync(join(root, 'oneline.txt'), 'no newline here')
  const r = await writeFileTool.execute(
    { path: 'oneline.txt', content: 'first\r\nsecond\r\n' }, ctx)
  expect(r.ok).toBe(true)
  expect(readFileSync(join(root, 'oneline.txt'), 'utf8')).toBe('first\r\nsecond\r\n')
})

test('write_file does not read line endings out of a binary file it replaces', async () => {
  // A file with NUL bytes has no line structure to preserve; guessing at one would be
  // inventing it. The replacement is text and is written exactly as given.
  writeFileSync(join(root, 'blob.bin'), Buffer.from([0x00, 0x0d, 0x0a, 0x00, 0x0d, 0x0a]))
  const r = await writeFileTool.execute({ path: 'blob.bin', content: 'a\nb\n' }, ctx)
  expect(r.ok).toBe(true)
  expect(readFileSync(join(root, 'blob.bin'), 'utf8')).toBe('a\nb\n')
})

// --- write_file overwrite reporting -----------------------------------------------

test('write_file reports that it replaced an existing file, with both sizes in order', async () => {
  writeFileSync(join(root, 'important.ts'), 'x'.repeat(48_890))
  const r = await writeFileTool.execute({ path: 'important.ts', content: 'oops\n' }, ctx)
  expect(r.ok).toBe(true)
  // Order-blind `toContain` checks let the two sizes swap places, and `toContain('5')` is
  // satisfied by the '5' inside '48890'. The receipt is the only surviving record that an
  // overwrite happened at all, so which number is which is the whole point of it.
  expect(r.content).toBe('Replaced important.ts (48890 bytes -> 5 bytes).')
})

test('write_file still reports a plain create for a new file', async () => {
  const r = await writeFileTool.execute({ path: 'brand-new.ts', content: 'const n = 1\n' }, ctx)
  expect(r.ok).toBe(true)
  expect(r.content).toMatch(/^Wrote /)
  expect(r.content).not.toMatch(/Replaced/)
})

test('write_file refuses a path that is an existing directory', async () => {
  const r = await writeFileTool.execute({ path: 'sub/new.ts', content: 'a' }, ctx)
  expect(r.ok).toBe(true)
  const r2 = await writeFileTool.execute({ path: 'sub', content: 'a' }, ctx)
  expect(r2.ok).toBe(false)
  expect(r2.content).toMatch(/director/i)
})

// --- Atomicity and error framing --------------------------------------------------

test('write_file replaces the directory entry instead of truncating in place', async () => {
  // The distinguishing observable: fs.writeFile opens the existing file and truncates it,
  // so the file index survives; a temp-file-plus-rename installs a different file under
  // the same name. Between the truncating open and the last byte the target is neither the
  // old content nor the new one, and there is no undo — so this pins the rename.
  writeFileSync(join(root, 'k.ts'), 'const k = 1\n')
  const before = statSync(join(root, 'k.ts'))
  const r = await writeFileTool.execute({ path: 'k.ts', content: 'const k = 2\n' }, ctx)
  expect(r.ok).toBe(true)
  expect(statSync(join(root, 'k.ts')).ino).not.toBe(before.ino)
  expect(readFileSync(join(root, 'k.ts'), 'utf8')).toBe('const k = 2\n')
})

test('edit_file replaces the directory entry instead of truncating in place', async () => {
  const before = statSync(join(root, 'a.ts'))
  const r = await editFileTool.execute(
    { path: 'a.ts', search_text: 'const y = 2', replace_text: 'const y = 3' }, ctx)
  expect(r.ok).toBe(true)
  expect(statSync(join(root, 'a.ts')).ino).not.toBe(before.ino)
})

test('write_file leaves no temporary files behind', async () => {
  await writeFileTool.execute({ path: 'a.ts', content: 'const x = 2\n' }, ctx)
  await editFileTool.execute(
    { path: 'a.ts', search_text: 'const x = 2', replace_text: 'const x = 3' }, ctx)
  expect(readdirSync(root)).toEqual(['a.ts'])
})

test('write_file surfaces a genuine flush error instead of swallowing it', async () => {
  // `handle.sync().catch(() => {})` used to discard every error, not only the EINVAL its
  // comment named, so a real EIO at flush was silently ignored and the rename went ahead
  // anyway — committing a file that was never actually flushed. Patching
  // FileHandle.prototype.sync (shared by every handle) to simulate that EIO is the only way
  // to observe this: node:fs/promises itself cannot be spied on (its exports are
  // non-configurable), but the class prototype writeFileAtomic's handle is an instance of
  // can be, for the duration of this one test.
  const probe = await open(join(root, '.sync-probe'), 'w')
  const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> }
  await probe.close()
  rmSync(join(root, '.sync-probe'))

  const spy = vi.spyOn(proto, 'sync').mockImplementation(async () => {
    const err = new Error('simulated flush failure') as NodeJS.ErrnoException
    err.code = 'EIO'
    throw err
  })
  try {
    const r = await writeFileTool.execute({ path: 'flush.ts', content: 'x'.repeat(10) }, ctx)
    expect(r.ok).toBe(false)
    expect(r.content).toMatch(/could not write/i)
  } finally {
    spy.mockRestore()
  }
  // The target was never created, and the failed attempt cleaned up its own temp file.
  expect(readdirSync(root)).toEqual(['a.ts'])
})

test('write_file survives two concurrent writes to the same path', async () => {
  // Pins that the temp file's name is unique per call. A name derived from the target
  // alone collides, and the loser of the race fails a write it should have completed.
  const [r1, r2] = await Promise.all([
    writeFileTool.execute({ path: 'c.ts', content: 'const c = 1\n' }, ctx),
    writeFileTool.execute({ path: 'c.ts', content: 'const c = 2\n' }, ctx),
  ])
  expect(r1.ok).toBe(true)
  expect(r2.ok).toBe(true)
  expect(['const c = 1\n', 'const c = 2\n']).toContain(readFileSync(join(root, 'c.ts'), 'utf8'))
  expect(readdirSync(root)).toEqual(['a.ts', 'c.ts'])
})

test('edit_file reports a read-only target without leaking an absolute path', async () => {
  const target = join(root, 'ro.ts')
  writeFileSync(target, 'const x = 1\nconst y = 2\n')
  chmodSync(target, 0o444)
  readOnly.push(target)
  const r = await editFileTool.execute(
    { path: 'ro.ts', search_text: 'const y = 2', replace_text: 'const y = 3' }, ctx)
  expect(r.ok).toBe(false)
  expect(r.content).toContain('ro.ts')
  expect(r.content).not.toContain(root)
  // The original survives, and the failed attempt cleans up after itself.
  expect(readFileSync(target, 'utf8')).toBe('const x = 1\nconst y = 2\n')
  expect(readdirSync(root)).toEqual(['a.ts', 'ro.ts'])
})

test('write_file reports a read-only target without leaking an absolute path', async () => {
  const target = join(root, 'ro.ts')
  writeFileSync(target, 'original\n')
  chmodSync(target, 0o444)
  readOnly.push(target)
  const r = await writeFileTool.execute({ path: 'ro.ts', content: 'replacement\n' }, ctx)
  expect(r.ok).toBe(false)
  expect(r.content).toContain('ro.ts')
  expect(r.content).not.toContain(root)
  expect(readFileSync(target, 'utf8')).toBe('original\n')
  expect(readdirSync(root)).toEqual(['a.ts', 'ro.ts'])
})

// --- Workspace-root containment ---------------------------------------------------
//
// `Workspace.resolve('.')` addresses the root itself, whether or not the root exists on
// disk. If the root does not exist yet, `stat` throws ENOENT; that guard used to fall
// through with `replaced` still null, and `mkdir(dirname(abs), { recursive: true })` then
// created directories at the root's own *parent* — outside the workspace — while the
// atomic temp file was opened there too, before being renamed onto the root path itself
// and turning it into a plain file. `holder` is a second, disposable directory one level
// above the workspace root, so any write outside the workspace is directly observable.

test('write_file refuses to touch the workspace root when it does not exist yet', async () => {
  const holder = mkdtempSync(join(tmpdir(), 'pc-root-'))
  try {
    const missingRoot = join(holder, 'not-created-yet')
    const rootCtx = { workspace: new Workspace(missingRoot) }
    const r = await writeFileTool.execute({ path: '.', content: 'PWNED\n' }, rootCtx)
    expect(r.ok).toBe(false)
    expect(r.content).toMatch(/workspace root/i)
    // Nothing was created at the root path, and nothing leaked into its parent either.
    expect(existsSync(missingRoot)).toBe(false)
    expect(readdirSync(holder)).toEqual([])
  } finally {
    rmSync(holder, { recursive: true, force: true })
  }
})

test('edit_file refuses to touch the workspace root when it does not exist yet', async () => {
  const holder = mkdtempSync(join(tmpdir(), 'pc-root-'))
  try {
    const missingRoot = join(holder, 'not-created-yet')
    const rootCtx = { workspace: new Workspace(missingRoot) }
    const r = await editFileTool.execute(
      { path: '.', search_text: 'a', replace_text: 'b' }, rootCtx)
    expect(r.ok).toBe(false)
    expect(r.content).toMatch(/workspace root/i)
    expect(existsSync(missingRoot)).toBe(false)
    expect(readdirSync(holder)).toEqual([])
  } finally {
    rmSync(holder, { recursive: true, force: true })
  }
})

test('write_file refuses to touch the workspace root when it already exists', async () => {
  // With the root already a real directory, the old code path happened to catch this via
  // its isDirectory() check and report "is an existing directory" — safe by accident, not
  // by containment. This pins the same explicit, principled refusal in both cases.
  const r = await writeFileTool.execute({ path: '.', content: 'x' }, ctx)
  expect(r.ok).toBe(false)
  expect(r.content).toMatch(/workspace root/i)
})

test('edit_file refuses to touch the workspace root when it already exists', async () => {
  const r = await editFileTool.execute(
    { path: '.', search_text: 'a', replace_text: 'b' }, ctx)
  expect(r.ok).toBe(false)
  expect(r.content).toMatch(/workspace root/i)
})

// `abs === ctx.workspace.root` is a string comparison, and Windows strips trailing dots
// and spaces before it opens a path — `<root>\. ` is the root itself. `workspace.ts`
// already knows this (TRAILING_DOTS_AND_SPACES); the two write tools did not, so `. `
// resolved to a string that is not the root, passed the guard, and created a root-level
// entry literally named `. ` — measured, both tools.
for (const path of ['. ', '.  ', '..', '. .']) {
  test(`write_file refuses "${path}", which Windows opens as the workspace root`, async () => {
    const r = await writeFileTool.execute({ path, content: 'PWNED\n' }, ctx)
    expect(r.ok).toBe(false)
    expect(r.content).toMatch(/workspace root|escapes the workspace/i)
    expect(readdirSync(root)).toEqual(['a.ts'])
  })
}

test('edit_file refuses ". ", which Windows opens as the workspace root', async () => {
  const r = await editFileTool.execute(
    { path: '. ', search_text: 'a', replace_text: 'b' }, ctx)
  expect(r.ok).toBe(false)
  expect(r.content).toMatch(/workspace root|escapes the workspace/i)
  expect(readdirSync(root)).toEqual(['a.ts'])
})

// --- Temp-file naming cannot collide with the workspace denylist ------------------

test('the atomic-write temp name never collides with a workspace-denylisted pattern', () => {
  // Every stem `Workspace`'s own denylist refuses, used as the *target's* basename — the
  // worst case, since a target legitimately named exactly one of these is the scenario the
  // defect was found in. `.env` is the one whose pattern is suffix-unanchored
  // (`/^\.env(\..+)?$/i` swallows anything shaped `.env.<more>`), which is what let the
  // previous `.${basename}.${hex}.tmp` scheme collide; the rest require an exact or a
  // suffix match that a trailing `~<hex>.tmp` cannot produce.
  const deniedStems = [
    'env', 'id_rsa', 'id_ed25519', 'notes.pem', 'cert.pfx', 'cert.p12', '.npmrc', 'credentials',
  ]
  for (const stem of deniedStems) {
    const name = tempBasename(stem)
    // If the generated name matches a denylisted pattern, Workspace.resolve refuses it —
    // exactly the fate an orphaned temp file left by a mid-write crash would suffer, making
    // it permanently invisible to every other tool routed through the same workspace.
    expect(() => ctx.workspace.resolve(name)).not.toThrow()
  }
})

test('the temp name never starts with two literal dots for a dotfile target', () => {
  // Workspace.resolve treats any relative path *starting with* the characters `..` as
  // escaping the workspace (`rel.startsWith('..')`), regardless of whether it is an actual
  // parent-directory segment. A naive `.${targetBasename}~<hex>.tmp` scheme produces exactly
  // that for a target whose own basename already starts with a dot (`.npmrc`, `.gitignore`),
  // which would make the orphan unreachable via a *different* code path than the denylist —
  // this pins that the chosen scheme cannot start with `..` for any target name.
  for (const stem of ['.npmrc', '.gitignore', '.env', '..already-double']) {
    const name = tempBasename(stem)
    expect(name.startsWith('..')).toBe(false)
    expect(() => ctx.workspace.resolve(name)).not.toThrow()
  }
})

test('writeFileAtomic refuses to write outside its own workspace, independent of the caller', async () => {
  // Defense in depth for the atomic-write layer itself: every caller today already resolves
  // `abs` through Workspace before reaching here, but that is a fact about the callers, not
  // something this function can see. Called directly with a path that was never checked —
  // exactly what a future caller that gets it wrong would do — it must still refuse rather
  // than silently opening a temp file, and writing, outside the workspace it was handed.
  const outside = join(dirname(root), 'escaped.txt')
  await expect(writeFileAtomic(outside, 'x', ctx.workspace)).rejects.toThrow(/escapes the workspace/)
  expect(existsSync(outside)).toBe(false)
})

test('writeFileAtomic enforces the secrets denylist on the target, not only on its directory', async () => {
  // The re-resolution above only ever covered `dirname(abs)`, so containment held while the
  // denylist did not: `writeFileAtomic(join(root, '.env'), ...)` wrote the file. Not
  // reachable from today's two callers, both of which resolve the full path first — but
  // that is a fact about the callers, which is exactly what this layer must not assume.
  for (const name of ['.env', 'id_rsa', 'secret.pem', '.npmrc', 'credentials']) {
    const target = join(root, name)
    await expect(writeFileAtomic(target, 'SECRET=1', ctx.workspace))
      .rejects.toThrow(/denied/i)
    expect(existsSync(target)).toBe(false)
  }
  // And no orphaned temp file was left behind by any of the refusals.
  expect(readdirSync(root)).toEqual(['a.ts'])
})

test('write_file succeeds against a target literally named env', async () => {
  // End-to-end version of the same scenario: a real write to a file named `env` must not
  // be able to synthesise a temp path the workspace itself would refuse to ever see again.
  const r = await writeFileTool.execute({ path: 'env', content: 'not a secret\n' }, ctx)
  expect(r.ok).toBe(true)
  expect(readFileSync(join(root, 'env'), 'utf8')).toBe('not a secret\n')
  // No orphaned temp file left behind either.
  expect(readdirSync(root).sort()).toEqual(['a.ts', 'env'])
})

// --- write_file size ceiling -------------------------------------------------------

test('write_file refuses to create a file larger than the read_file/edit_file ceiling', async () => {
  const giant = 'a'.repeat(10 * 1024 * 1024 + 1)
  const r = await writeFileTool.execute({ path: 'giant.txt', content: giant }, ctx)
  expect(r.ok).toBe(false)
  expect(r.content).toMatch(/larger than/i)
  expect(r.content).toMatch(/10\.0 MB/)
  // Refused before anything touched the disk.
  expect(existsSync(join(root, 'giant.txt'))).toBe(false)
})
