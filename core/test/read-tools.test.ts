import { afterAll, beforeAll, expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../src/workspace.js'
import { readFileTool } from '../src/tools/read-file.js'
import { listDirTool } from '../src/tools/list-dir.js'
import { findFilesTool } from '../src/tools/find-files.js'
import { editFileTool } from '../src/tools/edit-file.js'
import { ReadMemory } from '../src/tools/read-memory.js'

let ctx: { workspace: Workspace }
/** Parent of the workspace root, so a sibling directory exists to try to escape into. */
let tempParent: string
let tempRoot: string

const lines = (n: number) => Array.from({ length: n }, (_, i) => `L${i + 1}`).join('\n') + '\n'
const pad = (n: number) => String(n).padStart(3, '0')

beforeAll(() => {
  tempParent = mkdtempSync(join(tmpdir(), 'pc-read-'))
  tempRoot = join(tempParent, 'ws')
  mkdirSync(tempRoot)

  // A secret planted outside the workspace, to prove enumeration cannot reach it.
  mkdirSync(join(tempParent, 'outside'))
  writeFileSync(join(tempParent, 'outside', 'escape.txt'), 'SECRET-OUTSIDE\n')

  mkdirSync(join(tempRoot, 'src'))
  writeFileSync(join(tempRoot, 'src', 'a.ts'), 'one\ntwo\nthree\nfour\nfive\n')
  writeFileSync(join(tempRoot, 'src', 'b.ts'), 'export const b = 1\n')
  writeFileSync(join(tempRoot, 'README.md'), '# hi\n')

  writeFileSync(join(tempRoot, 'empty.txt'), '')
  writeFileSync(join(tempRoot, 'crlf.ts'), 'function a() {\r\n  return 1\r\n\r\n}\r\n')

  // CI config the agent is routinely asked about, plus the entries that must stay hidden.
  writeFileSync(join(tempRoot, '.gitignore'), 'node_modules\n')
  writeFileSync(join(tempRoot, '.gitattributes'), '* text=auto\n')
  mkdirSync(join(tempRoot, '.github', 'workflows'), { recursive: true })
  writeFileSync(join(tempRoot, '.github', 'workflows', 'ci.yml'), 'name: ci\n')
  mkdirSync(join(tempRoot, '.git', 'objects', 'ab'), { recursive: true })
  writeFileSync(join(tempRoot, '.git', 'objects', 'ab', 'cdef'), 'binaryish\n')
  mkdirSync(join(tempRoot, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(tempRoot, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
  writeFileSync(join(tempRoot, '.env'), 'API_KEY=secret\n')

  mkdirSync(join(tempRoot, 'big'))
  // The demonstrated minified bundle: one line, 3,000,026 characters.
  writeFileSync(join(tempRoot, 'big', 'one-line.js'), 'a'.repeat(3_000_026))
  writeFileSync(join(tempRoot, 'big', 'lines2501.txt'), lines(2501))
  writeFileSync(join(tempRoot, 'big', 'huge.bin'), Buffer.alloc(12 * 1024 * 1024, 0x61))

  mkdirSync(join(tempRoot, 'bin'))
  const blob = Buffer.alloc(4096)
  for (let i = 0; i < blob.length; i++) blob[i] = i % 256
  writeFileSync(join(tempRoot, 'bin', 'blob.bin'), blob)
  // What Windows PowerShell `>` redirection produces: UTF-16LE with a BOM.
  writeFileSync(join(tempRoot, 'bin', 'utf16.txt'), Buffer.from('\uFEFFhello\r\nworld\r\n', 'utf16le'))

  // 250 matches whose traversal order is not their sorted order: glob yields the 50
  // depth-1 files before the 200 depth-2 ones, so a cap applied before the sort keeps
  // a different subset than a cap applied after it.
  mkdirSync(join(tempRoot, 'many', 'aa'), { recursive: true })
  for (let i = 1; i <= 50; i++) writeFileSync(join(tempRoot, 'many', `zz${pad(i)}.txt`), 'x')
  for (let i = 1; i <= 200; i++) writeFileSync(join(tempRoot, 'many', 'aa', `f${pad(i)}.txt`), 'x')

  mkdirSync(join(tempRoot, 'exactly'))
  for (let i = 1; i <= 200; i++) writeFileSync(join(tempRoot, 'exactly', `e${pad(i)}.txt`), 'x')

  ctx = { workspace: new Workspace(tempRoot) }
}, 60_000)

afterAll(() => {
  rmSync(tempParent, { recursive: true, force: true })
})

test('read_file numbers lines', async () => {
  const r = await readFileTool.execute({ path: 'src/a.ts' }, ctx)
  expect(r.ok).toBe(true)
  expect(r.content).toContain('1\tone')
  expect(r.content).toContain('5\tfive')
})

test('read_file honours a line range', async () => {
  const r = await readFileTool.execute({ path: 'src/a.ts', start_line: 2, end_line: 3 }, ctx)
  expect(r.content).toContain('2\ttwo')
  expect(r.content).toContain('3\tthree')
  expect(r.content).not.toContain('1\tone')
  expect(r.content).not.toContain('4\tfour')
})

test('read_file reports a missing file as a tool failure, not an exception', async () => {
  const r = await readFileTool.execute({ path: 'src/nope.ts' }, ctx)
  expect(r.ok).toBe(false)
  // `/not found|ENOENT/i` was satisfied by the raw errno itself, so the OR always matched
  // while an absolute path leaked into the permanent transcript alongside it. The message
  // is short and fixed, so pin it exactly.
  expect(r.content).toBe('File not found: src/nope.ts')
  expect(r.content).not.toContain(tempRoot)
})

test('read_file refuses to leave the workspace', async () => {
  const r = await readFileTool.execute({ path: '../escape.txt' }, ctx)
  expect(r.ok).toBe(false)
  expect(r.content).toMatch(/escapes the workspace/)
})

test('read_file rejects an empty path at validation time', () => {
  const v = readFileTool.validate({ path: '  ' })
  expect(v.ok).toBe(false)
})

test('list_dir lists entries and marks directories', async () => {
  const r = await listDirTool.execute({ path: '.' }, ctx)
  expect(r.content).toContain('src/')
  expect(r.content).toContain('README.md')
})

// --- Failure paths must not spend permanent transcript on an absolute path ----------
//
// Everything a tool returns is append-only transcript. `fsErrorReason` exists for exactly
// this and the two write tools' tests already assert `not.toContain(root)`; the read path
// was held to no such bar and leaked the workspace's absolute path plus a raw errno.
// Measured before the fix:
//   read_file -> "File not found: nope.txt"
//   list_dir  -> "Could not list nope: ENOENT: no such file or directory, scandir 'C:\...'"

test('list_dir reports a missing directory without leaking the absolute path', async () => {
  const r = await listDirTool.execute({ path: 'nope' }, ctx)
  expect(r.ok).toBe(false)
  expect(r.content).toContain('nope')
  expect(r.content).not.toContain(tempRoot)
  expect(r.content).not.toContain('scandir')
})

test('list_dir reports an unreadable directory without leaking the absolute path', async () => {
  const locked = join(tempRoot, 'locked-dir')
  mkdirSync(locked)
  const user = process.env.USERNAME ?? process.env.USER ?? ''
  execFileSync('icacls', [locked, '/deny', `${user}:(OI)(CI)(RX)`], { stdio: 'ignore' })
  try {
    const r = await listDirTool.execute({ path: 'locked-dir' }, ctx)
    expect(r.ok).toBe(false)
    // If the deny ACE silently failed to apply this would be a successful listing, so
    // asserting the failure is also what keeps this test honest.
    expect(r.content).toContain('locked-dir')
    expect(r.content).toMatch(/EPERM|EACCES|permitted|denied/i)
    expect(r.content).not.toContain(tempRoot)
    expect(r.content).not.toContain('scandir')
  } finally {
    execFileSync('icacls', [locked, '/remove:d', user], { stdio: 'ignore' })
    rmSync(locked, { recursive: true, force: true })
  }
})

test('read_file reports an unreadable file without leaking the absolute path', async () => {
  const locked = join(tempRoot, 'locked.txt')
  writeFileSync(locked, 'secret\n')
  const user = process.env.USERNAME ?? process.env.USER ?? ''
  execFileSync('icacls', [locked, '/deny', `${user}:(R)`], { stdio: 'ignore' })
  try {
    const r = await readFileTool.execute({ path: 'locked.txt' }, ctx)
    expect(r.ok).toBe(false)
    expect(r.content).toContain('locked.txt')
    expect(r.content).toMatch(/EPERM|EACCES|permitted|denied/i)
    expect(r.content).not.toContain(tempRoot)
    // The raw errno appends `, open '<abs>'`; the whole tail goes, not just the path.
    expect(r.content).not.toMatch(/, open /)
  } finally {
    execFileSync('icacls', [locked, '/remove:d', user], { stdio: 'ignore' })
    rmSync(locked, { force: true })
  }
})

test('find_files matches a glob', async () => {
  const r = await findFilesTool.execute({ glob: 'src/*.ts' }, ctx)
  expect(r.content).toContain('src/a.ts')
  expect(r.content).toContain('src/b.ts')
  expect(r.content).not.toContain('README.md')
})

// --- Critical 1: read_file has no byte budget, only a line count -------------------

test('C1 read_file bounds a one-line minified bundle by characters', async () => {
  const r = await readFileTool.execute({ path: 'big/one-line.js' }, ctx)
  expect(r.ok).toBe(true)
  // Pre-fix this returned all 3,000,026 characters with no notice. The bound is what this
  // test has always been for; the WORDING changed when large whole-file reads started
  // answering with the file's shape instead of its text, and this file — one line of three
  // megabytes — is the case that proves a line count is not a bound.
  expect(r.content.length).toBeLessThan(70_000)
  expect(r.content).toMatch(/too large to put in context whole/)
  // And it still says how big the thing it refused to inline actually is.
  expect(r.content).toMatch(/3000k characters/)
})

test('C1 an explicit range is still honoured, and still capped', async () => {
  // The other half of the same rule: the shape-instead-of-text path must catch only "give
  // me all of it". A stated range is the model saying what it wants, and it gets it — up to
  // the caps that have always applied.
  const r = await readFileTool.execute({ path: 'big/one-line.js', start_line: 1, end_line: 1 }, ctx)
  expect(r.ok).toBe(true)
  expect(r.content).toMatch(/stopped at the 60000-character cap/)
  expect(r.content).toMatch(/cannot resume inside a line/)
})

test('C1 read_file refuses a file above the hard byte ceiling', async () => {
  const r = await readFileTool.execute({ path: 'big/huge.bin' }, ctx)
  expect(r.ok).toBe(false)
  expect(r.content).toContain('big/huge.bin')
  expect(r.content).toMatch(/12\.0 MB/)
  expect(r.content).toMatch(/refuses files larger than 10\.0 MB/)
})

// --- Critical 2: end_line disables the line cap ------------------------------------

test('C2 end_line cannot raise the line cap', async () => {
  const r = await readFileTool.execute({ path: 'big/lines2501.txt', end_line: 999999 }, ctx)
  expect(r.ok).toBe(true)
  expect(r.content).toContain('2000\tL2000')
  expect(r.content).not.toContain('2001\tL2001')
  expect(r.content).toMatch(/501 more lines \(stopped at the 2000-line cap\)/)
  expect(r.content).toMatch(/start_line=2001/)
})

// --- Critical 3: a trailing newline produces a phantom line and a wrong count -------

test('C3 a trailing newline does not add a phantom line', async () => {
  const r = await readFileTool.execute({ path: 'src/a.ts' }, ctx)
  expect(r.content).toContain('(5 lines)')
  expect(r.content).not.toContain('(6 lines)')
  expect(r.content).not.toContain('6\t')
})

test('C3 an empty file reports zero lines and emits no rows', async () => {
  const r = await readFileTool.execute({ path: 'empty.txt' }, ctx)
  expect(r.ok).toBe(true)
  expect(r.content).toContain('(0 lines)')
  expect(r.content).not.toContain('1\t')
})

test('C3 the truncation notice counts real lines', async () => {
  const r = await readFileTool.execute({ path: 'big/lines2501.txt' }, ctx)
  // 2501 real lines, 2000 shown, 501 left - not 502.
  expect(r.content).toContain('(2501 lines)')
  expect(r.content).toMatch(/501 more lines/)
  expect(r.content).not.toMatch(/502 more lines/)
})

// --- Critical 4: an out-of-range or inverted range is a successful empty read -------

test('C4 a start past the end of the file fails and names the line count', async () => {
  const r = await readFileTool.execute({ path: 'src/a.ts', start_line: 10 }, ctx)
  expect(r.ok).toBe(false)
  expect(r.content).toMatch(/has 5 lines/)
  expect(r.content).toMatch(/start_line 10/)
})

test('C4 an inverted range is rejected at validation time and at execution', async () => {
  const v = readFileTool.validate({ path: 'src/a.ts', start_line: 4, end_line: 2 })
  expect(v.ok).toBe(false)
  const r = await readFileTool.execute({ path: 'src/a.ts', start_line: 4, end_line: 2 }, ctx)
  expect(r.ok).toBe(false)
})

// --- Critical 5: find_files never jails the pattern --------------------------------

test('C5 find_files refuses a pattern with a .. segment', async () => {
  for (const pattern of ['../outside/*', '../**/*.txt']) {
    expect(findFilesTool.validate({ glob: pattern }).ok).toBe(false)
    const r = await findFilesTool.execute({ glob: pattern }, ctx)
    expect(r.ok).toBe(false)
    expect(r.content).not.toContain('escape.txt')
  }
})

test('C5 find_files refuses an absolute pattern', async () => {
  const pattern = join(tempRoot, '..', 'outside', '*')
  expect(findFilesTool.validate({ glob: pattern }).ok).toBe(false)
  const r = await findFilesTool.execute({ glob: pattern }, ctx)
  expect(r.ok).toBe(false)
  expect(r.content).not.toContain('escape.txt')
})

test('C5 find_files applies the secrets denylist to enumeration', async () => {
  const r = await findFilesTool.execute({ glob: '**/.env' }, ctx)
  expect(r.content.split('\n')).not.toContain('.env')
})

// --- Important 6: binary and UTF-16 files are decoded as UTF-8 and returned as ok ---

test('I6 a binary file is refused, not decoded', async () => {
  const r = await readFileTool.execute({ path: 'bin/blob.bin' }, ctx)
  expect(r.ok).toBe(false)
  expect(r.content).toContain('bin/blob.bin')
  expect(r.content).toMatch(/4\.0 KB/)
  expect(r.content).toMatch(/NUL/)
  expect(r.content).not.toContain('\uFFFD')
  expect(r.content).not.toContain('\u0000')
})

test('I6 a UTF-16LE file is refused', async () => {
  const r = await readFileTool.execute({ path: 'bin/utf16.txt' }, ctx)
  expect(r.ok).toBe(false)
  expect(r.content).toMatch(/UTF-16/)
  expect(r.content).toContain('bin/utf16.txt')
  expect(r.content).not.toContain('\u0000')
})

// --- Important 7: split('\n') leaves a carriage return on every line ---------------

test('I7 CRLF endings never reach the numbered output', async () => {
  const r = await readFileTool.execute({ path: 'crlf.ts' }, ctx)
  expect(r.ok).toBe(true)
  expect(r.content).not.toContain('\r')
  expect(r.content).toContain('1\tfunction a() {')
  expect(r.content).toContain('(4 lines)')
  // The blank line 3 must read as blank, not as a one-character line.
  expect(r.content).toContain('3\t\n')
})

// --- The UTF-8 BOM must not reach the model as content ----------------------------
//
// `buffer.toString('utf8')` keeps U+FEFF, so line 1 arrived at the model with an
// invisible character glued to its front. Two bugs were cancelling: the model copies that
// line back as an anchor, edit_file holds the file's own BOM aside so the anchor cannot
// match exactly, and the whitespace-tolerant fallback then matches it anyway — reporting
// "the anchor matched only after ignoring whitespace" for an anchor that was verbatim.

test('read_file does not put the BOM in front of line 1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-bom-'))
  try {
    const c = { workspace: new Workspace(dir) }
    writeFileSync(join(dir, 'bom.cs'), '﻿int y = 2;\nint z = 3;\n')
    const r = await readFileTool.execute({ path: 'bom.cs' }, c)
    expect(r.ok).toBe(true)
    expect(r.content).not.toContain('﻿')
    expect(r.content).toContain('1\tint y = 2;')
    // The BOM is not a line either: the count is of real lines.
    expect(r.content).toContain('(2 lines)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an anchor copied from read_file line 1 of a BOM file matches exactly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-bom-'))
  try {
    const c = { workspace: new Workspace(dir) }
    writeFileSync(join(dir, 'bom.cs'), '﻿int y = 2;\nint z = 3;\n')
    const read = await readFileTool.execute({ path: 'bom.cs' }, c)
    // Exactly what the model has in front of it: the payload of the numbered row.
    const line1 = read.content.split('\n')[1]!.split('\t')[1]!

    const edit = await editFileTool.execute(
      { path: 'bom.cs', search_text: line1, replace_text: 'int y = 9;' }, c)

    expect(edit.ok).toBe(true)
    // The whole point: an anchor copied verbatim is an exact match, with no spurious note.
    expect(edit.content).not.toMatch(/ignoring whitespace/)
    const bytes = readFileSync(join(dir, 'bom.cs'))
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(bytes.toString('utf8')).toBe('﻿int y = 9;\nint z = 3;\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- Important 8: .git prefix filtering hides files the agent needs ----------------

test('I8 list_dir shows .gitignore and .github but hides the .git directory', async () => {
  const r = await listDirTool.execute({ path: '.' }, ctx)
  const entries = r.content.split('\n')
  expect(entries).toContain('.gitignore')
  expect(entries).toContain('.gitattributes')
  expect(entries).toContain('.github/')
  expect(entries).not.toContain('.git/')
  expect(entries).not.toContain('node_modules/')
})

test('I8 list_dir says so when it filtered entries out', async () => {
  const r = await listDirTool.execute({ path: '.' }, ctx)
  expect(r.content).toMatch(/hidden: \.git\/, node_modules\//)
})

// --- Important 9: find_files filters inconsistently and returns directories --------

test('I9 find_files does not enumerate the git object store', async () => {
  const r = await findFilesTool.execute({ glob: '.git/**' }, ctx)
  expect(r.content).toMatch(/^No files match/)
})

test('I9 find_files returns files only, never directories', async () => {
  const r = await findFilesTool.execute({ glob: '*' }, ctx)
  const entries = r.content.split('\n')
  expect(entries).toContain('README.md')
  expect(entries).not.toContain('src')
  expect(entries).not.toContain('big')
  expect(entries).not.toContain('node_modules')
})

// --- Important 10: the result cap drops matches arbitrarily ------------------------

test('I10 the cap keeps the first N in sorted order and reports the true total', async () => {
  const r = await findFilesTool.execute({ glob: 'many/**/*.txt' }, ctx)
  const shown = r.content.split('\n').filter((l) => l.startsWith('many/'))
  expect(shown.length).toBe(200)
  expect(shown).toEqual([...shown].sort())
  // Pre-fix the cap ran before the sort, so the depth-1 zz* files - which sort last -
  // displaced 50 of the aa/f* files that genuinely come first.
  expect(shown[0]).toBe('many/aa/f001.txt')
  expect(shown[199]).toBe('many/aa/f200.txt')
  expect(shown).not.toContain('many/zz001.txt')
  expect(r.content).toContain('200 of 250 matches shown; narrow the pattern')
})

test('I10 exactly the cap does not claim truncation', async () => {
  const r = await findFilesTool.execute({ glob: 'exactly/*.txt' }, ctx)
  const entries = r.content.split('\n')
  expect(entries.length).toBe(200)
  expect(r.content).not.toMatch(/stopped at|matches shown|narrow the pattern/)
})

// --- Also fix: an unparseable glob is reported as "no matches" ---------------------

test('an unparseable glob is a failure naming the pattern, not an empty result', async () => {
  expect(findFilesTool.validate({ glob: '[' }).ok).toBe(false)
  const r = await findFilesTool.execute({ glob: '[' }, ctx)
  expect(r.ok).toBe(false)
  expect(r.content).toMatch(/Invalid glob pattern/)
  expect(r.content).toContain('[')
})

// --- Finding 1: case-insensitive hidden-segment filter --------------------------

test('F1 find_files filters .git even with alternate casing', async () => {
  // This is a regression test: on Windows, glob returns the *pattern's* casing for
  // literal segments, so ".GIT/**" yields ".GIT/objects/ab/cdef". The filter must
  // compare case-insensitively to catch this bypass.
  const r = await findFilesTool.execute({ glob: '.GIT/**' }, ctx)
  expect(r.content).toMatch(/^No files match/)
  expect(r.content).not.toContain('objects/ab/cdef')
})

test('F1 find_files filters node_modules even with alternate casing', async () => {
  const r = await findFilesTool.execute({ glob: 'NODE_MODULES/**/*.js' }, ctx)
  expect(r.content).toMatch(/^No files match/)
  expect(r.content).not.toContain('index.js')
})

test('F1 find_files filters mixed-case paths to hidden directories', async () => {
  // .Git/objects/ab/cdef should also be filtered
  const r = await findFilesTool.execute({ glob: '.Git/objects/ab/*' }, ctx)
  expect(r.content).toMatch(/^No files match/)
})

test('F1 list_dir filters hidden entries case-insensitively', async () => {
  // This used to run against the shared fixture, whose `.git` and `node_modules` are
  // created in lowercase and come back from readdir in lowercase — so dropping
  // `.toLowerCase()` in list-dir.ts left it green and it tested nothing about casing.
  // Real entries with real uppercase names, in a workspace of their own because a
  // case-insensitive filesystem will not hold `.git` and `.GIT` side by side.
  const dir = mkdtempSync(join(tmpdir(), 'pc-case-'))
  try {
    mkdirSync(join(dir, '.GIT'))
    mkdirSync(join(dir, 'Node_Modules'))
    writeFileSync(join(dir, 'keep.ts'), 'x')
    const r = await listDirTool.execute({ path: '.' }, { workspace: new Workspace(dir) })
    const entries = r.content.split('\n')
    expect(entries).toContain('keep.ts')
    expect(entries).not.toContain('.GIT/')
    expect(entries).not.toContain('Node_Modules/')
    expect(r.content).toContain('(hidden: .GIT/, Node_Modules/)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('F1 list_dir still filters the ordinary lowercase entries', async () => {
  const r = await listDirTool.execute({ path: '.' }, ctx)
  const lines = r.content.split('\n')
  expect(lines.some((l) => l === '.git/' || l === 'node_modules/')).toBe(false)
  expect(r.content).toContain('(hidden: .git/, node_modules/)')
})

// --- Finding 2: dotfile discovery with non-dotted patterns -------------------
//
// Node's fs.glob has no `dot` option (see find-files.ts): passing `dot: true` was
// silently ignored, so it could never have made a non-dotted pattern reach a dotted
// path. The two tests below used to claim the opposite - each used a pattern that was
// *already* explicitly dotted (".github/**/*.yml", ".*"), which glob matches with or
// without the option, so both passed identically before and after the option existed
// and demonstrated nothing about it. They are rewritten as honest characterisation
// tests of the actual, measured limitation, pinned so a future Node runtime change
// that adds real dot-matching is caught here instead of silently changing find_files.

test('F2 a non-dotted pattern does not reach a path under a dotted directory', async () => {
  const r = await findFilesTool.execute({ glob: '**/*.yml' }, ctx)
  expect(r.ok).toBe(true)
  expect(r.content).not.toContain('.github/workflows/ci.yml')
  expect(r.content).toMatch(/^No files match/)
})

test('F2 a non-dotted pattern does not reach a top-level dotfile', async () => {
  const r = await findFilesTool.execute({ glob: '*' }, ctx)
  expect(r.ok).toBe(true)
  expect(r.content).not.toContain('.gitignore')
  expect(r.content).not.toContain('.gitattributes')
  expect(r.content).not.toContain('.env')
})

test('F2 find_files still filters .git and node_modules for an explicitly dotted pattern', async () => {
  // .git/** is itself explicitly dotted, so glob does yield matches under it; the hidden
  // segment filter is what must remove them - this is independent of the dot:true finding.
  const r = await findFilesTool.execute({ glob: '.git/**' }, ctx)
  expect(r.content).toMatch(/^No files match/)
  expect(r.content).not.toContain('objects/ab/cdef')
})

test('F2 find_files applies the secrets denylist to an explicitly dotted pattern', async () => {
  // A non-dotted pattern like "**/*" never reaches .env at all (see the limitation above),
  // so it would prove nothing about the resolve() denylist. ".env" is explicitly dotted,
  // so glob genuinely yields it; the assertion is that ctx.workspace.resolve()'s secrets
  // denylist - not glob's inability to match dotfiles - is what keeps it out of the result.
  const r = await findFilesTool.execute({ glob: '.env' }, ctx)
  expect(r.ok).toBe(true)
  // Not a bare toContain('.env') check: the "No files match .env" message itself echoes
  // the pattern, so that assertion would pass trivially even if the entry were matched.
  expect(r.content.split('\n')).not.toContain('.env')
})

// --- Large whole-file reads answer with shape, not bytes ----------------------------

test('a big source file read whole comes back as declarations, not text', async () => {
  // The measured reason: 60,000 characters is 12% of a 131k window, spent permanently, on a
  // file the model usually wants ten lines of — and context rot makes that cost accuracy as
  // well as room. Structure plus line numbers turns the next call into a range.
  const body = Array.from({ length: 400 }, (_, i) =>
    `export function thing${i}(): number {\n  // padding to push this file over the limit\n  return ${i}\n}`).join('\n\n')
  writeFileSync(join(tempRoot, "src", "big.ts"), body, "utf8")

  const r = await readFileTool.execute({ path: 'src/big.ts' }, ctx)
  expect(r.ok).toBe(true)
  expect(r.content).toMatch(/too large to put in context whole/)
  expect(r.content).toContain('Declarations:')
  // Line numbers are the point: they are the argument for the follow-up call.
  expect(r.content).toMatch(/thing0\s+:1/)
  // And it is far smaller than the file it describes.
  expect(r.content.length).toBeLessThan(body.length / 2)
  // It names the ways forward rather than leaving a dead end.
  expect(r.content).toContain('start_line')
  expect(r.content).toContain('search_code')
})

test('a small file is untouched by any of this', async () => {
  writeFileSync(join(tempRoot, 'src', 'small.ts'), 'export const x = 1\n', 'utf8')
  const r = await readFileTool.execute({ path: 'src/small.ts' }, ctx)
  expect(r.ok).toBe(true)
  expect(r.content).toContain('export const x = 1')
  expect(r.content).not.toMatch(/too large/)
})

// --- A second look costs what a second look is worth --------------------------------

test('re-reading an unchanged file AFTER writing it says so instead of sending it again', async () => {
  // The repeat this was built for: read, edit, read — the model checking its own work. It
  // knows what it is looking for, so "unchanged" answers it exactly.
  const reads = new ReadMemory()
  const withMemory = { ...ctx, reads }
  writeFileSync(join(tempRoot, 'src', 'repeat.ts'), 'export const a = 1\n', 'utf8')

  const first = await readFileTool.execute({ path: 'src/repeat.ts' }, withMemory)
  expect(first.content).toContain('export const a = 1')

  // An edit that left the bytes as they were — a failed match, or an idempotent write.
  // Without the mark this is indistinguishable from a lookup.
  reads.markWritten('src/repeat.ts')

  const second = await readFileTool.execute({ path: 'src/repeat.ts' }, withMemory)
  expect(second.ok).toBe(true)
  expect(second.content).toMatch(/unchanged since you read it/)
  expect(second.content).not.toContain('export const a = 1')
  expect(second.content).toContain('full: true')
})

test('re-reading a file nothing has written hands it back, because that repeat is a lookup', async () => {
  // The reported case, and the one the cheap answer was answering wrongly: the model read
  // the file, was then asked which parameter controls some behaviour, and went back for it.
  // "You already have this" replies to a question it did not ask — it came back precisely
  // because it could not find the thing — and costs a round trip, since the next call is the
  // same read with `full: true`. Being recent in the context is most of why re-sending helps
  // at all. Bounding THAT is the loop detector's job, not this one's.
  const reads = new ReadMemory()
  const withMemory = { ...ctx, reads }
  writeFileSync(join(tempRoot, 'src', 'lookup.ts'), 'export const timeoutMs = 5000\n', 'utf8')

  await readFileTool.execute({ path: 'src/lookup.ts' }, withMemory)
  const again = await readFileTool.execute({ path: 'src/lookup.ts' }, withMemory)

  expect(again.ok).toBe(true)
  expect(again.content).toContain('export const timeoutMs = 5000')
  expect(again.content).not.toMatch(/unchanged since you read it/)
})

test('the write mark survives a cheap answer, and is spent by handing the file over', async () => {
  // The cheap answer does not put the text back in front of the model, so the mark has to
  // outlive it — otherwise the second verification read of the same edit reads as a lookup
  // and dumps the file. Handing the file over is what settles it.
  const reads = new ReadMemory()
  const withMemory = { ...ctx, reads }
  writeFileSync(join(tempRoot, 'src', 'spent.ts'), 'export const a = 1\n', 'utf8')

  await readFileTool.execute({ path: 'src/spent.ts' }, withMemory)
  reads.markWritten('src/spent.ts')
  expect((await readFileTool.execute({ path: 'src/spent.ts' }, withMemory)).content)
    .toMatch(/unchanged since you read it/)
  expect((await readFileTool.execute({ path: 'src/spent.ts' }, withMemory)).content)
    .toMatch(/unchanged since you read it/)

  // `full: true` hands it over, which spends the mark: the next repeat is a lookup again.
  await readFileTool.execute({ path: 'src/spent.ts', full: true }, withMemory)
  expect((await readFileTool.execute({ path: 'src/spent.ts' }, withMemory)).content)
    .toContain('export const a = 1')
})

test('re-reading a CHANGED file answers with the diff', async () => {
  const reads = new ReadMemory()
  const withMemory = { ...ctx, reads }
  const p = join(tempRoot, 'src', 'edited.ts')
  writeFileSync(p, 'export const a = 1\nexport const b = 2\n', 'utf8')
  await readFileTool.execute({ path: 'src/edited.ts' }, withMemory)

  writeFileSync(p, 'export const a = 1\nexport const b = 99\n', 'utf8')
  const again = await readFileTool.execute({ path: 'src/edited.ts' }, withMemory)
  expect(again.content).toMatch(/changed since you read it/)
  expect(again.content).toContain('+export const b = 99')
  // The unchanged line is not resent as content — that is the whole saving.
  expect(again.content).not.toMatch(/^1\texport const a = 1$/m)
})

test('full: true overrides it — the model still decides', async () => {
  const reads = new ReadMemory()
  const withMemory = { ...ctx, reads }
  writeFileSync(join(tempRoot, 'src', 'again.ts'), 'export const a = 1\n', 'utf8')
  await readFileTool.execute({ path: 'src/again.ts' }, withMemory)

  const forced = await readFileTool.execute({ path: 'src/again.ts', full: true }, withMemory)
  expect(forced.content).toContain('export const a = 1')
  expect(forced.content).not.toMatch(/unchanged since/)
})

test('a ranged read neither consults nor fills the memory', async () => {
  // It showed PART of a file. Claiming that as "you have seen this" would make a later diff
  // describe content the model was never given.
  const reads = new ReadMemory()
  const withMemory = { ...ctx, reads }
  await readFileTool.execute({ path: 'src/a.ts', start_line: 1, end_line: 2 }, withMemory)
  expect(reads.size()).toBe(0)

  const whole = await readFileTool.execute({ path: 'src/a.ts' }, withMemory)
  expect(whole.content).toContain('1\tone')
  expect(whole.content).toContain('5\tfive')
})

test('a large file answered with its SHAPE is not remembered as read', async () => {
  // The model was given declarations, not text. A diff against text it never saw would be
  // a description of something it cannot check.
  const reads = new ReadMemory()
  const withMemory = { ...ctx, reads }
  const body = Array.from({ length: 400 }, (_, i) =>
    `export function big${i}(): number {\n  // padding padding padding padding\n  return ${i}\n}`).join('\n\n')
  writeFileSync(join(tempRoot, 'src', 'huge.ts'), body, 'utf8')

  const shaped = await readFileTool.execute({ path: 'src/huge.ts' }, withMemory)
  expect(shaped.content).toMatch(/too large to put in context whole/)
  expect(reads.size()).toBe(0)
})

test('clearing the memory makes everything a first read again', async () => {
  // What a compaction swap does, and the correctness condition for the whole idea: the text
  // is genuinely gone from the context, so it has to be sendable again.
  const reads = new ReadMemory()
  const withMemory = { ...ctx, reads }
  writeFileSync(join(tempRoot, 'src', 'cleared.ts'), 'export const a = 1\n', 'utf8')
  await readFileTool.execute({ path: 'src/cleared.ts' }, withMemory)
  reads.clear()

  const after = await readFileTool.execute({ path: 'src/cleared.ts' }, withMemory)
  expect(after.content).toContain('export const a = 1')
  expect(after.content).not.toMatch(/unchanged since/)
})
