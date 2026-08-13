import { beforeAll, beforeEach, afterAll, expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Workspace } from '../src/workspace.js'
import { searchCodeTool } from '../src/tools/search-code.js'

// Point every test at the vendored binary explicitly. Tests must not depend on ambient
// PATH: that would let them pass on a machine (or CI runner) that happens to have `rg`
// installed while exercising a code path the shipped product never takes. The one
// exception is the vendored-default test at the bottom, which deliberately unsets the
// override - see the comment there.
const VENDORED_RG = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'vendor', 'ripgrep', 'rg.exe')

const SECRET = 'sk-search-code-denylist-probe-9f3e1a'

let root: string
let ctx: { workspace: Workspace }

/**
 * A scratch workspace of its own. Several tests below need a tree that the other tests
 * must not see - a four-megabyte line, a file with a deny ACE on it, five files with
 * identical match counts - because those fixtures change the result of every other
 * search that walks the same root.
 */
async function withWorkspace(
  fn: (dir: string, c: { workspace: Workspace }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'pc-rg-case-'))
  try {
    await fn(dir, { workspace: new Workspace(dir) })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * A batch file that answers `--version` the way ripgrep does and prints whatever `body`
 * says for any other invocation. It exists so a test can drive the output-handling
 * branches (an unparseable result line, in particular) with a binary that legitimately
 * passes the resolution-time ripgrep check - i.e. without weakening that check.
 */
function writeStubRg(path: string, body: string[]): void {
  writeFileSync(
    path,
    ['@echo off', 'if "%~1"=="--version" goto version', ...body, 'exit /b 0', ':version', 'echo ripgrep 14.1.1', 'exit /b 0', ''].join('\r\n'),
  )
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-rg-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'auth.ts'), 'export function validateToken(t: string) {\n  return t.length > 0\n}\n')
  writeFileSync(join(root, 'src', 'ui.tsx'), 'export const Button = () => null\n')

  // Critical 2 fixtures: files `read_file` and `Workspace.resolve()` already refuse.
  // Planted with a distinctive secret so a leak is unambiguous rather than a coincidental
  // substring match.
  writeFileSync(join(root, '.env'), `SECRET_KEY=${SECRET}\n`)
  writeFileSync(join(root, 'id_rsa'), `-----BEGIN OPENSSH PRIVATE KEY-----\n${SECRET}\n-----END OPENSSH PRIVATE KEY-----\n`)
  writeFileSync(join(root, 'secret.pem'), `${SECRET}\n`)
  writeFileSync(join(root, 'credentials'), `user:${SECRET}\n`)

  ctx = { workspace: new Workspace(root) }
})

/**
 * Whatever the developer running this suite already had. Teardown used to `delete` both
 * keys unconditionally, which is not "restore": for anyone who runs the suite with
 * PRIVATECODE_RG genuinely set, the tests silently unset it.
 */
const SAVED_ENV = {
  PRIVATECODE_RG: process.env.PRIVATECODE_RG,
  RIPGREP_CONFIG_PATH: process.env.RIPGREP_CONFIG_PATH,
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  restoreEnv()
})

beforeEach(() => {
  // Reset before every test, including the loud-failure tests below, so a broken override
  // set by one test never leaks into the next.
  process.env.PRIVATECODE_RG = VENDORED_RG
  delete process.env.RIPGREP_CONFIG_PATH
})

test('finds matches with file and line number', async () => {
  const r = await searchCodeTool.execute({ pattern: 'validateToken' }, ctx)
  expect(r.ok).toBe(true)
  expect(r.content).toMatch(/src[\\/]auth\.ts:1/)
  expect(r.content).toContain('validateToken')
})

test('respects a glob filter', async () => {
  const r = await searchCodeTool.execute({ pattern: 'export', glob: '*.tsx' }, ctx)
  expect(r.content).toContain('ui.tsx')
  expect(r.content).not.toContain('auth.ts')
})

test('reports no matches as a successful, explicit result', async () => {
  const r = await searchCodeTool.execute({ pattern: 'zzz_nothing_zzz' }, ctx)
  expect(r.ok).toBe(true)
  expect(r.content).toMatch(/no matches/i)
})

test('rejects an empty pattern', () => {
  expect(searchCodeTool.validate({ pattern: '' }).ok).toBe(false)
})

test('reports an invalid regex as a tool failure', async () => {
  const r = await searchCodeTool.execute({ pattern: '(' }, ctx)
  expect(r.ok).toBe(false)
  expect(r.content).toMatch(/regex|parse/i)
})

test('never returns the contents of a denylisted file (.env, id_rsa, *.pem, credentials)', async () => {
  const r = await searchCodeTool.execute({ pattern: SECRET }, ctx)
  // The "no matches" message legitimately echoes the pattern back (`No matches for
  // /<pattern>/`), so asserting the pattern itself is absent would be a false positive.
  // What must be absent is a *hit line* naming one of the denylisted files - exact
  // equality with the clean no-match message is the precise way to say "found nothing,
  // not even a leaked line".
  expect(r.content).not.toMatch(/\.env:|id_rsa:|secret\.pem:|credentials:/)
  expect(r.ok).toBe(true)
  expect(r.content).toBe(`No matches for /${SECRET}/`)
})

/**
 * The two denylist layers, pinned one at a time.
 *
 * The test above plants only files that BOTH layers cover, so it survived either layer
 * being deleted: making `lineStaysInsideWorkspace`'s catch `return true`, or emptying
 * `DENIED_GLOBS`, each kept the suite green. That is not a test of defence in depth, it
 * is a test that at least one of two guards happens to be present.
 *
 * They are genuinely different guarantees. `DENIED_GLOBS` keeps ripgrep from ever
 * *opening* the file; `lineStaysInsideWorkspace` keeps a result line from ever reaching
 * the transcript, and is the only one of the two that can see through canonicalization or
 * survive the argv changing. Each is given a fixture the other cannot act on.
 */

test('the per-line workspace filter alone keeps a denylisted hit out of the result', async () => {
  await withWorkspace(async (dir, c) => {
    // A stub that ignores argv entirely, so DENIED_GLOBS cannot possibly be what stops
    // this: the only thing standing between the model and the line is the resolve() check
    // applied to each result line. That is also the realistic shape of the risk - the
    // globs are ripgrep flags, and stop applying the moment the argv changes.
    const stub = join(dir, 'stub-rg.bat')
    // The leaked payload is deliberately NOT the pattern: "No matches for /<pattern>/"
    // echoes the pattern back, so searching for the secret would make any assertion about
    // the secret's absence a false positive.
    writeStubRg(stub, ['echo .env:1:SECRET_KEY=leaked-through-the-denylist'])
    process.env.PRIVATECODE_RG = stub

    const r = await searchCodeTool.execute({ pattern: 'SECRET_KEY' }, c)

    expect(r.content).not.toContain('leaked-through-the-denylist')
    expect(r.content).not.toMatch(/\.env:/)
    expect(r.ok).toBe(true)
    expect(r.content).toMatch(/no matches/i)
  })
})

test('the ripgrep exclusions alone keep a denylisted file from being opened at all', async () => {
  await withWorkspace(async (dir, c) => {
    // The per-line filter cannot express "never read the bytes", and it is invisible in
    // the result either way - so the observable is whether ripgrep *tried*. Both files get
    // a deny ACE: ripgrep names on stderr every file it failed to open, so the bait proves
    // the mechanism works and is what keeps this test from passing on a silently-failed
    // icacls, while id_rsa must be absent because ripgrep was never allowed near it.
    const key = join(dir, 'id_rsa')
    const bait = join(dir, 'bait.txt')
    writeFileSync(key, `${SECRET}\n`)
    writeFileSync(bait, `${SECRET}\n`)
    const user = process.env.USERNAME ?? process.env.USER ?? ''
    execFileSync('icacls', [key, '/deny', `${user}:(R)`], { stdio: 'ignore' })
    execFileSync('icacls', [bait, '/deny', `${user}:(R)`], { stdio: 'ignore' })
    try {
      const r = await searchCodeTool.execute({ pattern: SECRET }, c)
      expect(r.content).toMatch(/bait\.txt/)
      expect(r.content).toMatch(/denied|os error 5/i)
      expect(r.content).not.toMatch(/id_rsa/)
      expect(r.content).not.toContain(SECRET.slice(0, 12))
    } finally {
      execFileSync('icacls', [key, '/remove:d', user], { stdio: 'ignore' })
      execFileSync('icacls', [bait, '/remove:d', user], { stdio: 'ignore' })
    }
  })
})

test('reports a loud failure when PRIVATECODE_RG points at nothing', async () => {
  process.env.PRIVATECODE_RG = join(root, 'this-binary-does-not-exist.exe')
  const r = await searchCodeTool.execute({ pattern: 'validateToken' }, ctx)
  expect(r.ok).toBe(false)
  expect(r.content).toMatch(/ripgrep/i)
  expect(r.content).not.toMatch(/no matches/i)
})

/**
 * Critical 1. The previous version of this test used a single fixture named
 * `not-actually-ripgrep.exe` and passed for the wrong reason: only the `.exe` shape made
 * execa fail to spawn at all (`exitCode: undefined`). Renaming that same fixture `.bat`
 * turned the result into `ok: true, "No matches"` - the tool telling the model the user's
 * code does not contain what it searched for, because a broken binary was mistaken for an
 * exhaustive empty search. The extension must not decide the outcome, so every shape a
 * wrong `PRIVATECODE_RG` can take is enumerated here:
 *
 *   - a directory                    (spawns via cmd, exit 1, shell error on stderr)
 *   - a text file named `.bat`       (spawns via cmd, exit 1, shell error on stderr)
 *   - a text file with no extension  (spawns via cmd, exit 0, *empty* stdout)
 *   - a text file named `.exe`       (never spawns at all, exitCode undefined)
 *   - a real executable that is not ripgrep (spawns fine, exit 1, its own stderr)
 *
 * All five must be refused before a search is ever attempted, and none may be reported as
 * an empty result.
 */
const brokenBinaryShapes: Array<{ name: string; make: (dir: string) => string; expect: RegExp }> = [
  {
    name: 'a directory',
    make: (dir) => {
      const p = join(dir, 'a-directory')
      mkdirSync(p)
      return p
    },
    expect: /not a file/i,
  },
  {
    name: 'a text file named .bat',
    make: (dir) => {
      const p = join(dir, 'fake.bat')
      writeFileSync(p, 'this is plain text, not a valid batch file\n')
      return p
    },
    expect: /is not ripgrep/i,
  },
  {
    name: 'a text file with a non-executable extension',
    make: (dir) => {
      const p = join(dir, 'credentials.json')
      writeFileSync(p, '{"not":"ripgrep"}\n')
      return p
    },
    expect: /is not ripgrep/i,
  },
  {
    name: 'a text file named .exe',
    make: (dir) => {
      const p = join(dir, 'fake.exe')
      writeFileSync(p, 'this is plain text, not a valid Windows executable\n')
      return p
    },
    expect: /is not ripgrep/i,
  },
  {
    name: 'a real executable that is not ripgrep',
    make: () => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'hostname.exe'),
    expect: /is not ripgrep/i,
  },
]

for (const shape of brokenBinaryShapes) {
  test(`reports a loud failure when PRIVATECODE_RG points at ${shape.name}`, async () => {
    await withWorkspace(async (dir) => {
      process.env.PRIVATECODE_RG = shape.make(dir)
      const r = await searchCodeTool.execute({ pattern: 'validateToken' }, ctx)
      expect(r.ok).toBe(false)
      expect(r.content).toMatch(/ripgrep/i)
      expect(r.content).toMatch(shape.expect)
      // The whole point: a binary that cannot search must never be reported as a search
      // that found nothing.
      expect(r.content).not.toMatch(/no matches/i)
    })
  })
}

/**
 * Critical 1, second layer, pinned on its own.
 *
 * The resolution-time `--version` handshake catches all five shapes above, which means it
 * would also mask the `execute`-time exit-code rules and leave them untested. They are a
 * separate layer and must hold alone: a binary can pass a handshake and still not be
 * ripgrep (a wrapper script, a shim, a binary swapped after resolution was cached). Both
 * stubs below answer `--version` exactly as ripgrep does, so only the exit-code rules can
 * catch them. Measured with the handshake and the `isFile()` check both disabled, these
 * rules alone still reject every one of the five shapes above - the two layers are
 * independent, not one guard with a spare.
 */
test('reports a loud failure when ripgrep exits 0 without printing a match', async () => {
  await withWorkspace(async (dir, c) => {
    const stub = join(dir, 'stub-rg.bat')
    writeStubRg(stub, ['exit /b 0'])
    process.env.PRIVATECODE_RG = stub
    const r = await searchCodeTool.execute({ pattern: 'validateToken' }, c)
    // Exit 0 means "matches were found". Nothing on stdout therefore means the process
    // is not ripgrep, whatever it answered at resolution time.
    expect(r.ok).toBe(false)
    expect(r.content).not.toMatch(/no matches/i)
  })
})

test('reports a loud failure when ripgrep exits 1 but complains on stderr', async () => {
  await withWorkspace(async (dir, c) => {
    const stub = join(dir, 'stub-rg.bat')
    writeStubRg(stub, ['echo something is badly wrong 1>&2', 'exit /b 1'])
    process.env.PRIVATECODE_RG = stub
    const r = await searchCodeTool.execute({ pattern: 'validateToken' }, c)
    // Real ripgrep exits 1 silently when it simply found nothing; a shell error on stderr
    // with the same code is the "no matches" impostor this whole spec is written against.
    expect(r.ok).toBe(false)
    expect(r.content).not.toMatch(/no matches/i)
    expect(r.content).toMatch(/something is badly wrong/)
  })
})

/** Important 2. */
test('bounds the width of a single result line', async () => {
  await withWorkspace(async (dir, c) => {
    // Minified bundles, lockfiles, base64 blobs and single-line JSON are ordinary, and
    // `dist/` is not excluded the way `node_modules/` and `.git/` are.
    mkdirSync(join(dir, 'dist'))
    writeFileSync(join(dir, 'dist', 'bundle.js'), `${'x'.repeat(2_000_000)}needleWideLine${'y'.repeat(2_000_000)}\n`)

    const r = await searchCodeTool.execute({ pattern: 'needleWideLine' }, c)
    expect(r.ok).toBe(true)
    expect(r.content).toMatch(/bundle\.js:1/)
    // The transcript this lands in is append-only, so the bound has to be a real bound,
    // not "smaller than the file". This case is bounded by ripgrep's `--max-columns`; the
    // JS cap that the code calls "the guarantee" is pinned by the test below, because a
    // 2,000-character ceiling is satisfied by the `--max-columns` preview on its own.
    expect(r.content.length).toBeLessThan(2_000)
  })
})

/**
 * Important 2, second layer.
 *
 * `--max-columns` bounds the *matched line*, not the `path:line:` prefix ripgrep prepends,
 * and it is a ripgrep flag, so it stops applying the moment the argv changes. search-code.ts
 * says so in as many words - "the width bound is the guarantee; the flag is only the cheap
 * way to get most of it" - but nothing tested it: with a short path, the preview alone
 * comes to ~350 characters, so deleting `truncateLine` entirely left the 2,000-character
 * assertion above green.
 *
 * A 200-character filename puts the prefix outside anything ripgrep bounds: measured, the
 * finished line is ~534 characters with the JS cap removed and exactly 421 with it.
 */
test('bounds the width of a result line whose length is in the path, not the match', async () => {
  await withWorkspace(async (dir, c) => {
    const longName = `${'n'.repeat(200)}.txt`
    writeFileSync(join(dir, longName), `${'x'.repeat(500)}needleLongPath${'y'.repeat(500)}\n`)

    const r = await searchCodeTool.execute({ pattern: 'needleLongPath' }, c)

    expect(r.ok).toBe(true)
    expect(r.content).toContain('[... line truncated]')
    // 400 characters plus the ' [... line truncated]' marker, and nothing more.
    expect(r.content.length).toBeLessThanOrEqual(421)
  })
})

/** Important 3. */
test('keeps good matches when one file in the workspace cannot be read', async () => {
  await withWorkspace(async (dir, c) => {
    const readable = join(dir, 'readable.txt')
    const locked = join(dir, 'locked.txt')
    writeFileSync(readable, 'needleUnreadable in a readable file\n')
    writeFileSync(locked, 'needleUnreadable in a locked file\n')
    const user = process.env.USERNAME ?? process.env.USER ?? ''
    // ripgrep exits 2 for *any* error, including a non-fatal per-file one, while still
    // printing every good match it found. One ACL-restricted file, cloud placeholder or
    // locked file must not discard the whole workspace's results.
    execFileSync('icacls', [locked, '/deny', `${user}:(R)`], { stdio: 'ignore' })
    try {
      const r = await searchCodeTool.execute({ pattern: 'needleUnreadable' }, c)
      expect(r.ok).toBe(true)
      expect(r.content).toMatch(/readable\.txt:1:needleUnreadable/)
      // If the deny ACE silently failed to apply, ripgrep would have exited 0 and there
      // would be no warning - so this assertion is also what keeps the test honest.
      expect(r.content).toMatch(/warning/i)
      expect(r.content).toMatch(/denied|os error 5/i)
    } finally {
      execFileSync('icacls', [locked, '/remove:d', user], { stdio: 'ignore' })
    }
  })
})

/** Important 4. */
test('returns the same truncated result set every time', async () => {
  await withWorkspace(async (dir, c) => {
    // Five files with an equal number of matches, and a cap smaller than the total.
    // `--max-count` is ripgrep's *per-file* cap and ripgrep walks directories in
    // parallel, so without an explicit ordering the surviving subset is whichever files
    // the worker threads happened to finish first.
    for (const name of ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']) {
      writeFileSync(join(dir, name), 'needleDeterminism one\nneedleDeterminism two\n')
    }
    const answers = new Set<string>()
    for (let i = 0; i < 8; i++) {
      const r = await searchCodeTool.execute({ pattern: 'needleDeterminism', max_results: 2 }, c)
      expect(r.ok).toBe(true)
      answers.add(r.content)
    }
    expect([...answers]).toHaveLength(1)
  })
})

/** Important 5. */
test('ignores RIPGREP_CONFIG_PATH from the ambient environment', async () => {
  await withWorkspace(async (dir, c) => {
    writeFileSync(join(dir, '.hidden-notes.txt'), 'needleAmbientConfig\n')
    const config = join(dir, 'rgconfig')
    writeFileSync(config, '--hidden\n')
    process.env.RIPGREP_CONFIG_PATH = config
    try {
      const r = await searchCodeTool.execute({ pattern: 'needleAmbientConfig' }, c)
      // An offline privacy tool must not let an environment variable inject flags into
      // its search engine: with the config honoured, `--hidden` changes traversal and the
      // dotfile turns up. (`--pre=<path>` in the same file makes ripgrep try to launch
      // that command against every file it walks.)
      expect(r.content).not.toMatch(/hidden-notes/)
      expect(r.ok).toBe(true)
    } finally {
      delete process.env.RIPGREP_CONFIG_PATH
    }
  })
})

/**
 * Critical 1 regression. Real ripgrep exits 1 with non-empty stderr for a workspace whose
 * `.gitignore` has a malformed line: the parse error is a warning, not a failure, and does
 * not set an error exit code. Treating any exit-1-with-stderr as "this is not really
 * ripgrep" makes that ordinary warning indistinguishable from a broken binary, so "no
 * matches" becomes unreachable on any repo with a malformed .gitignore, .ignore or
 * .rgignore line - confirmed directly against the vendored binary: `rg --regexp
 * zzz_absent_zzz .` over a workspace whose only `.gitignore` line is `[` exits 1 and prints
 * `rg: .\.gitignore: line 1: error parsing glob '[': unclosed character class; missing
 * ']'` on stderr, with empty stdout.
 */
test('reports "no matches" with a warning when the only stderr is a malformed .gitignore line', async () => {
  await withWorkspace(async (dir, c) => {
    writeFileSync(join(dir, 'a.ts'), 'hello world\n')
    writeFileSync(join(dir, '.gitignore'), '[\n[\n')
    const r = await searchCodeTool.execute({ pattern: 'zzz_absent_zzz' }, c)
    expect(r.ok).toBe(true)
    expect(r.content).toMatch(/no matches/i)
    expect(r.content).toMatch(/warning/i)
    expect(r.content).toMatch(/gitignore/i)
  })
})

/** Critical 1 regression, other direction: the same malformed ignore file must not swallow real matches. */
test('still returns real matches, with the same warning, when the .gitignore is malformed', async () => {
  await withWorkspace(async (dir, c) => {
    writeFileSync(join(dir, 'a.ts'), 'hello world\n')
    writeFileSync(join(dir, '.gitignore'), '[\n[\n')
    const r = await searchCodeTool.execute({ pattern: 'hello' }, c)
    expect(r.ok).toBe(true)
    expect(r.content).toMatch(/a\.ts:1:hello world/)
    expect(r.content).toMatch(/warning/i)
    expect(r.content).toMatch(/gitignore/i)
  })
})

/** Critical 1 regression variant: one bad line in each of two ignore files. */
test('reports "no matches" with a warning when multiple ignore files have malformed lines', async () => {
  await withWorkspace(async (dir, c) => {
    writeFileSync(join(dir, 'a.ts'), 'hello world\n')
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, '.gitignore'), '[\n')
    writeFileSync(join(dir, 'sub', '.gitignore'), '[\n')
    const r = await searchCodeTool.execute({ pattern: 'zzz_absent_zzz' }, c)
    expect(r.ok).toBe(true)
    expect(r.content).toMatch(/no matches/i)
    expect(r.content).toMatch(/warning/i)
  })
})

/** Critical 1 regression variant: one bad line in each of two ignore files, with matches. */
test('still returns real matches with a warning when multiple ignore files have malformed lines', async () => {
  await withWorkspace(async (dir, c) => {
    writeFileSync(join(dir, 'a.ts'), 'hello world\n')
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, '.gitignore'), '[\n')
    writeFileSync(join(dir, 'sub', '.gitignore'), '[\n')
    const r = await searchCodeTool.execute({ pattern: 'hello' }, c)
    expect(r.ok).toBe(true)
    expect(r.content).toMatch(/a\.ts:1:hello world/)
    expect(r.content).toMatch(/warning/i)
  })
})

/** Minor 6. */
test('does not claim truncation when exactly max_results matches exist', async () => {
  await withWorkspace(async (dir, c) => {
    writeFileSync(join(dir, 'three.ts'), 'needleExact\nneedleExact\nneedleExact\n')
    const r = await searchCodeTool.execute({ pattern: 'needleExact', max_results: 3 }, c)
    expect(r.ok).toBe(true)
    expect(r.content.split('\n')).toHaveLength(3)
    expect(r.content).not.toMatch(/stopped at/i)
  })
})

/** Minor 6, grammar. */
test('says "1 match", not "1 matches", when truncating at one', async () => {
  await withWorkspace(async (dir, c) => {
    writeFileSync(join(dir, 'three.ts'), 'needleGrammar\nneedleGrammar\nneedleGrammar\n')
    const r = await searchCodeTool.execute({ pattern: 'needleGrammar', max_results: 1 }, c)
    expect(r.ok).toBe(true)
    expect(r.content).toMatch(/stopped at 1 match\b/)
    expect(r.content).not.toMatch(/1 matches/)
  })
})

/** Minor 7. */
test('drops a result line the workspace filter cannot parse', async () => {
  await withWorkspace(async (dir, c) => {
    // A safety filter must drop what it cannot parse, not pass it through. Nothing
    // ripgrep prints under the current flags takes this shape, but adding `--context`,
    // `--heading` or `--json` later would make a fail-open filter a bypass, so the
    // behaviour is pinned with a stub that speaks ripgrep's `--version` handshake and
    // then prints a line with no `path:line:` prefix.
    const stub = join(dir, 'stub-rg.bat')
    writeStubRg(stub, ['echo binary file matches [found NUL byte around offset 31]'])
    process.env.PRIVATECODE_RG = stub
    const r = await searchCodeTool.execute({ pattern: 'anything' }, c)
    expect(r.content).not.toMatch(/binary file matches/)
    expect(r.ok).toBe(true)
    expect(r.content).toMatch(/no matches/i)
  })
})

/** Minor 8. */
test('resolves the vendored ripgrep when PRIVATECODE_RG is unset', async () => {
  // Every other test sets the override, so the branch the shipped product actually takes
  // - `vendoredRgPath()`, resolved relative to the module - had no coverage at all: a
  // wrong relative path there would have left the whole suite green. PATH is emptied for
  // the duration so the system-ripgrep fallback cannot stand in for the vendored copy on
  // a machine that happens to have `rg` installed.
  const savedPath = process.env.PATH
  delete process.env.PRIVATECODE_RG
  process.env.PATH = ''
  try {
    const r = await searchCodeTool.execute({ pattern: 'validateToken' }, ctx)
    expect(r.ok).toBe(true)
    expect(r.content).toMatch(/src[\\/]auth\.ts:1/)
  } finally {
    if (savedPath === undefined) delete process.env.PATH
    else process.env.PATH = savedPath
  }
})

/**
 * Scoping a search to one FILE. Regression: ripgrep omits the filename when given a
 * single file, printing `12:text` instead of `path:12:text`, and `lineStaysInsideWorkspace`
 * — the jail check every result line passes through — drops whatever it cannot parse as
 * `path:line:`. So a scoped search over a file that plainly contained the pattern came
 * back "no matches". `--with-filename` keeps the output shape invariant.
 */
test('a search scoped to a single file finds matches in it', async () => {
  const r = await searchCodeTool.execute({ pattern: 'validateToken', path: 'src/auth.ts' }, ctx)
  expect(r.ok).toBe(true)
  expect(r.content).toMatch(/src[\/]auth\.ts:1/)
  expect(r.content).not.toMatch(/no matches/i)
})

/** A scoped search reaches into dot-directories: naming a location explicitly means you
 * want what is in it, and it is what makes a saved output log searchable at all. */
test('a scoped search looks inside a hidden directory', async () => {
  const logDir = join(ctx.workspace.root, '.privatecode', 'state', 'logs')
  mkdirSync(logDir, { recursive: true })
  writeFileSync(join(logDir, 'run.log'), 'noise\nNEEDLE_IN_LOG here\nnoise\n')

  const unscoped = await searchCodeTool.execute({ pattern: 'NEEDLE_IN_LOG' }, ctx)
  expect(unscoped.content).toMatch(/no matches/i)

  const scoped = await searchCodeTool.execute(
    { pattern: 'NEEDLE_IN_LOG', path: '.privatecode/state/logs' }, ctx)
  expect(scoped.ok).toBe(true)
  expect(scoped.content).toMatch(/run\.log:2:NEEDLE_IN_LOG here/)
})
