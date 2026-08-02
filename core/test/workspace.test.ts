import { afterAll, expect, onTestFinished, test } from 'vitest'
import { execSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, parse, sep } from 'node:path'
import { Workspace, WorkspaceViolation } from '../src/workspace.js'

const onWindows = process.platform === 'win32'
const root = mkdtempSync(join(tmpdir(), 'pc-ws-'))

test('resolves a relative path inside the root', () => {
  const ws = new Workspace(root)
  expect(ws.resolve('src/a.ts')).toBe(join(root, 'src', 'a.ts'))
})

test('rejects traversal out of the root', () => {
  const ws = new Workspace(root)
  expect(() => ws.resolve('../outside.txt')).toThrow(WorkspaceViolation)
  expect(() => ws.resolve('src/../../outside.txt')).toThrow(WorkspaceViolation)
})

test('rejects absolute paths outside the root', () => {
  const ws = new Workspace(root)
  expect(() => ws.resolve('C:\\Windows\\System32\\drivers\\etc\\hosts'))
    .toThrow(WorkspaceViolation)
})

test('rejects secrets even inside the root', () => {
  const ws = new Workspace(root)
  for (const p of ['.env', 'config/.env.local', 'certs/server.pem', '.ssh/id_rsa']) {
    expect(() => ws.resolve(p), p).toThrow(/denied/i)
  }
})

test('allows a file that merely contains the word env', () => {
  const ws = new Workspace(root)
  expect(() => ws.resolve('src/environment.ts')).not.toThrow()
})

test('reports paths relative to the root', () => {
  const ws = new Workspace(root)
  expect(ws.relative(join(root, 'src', 'a.ts'))).toBe(`src${sep}a.ts`)
})

// ---------------------------------------------------------------------------
// Regression: a real secret, planted in a real workspace, read back the way a
// reviewer read it. Every spelling below is a name Windows opens as the secret
// even though it is not the string the denylist was written against.
// ---------------------------------------------------------------------------

const SECRET = 'API_KEY=super-secret-value\n'
const PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\n'

const planted = mkdtempSync(join(tmpdir(), 'pc-ws-secret-'))
writeFileSync(join(planted, '.env'), SECRET)
mkdirSync(join(planted, 'certs'))
writeFileSync(join(planted, 'certs', 'server.pem'), PRIVATE_KEY)
mkdirSync(join(planted, 'src'))
writeFileSync(join(planted, 'src', 'environment.ts'), 'export const ok = true\n')
// Planted so the 8.3-alias bypasses below have a real file to alias. Denial is now
// pinned to canonicalization only (see the "isShortNameAlias" removal note), and
// canonicalization can only expand an alias of a file that actually exists - an alias
// of nothing protects nothing, which is exactly why the old lexical rule was wrong.
writeFileSync(join(planted, '.env.production'), SECRET)
writeFileSync(join(planted, '.npmrc'), '//registry.npmjs.org/:_authToken=secret\n')
writeFileSync(join(planted, 'credentials'), 'aws_access_key_id=AKIAEXAMPLE\n')

/** The 8.3 alias of `.env`, when the volume generates short names at all. */
let shortNameAlias: string | null = null
try {
  shortNameAlias = realpathSync.native(join(planted, 'ENV~1'))
} catch {
  shortNameAlias = null
}

test('the planted secret is genuinely readable, so the denials below mean something', () => {
  expect(readFileSync(join(planted, '.env'), 'utf8')).toBe(SECRET)
  expect(readFileSync(join(planted, 'certs', 'server.pem'), 'utf8')).toBe(PRIVATE_KEY)
})

test.skipIf(!onWindows)('the alternate data stream and trailing dot really do reach the secret', () => {
  // `::$DATA` names the unnamed stream of the same file: plain node:fs reads it.
  expect(readFileSync(join(planted, '.env::$DATA'), 'utf8')).toBe(SECRET)
  // Windows strips a trailing dot when it opens a file, so `.env.` is `.env`.
  const typed = execSync(`cmd /c type "${join(planted, '.env.')}"`, { stdio: ['ignore', 'pipe', 'ignore'] })
  expect(typed.toString()).toContain('super-secret-value')
})

test.skipIf(shortNameAlias === null)('the 8.3 alias really does reach the secret', () => {
  expect(basename(shortNameAlias as string)).toBe('.env')
})

test('denies every spelling that opens a denied file', () => {
  const ws = new Workspace(planted)
  const bypasses = [
    '.env', // the spelling that was already denied
    '.env::$DATA', // alternate data stream
    'certs/server.pem::$DATA',
    'certs\\server.pem::$DATA',
    '.env:', // bare stream separator
    'ENV~1', // 8.3 alias of .env
    'ENV~1.PRO', // 8.3 alias of .env.production
    'certs/SERVER~1.PEM',
    'NPMRC~1',
    'CREDEN~1',
    '.env.', // trailing dot, stripped by the OS on open
    '.env ', // trailing space, likewise
    '.env. . ', // and any run of them
    'certs/server.pem.',
    'ENV~1.', // short name plus trailing dot
    'sub/.env::$DATA', // nested, not just at the top level
  ]
  for (const p of bypasses) {
    expect(() => ws.resolve(p), p).toThrow(WorkspaceViolation)
    expect(() => ws.resolve(p), p).toThrow(/denied/i)
  }
})

test('a denied spelling never yields a path to read', () => {
  const ws = new Workspace(planted)
  // Prove the closure the way the bypass was found: ask for the path, and if one
  // ever comes back, read it and fail loudly with whatever it exposed.
  for (const p of ['.env::$DATA', 'ENV~1', '.env.', '.env ', 'certs/server.pem::$DATA']) {
    let leaked: string | null = null
    try {
      leaked = readFileSync(ws.resolve(p), 'utf8')
    } catch (error) {
      expect(error, p).toBeInstanceOf(WorkspaceViolation)
    }
    expect(leaked, p).toBeNull()
  }
})

test('a real file whose name merely resembles a secret is still allowed', () => {
  const ws = new Workspace(planted)
  expect(ws.resolve('src/environment.ts')).toBe(join(planted, 'src', 'environment.ts'))
  expect(() => ws.resolve('notes~draft.md')).not.toThrow()
  expect(() => ws.resolve('report~1.markdown')).not.toThrow()
  expect(() => ws.resolve('my.backup~2.tar.gz')).not.toThrow()
  expect(() => ws.resolve('data~1.csv')).not.toThrow()
})

// There is no standalone rule for 8.3 short names: `isShortNameAlias` was removed
// after verifying (the same way the bypass itself was found) that disabling it while
// leaving canonicalization intact still denies `ENV~1` and `NPMRC~1` - `resolve()`
// re-checks the path against `canonicalize()`'s output, which expands the alias to its
// real long name and runs that back through the same denylist - while a standalone
// rule additionally rejected legitimate names like `data~1.csv` and `report~1.md` that
// alias nothing. This test pins the protection to canonicalization, not to a lexical
// 8.3 pattern match.
test.skipIf(shortNameAlias === null)('the 8.3 alias is still denied purely by canonicalization', () => {
  const ws = new Workspace(planted)
  expect(() => ws.resolve('ENV~1'), 'ENV~1').toThrow(WorkspaceViolation)
  expect(() => ws.resolve('ENV~1'), 'ENV~1').toThrow(/denied/i)
})

// ---------------------------------------------------------------------------
// Regression: `mklink /J` needs no privilege, and a lexical check cannot see
// through the junction it creates.
//
// The junction below points at C:\Windows, so it is created inside the one test
// that needs it, not at module-import time, and its cleanup is registered with
// onTestFinished right after creation. That scopes the artifact's lifetime to a
// single test: if the run is aborted or crashes, there is no window where a live
// junction into C:\Windows sits in %TEMP% waiting on an afterAll that never runs
// (which is exactly the failure that previously required manual cleanup).
// ---------------------------------------------------------------------------

function mklink(link: string, target: string): boolean {
  try {
    execSync(`cmd /c mklink /J "${link}" "${target}"`, { stdio: 'pipe' })
    return existsSync(link)
  } catch {
    return false
  }
}

/**
 * Remove the junctions themselves first, and only recurse into the directory once
 * they are gone - a recursive delete must never follow a live junction.
 */
function cleanupJunctionRoot(junctionRoot: string, links: string[]): void {
  for (const link of links) {
    try {
      rmdirSync(link)
    } catch {
      // already gone, or never created
    }
  }
  if (links.every((link) => !existsSync(link))) {
    rmSync(junctionRoot, { recursive: true, force: true })
  }
}

test('a directory junction cannot be used to escape the root', (t) => {
  if (!onWindows) return t.skip()
  const junctionRoot = mkdtempSync(join(tmpdir(), 'pc-ws-junction-'))
  const escapingLink = join(junctionRoot, 'link')
  onTestFinished(() => cleanupJunctionRoot(junctionRoot, [escapingLink]))
  if (!mklink(escapingLink, 'C:\\Windows')) return t.skip()

  const ws = new Workspace(junctionRoot)
  // The junction really does reach C:\Windows: this is the read the jail must stop.
  expect(readFileSync(join(escapingLink, 'win.ini'), 'utf8').length).toBeGreaterThan(0)
  for (const p of [
    'link',
    'link\\win.ini',
    'link/win.ini',
    'link\\..\\link\\win.ini',
    'link\\not-created-yet.txt', // a write target that does not exist yet
    'link\\sub\\deep.txt',
  ]) {
    expect(() => ws.resolve(p), p).toThrow(WorkspaceViolation)
  }
  let leaked: string | null = null
  try {
    leaked = readFileSync(ws.resolve('link\\win.ini'), 'utf8')
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceViolation)
  }
  expect(leaked).toBeNull()
})

test('a junction that stays inside the root still works', (t) => {
  if (!onWindows) return t.skip()
  const junctionRoot = mkdtempSync(join(tmpdir(), 'pc-ws-junction-'))
  const containedTarget = join(junctionRoot, 'inner')
  const containedLink = join(junctionRoot, 'ilink')
  mkdirSync(containedTarget)
  onTestFinished(() => cleanupJunctionRoot(junctionRoot, [containedLink]))
  if (!mklink(containedLink, containedTarget)) return t.skip()

  const ws = new Workspace(junctionRoot)
  expect(ws.resolve('ilink\\a.txt')).toBe(join(junctionRoot, 'ilink', 'a.txt'))
})

// ---------------------------------------------------------------------------
// Regression: the root has to be addressable, and paths that do not exist yet
// have to keep resolving, because that is the normal case for a write.
// ---------------------------------------------------------------------------

test('the workspace root addresses itself', () => {
  const ws = new Workspace(root)
  for (const p of ['', '.', './', root, root + sep]) {
    expect(ws.resolve(p), JSON.stringify(p)).toBe(root)
  }
  // resolve() and relative() round-trip at the root, not just below it.
  expect(ws.resolve(ws.relative(root))).toBe(root)
})

test('resolves paths that do not exist yet', () => {
  const ws = new Workspace(root)
  expect(ws.resolve('a/b/c/d.txt')).toBe(join(root, 'a', 'b', 'c', 'd.txt'))
})

test.skipIf(!onWindows)('unusual but legitimate Windows path shapes keep working', () => {
  const ws = new Workspace(root)
  const drive = parse(root).root.slice(0, 2) // 'C:'
  // Drive-relative: same drive as the root, so it lands inside it.
  expect(ws.resolve(`${drive}foo`)).toBe(join(root, 'foo'))
  expect(ws.resolve('src\\a/b.ts')).toBe(join(root, 'src', 'a', 'b.ts')) // mixed separators
  expect(() => ws.resolve(join(root, 'SRC', 'A.TS'))).not.toThrow() // case-differing input
  expect(ws.resolve(root.toUpperCase())).toBe(root) // case-differing root
  // UNC and device paths are outside the root and are refused lexically, before
  // any filesystem call is made against them.
  expect(() => ws.resolve('\\\\server\\share')).toThrow(WorkspaceViolation)
  expect(() => ws.resolve('\\\\?\\C:\\')).toThrow(WorkspaceViolation)
  expect(() => ws.resolve('\\\\?\\C:\\Windows\\win.ini')).toThrow(WorkspaceViolation)
})

afterAll(() => {
  // The two junction roots clean up their own artifacts via onTestFinished, scoped
  // to the tests that create them; nothing junction-related is left to do here.
  rmSync(planted, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
})
