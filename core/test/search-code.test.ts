import { beforeAll, beforeEach, afterAll, expect, test } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Workspace } from '../src/workspace.js'
import { searchCodeTool } from '../src/tools/search-code.js'

// Point every test at the vendored binary explicitly. Tests must not depend on ambient
// PATH: that would let them pass on a machine (or CI runner) that happens to have `rg`
// installed while exercising a code path the shipped product never takes.
const VENDORED_RG = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'vendor', 'ripgrep', 'rg.exe')

const SECRET = 'sk-search-code-denylist-probe-9f3e1a'

let root: string
let ctx: { workspace: Workspace }

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

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  delete process.env.PRIVATECODE_RG
})

beforeEach(() => {
  // Reset before every test, including the loud-failure tests below, so a broken override
  // set by one test never leaks into the next.
  process.env.PRIVATECODE_RG = VENDORED_RG
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

test('reports a loud failure when PRIVATECODE_RG points at nothing', async () => {
  process.env.PRIVATECODE_RG = join(root, 'this-binary-does-not-exist.exe')
  const r = await searchCodeTool.execute({ pattern: 'validateToken' }, ctx)
  expect(r.ok).toBe(false)
  expect(r.content).toMatch(/ripgrep/i)
  expect(r.content).not.toMatch(/no matches/i)
})

test('reports a loud failure when PRIVATECODE_RG points at a file that is not ripgrep', async () => {
  const notRipgrep = join(root, 'not-actually-ripgrep.exe')
  writeFileSync(notRipgrep, 'this is plain text, not a valid Windows executable\n')
  process.env.PRIVATECODE_RG = notRipgrep
  const r = await searchCodeTool.execute({ pattern: 'validateToken' }, ctx)
  expect(r.ok).toBe(false)
  expect(r.content).toMatch(/ripgrep/i)
  expect(r.content).not.toMatch(/no matches/i)
  // Pins the specific branch: a spawn that never produced an exit code (verified directly
  // - execa resolves such a case with `exitCode: undefined`, not a number) must be reported
  // as "did not run", not folded into the generic "unexpected exit status" wording that
  // numeric-but-unrecognised exit codes get.
  expect(r.content).toMatch(/did not run/i)
})
