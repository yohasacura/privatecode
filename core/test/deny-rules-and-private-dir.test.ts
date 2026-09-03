import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { PermissionEngine } from '../src/permissions/engine.js'
import { globToRegExp } from '../src/permissions/rules.js'
import { Workspace, WorkspaceViolation } from '../src/workspace.js'

/**
 * Two ways a DENY was failing open, both found by exercising the shipped engine rather than
 * by reading it.
 *
 * They are in one file because they are the same mistake in two places: a guard written
 * against the text a rule or a model SPELLED, where the filesystem answers to more than one
 * spelling of the same thing.
 */

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function workspace(): { ws: Workspace; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'pc-deny-'))
  roots.push(root)
  mkdirSync(join(root, '.privatecode'), { recursive: true })
  writeFileSync(join(root, '.privatecode', 'settings.json'), '{"permissions":{"allow":[]}}')
  return { ws: new Workspace([{ name: 'p', root, primary: true, access: 'write' }]), root }
}

/**
 * `**` at the start of a segment spans ZERO segments too.
 *
 * The old behaviour kept the flanking `/` as a literal `/`, so a `**` glob needed an actual
 * intervening directory: `certs/key.pem` was denied and `key.pem` — the same secret, one
 * directory up — was allowed, with `engine.problems` empty so nothing told the rule's author.
 * Root-level `*.pem` is still caught by the jail's own denylist; `secrets.json` had no
 * backstop at all.
 */
test('a ** deny rule covers the root-level file as well as the nested one', () => {
  const { root } = workspace()
  const engine = new PermissionEngine({
    mode: 'auto-edit',
    workspaceRoot: root,
    layers: [{
      scope: 'project',
      path: join(root, '.privatecode', 'settings.json'),
      permissions: { allow: [], ask: [], deny: ['Write(**/secrets.json)'] },
    }],
  })
  for (const path of ['secrets.json', 'conf/secrets.json', 'a/b/c/secrets.json']) {
    expect(engine.decide({ tool: 'Write', paths: [path] }).verdict, path).toBe('deny')
  }
  // And it has not become a rule that denies everything.
  expect(engine.decide({ tool: 'Write', paths: ['app.ts'] }).verdict).not.toBe('deny')
  expect(engine.problems).toEqual([])
})

test('the same rule widens ALLOW by the same rule, which is what its author means by it', () => {
  const { root } = workspace()
  const engine = new PermissionEngine({
    mode: 'normal',
    workspaceRoot: root,
    layers: [{
      scope: 'project',
      path: join(root, '.privatecode', 'settings.json'),
      permissions: { allow: ['Edit(src/**/*.ts)'], ask: [], deny: [] },
    }],
  })
  expect(engine.decide({ tool: 'Edit', paths: ['src/a.ts'] }).verdict).toBe('allow')
  expect(engine.decide({ tool: 'Edit', paths: ['src/deep/a.ts'] }).verdict).toBe('allow')
  expect(engine.decide({ tool: 'Edit', paths: ['other/a.ts'] }).verdict).not.toBe('allow')
  // A sibling directory whose name merely STARTS with the spec's is not covered.
  expect(engine.decide({ tool: 'Edit', paths: ['srcx/a.ts'] }).verdict).not.toBe('allow')
})

test('the display form agrees with the matcher about zero segments', () => {
  expect(globToRegExp('**/*.pem').test('key.pem')).toBe(true)
  expect(globToRegExp('**/*.pem').test('certs/key.pem')).toBe(true)
  expect(globToRegExp('src/**/*.ts').test('src/a.ts')).toBe(true)
  expect(globToRegExp('src/**/*.ts').test('srcx/a.ts')).toBe(false)
  // `**` NOT at a segment boundary keeps its old meaning: it is a wildcard, not a spanner.
  expect(globToRegExp('a**/b').test('ax/b')).toBe(true)
})

/**
 * `.privatecode` is where the next session reads its `permissions`, `hooks` and `format`
 * rules from, and hook and format commands run with no permission gate at all — so a write
 * there is a write to the permission system.
 *
 * The engine denies it, on the path the model spelled. The JAIL is the chokepoint that has to
 * agree, because a directory answers to more than one name: on NTFS the 8.3 alias
 * `PRIVAT~1/settings.json` reached `Write` as `allow (mode)` in auto-edit and replaced
 * the real settings file, whose planted `format` command then ran.
 */
test('the write jail refuses .privatecode/state however the path is spelled', () => {
  const { ws } = workspace()
  expect(() => ws.resolveForWrite('.privatecode/state/sessions/s1.jsonl')).toThrow(WorkspaceViolation)
  expect(() => ws.resolveForWrite('.privatecode/state/logs/run.log')).toThrow(WorkspaceViolation)
  // The names that lived at the top level before `state/` existed are state too.
  expect(() => ws.resolveForWrite('.privatecode/sessions/s1.jsonl')).toThrow(WorkspaceViolation)
  expect(() => ws.resolveForWrite('.privatecode/checkpoints.git/HEAD')).toThrow(WorkspaceViolation)
  // Case is not a defence on Windows and must not be one here either.
  expect(() => ws.resolveForWrite('.PrivateCode/State/decisions.jsonl')).toThrow(WorkspaceViolation)
})

test('the rest of .privatecode is the user\'s, and the model may write it on their behalf', () => {
  // The owner's ruling: "close only state". A skill the user asks for has to land in
  // `.privatecode/skills/`; the settings are theirs to approve, and the permission engine
  // asks for those in every mode (below) — the jail itself lets them through.
  const { ws, root } = workspace()
  expect(ws.resolveForWrite('.privatecode/skills/deck/SKILL.md')).toBe(join(root, '.privatecode', 'skills', 'deck', 'SKILL.md'))
  expect(ws.resolveForWrite('.privatecode/agents/reviewer.md')).toBe(join(root, '.privatecode', 'agents', 'reviewer.md'))
  expect(ws.resolveForWrite('.privatecode/settings.json')).toBe(join(root, '.privatecode', 'settings.json'))
  expect(ws.resolveForWrite('.privatecode/hooks/pre.ps1')).toBe(join(root, '.privatecode', 'hooks', 'pre.ps1'))
})

test('the engine denies state, asks for the settings and hooks in every mode, and lets the rest through', () => {
  const { root } = workspace()
  const autopilot = new PermissionEngine({ mode: 'autopilot', workspaceRoot: root, layers: [] })
  // The tool's own state: never, whatever the mode.
  for (const path of ['.privatecode/state/logs/run.log', '.privatecode/state/sessions/s1.jsonl', 'app/.privatecode/state/x', '.PrivateCode/sessions/s.jsonl']) {
    const d = autopilot.decide({ tool: 'Write', paths: [path] })
    expect(d.verdict, path).toBe('deny')
    expect(d.source, path).toBe('builtin')
  }
  // What decides the next session's rules: written only with the user watching, even
  // where autopilot would otherwise wave every edit through.
  for (const path of ['.privatecode/settings.json', '.privatecode/settings.local.json', '.privatecode/hooks/pre.ps1', 'app/.privatecode/hooks/x.sh']) {
    const d = autopilot.decide({ tool: 'Edit', paths: [path] })
    expect(d.verdict, path).toBe('ask')
    expect(d.source, path).toBe('builtin')
  }
  // The user's own skills, agents, commands and notes: the ordinary gate.
  for (const path of ['.privatecode/skills/deck/SKILL.md', '.privatecode/agents/reviewer.md', '.privatecode/commands/ship.md', '.privatecode/project-notes.md']) {
    expect(autopilot.decide({ tool: 'Write', paths: [path] }).verdict, path).toBe('allow')
  }
  const normal = new PermissionEngine({ mode: 'normal', workspaceRoot: root, layers: [] })
  expect(normal.decide({ tool: 'Write', paths: ['.privatecode/skills/deck/SKILL.md'] }).verdict).toBe('ask')
  expect(normal.decide({ tool: 'Write', paths: ['.privatecode/skills/deck/SKILL.md'] }).source).toBe('mode')

  // An allow rule covers a skill, and does NOT cover the settings: the ask sits above it.
  const widened = new PermissionEngine({
    mode: 'normal',
    workspaceRoot: root,
    layers: [{ scope: 'project', path: join(root, '.privatecode', 'settings.json'), permissions: { allow: ['Write(.privatecode/**)'], ask: [], deny: [] } }],
  })
  expect(widened.decide({ tool: 'Write', paths: ['.privatecode/skills/deck/SKILL.md'] }).verdict).toBe('allow')
  expect(widened.decide({ tool: 'Write', paths: ['.privatecode/settings.json'] }).verdict).toBe('ask')
  // A deny rule still wins over the ask.
  const denied = new PermissionEngine({
    mode: 'normal',
    workspaceRoot: root,
    layers: [{ scope: 'project', path: join(root, '.privatecode', 'settings.json'), permissions: { allow: [], ask: [], deny: ['Write(.privatecode/settings.json)'] } }],
  })
  expect(denied.decide({ tool: 'Write', paths: ['.privatecode/settings.json'] }).verdict).toBe('deny')
})

test('reading .privatecode is still allowed: this is a write guard, not a denylist entry', () => {
  const { ws, root } = workspace()
  // `resolve` (the read path) does not throw -- adding the segment to DENIED_SEGMENTS would
  // have blocked a session from reading its own settings.
  expect(ws.resolve('.privatecode/settings.json')).toBe(join(root, '.privatecode', 'settings.json'))
})

test('an ordinary file beside it is unaffected', () => {
  const { ws, root } = workspace()
  expect(ws.resolveForWrite('src/a.ts')).toBe(join(root, 'src', 'a.ts'))
  // Nothing was created by asking.
  expect(readdirSync(root)).toEqual(['.privatecode'])
})

/**
 * The alias itself, on the platform that has one.
 *
 * Skipped elsewhere, and skipped on a volume with 8.3 generation turned off — the point is
 * the real filesystem, so a synthetic stand-in would prove nothing. Observed on this machine:
 * `dir /X` reports `PRIVAT~1  .privatecode`, the engine's lexical deny (correctly) does not
 * see it, and before the jail learned to look at the canonical name `Write` returned
 * `Replaced PRIVAT~1/settings.json (29 bytes -> 118 bytes)` over the real settings file.
 */
test.skipIf(process.platform !== 'win32')('the 8.3 alias for .privatecode is refused too', () => {
  const { ws, root } = workspace()
  const listing = execFileSync('cmd', ['/c', 'dir', '/X', root], { encoding: 'utf8' })
  const alias = /(\w+~\d)\s+\.privatecode/.exec(listing)?.[1]
  if (alias === undefined) return // 8.3 generation is off on this volume; nothing to bypass.
  expect(() => ws.resolveForWrite(`${alias}/state/sessions/s1.jsonl`)).toThrow(WorkspaceViolation)
  // And the alias is not a way around the ask either: the jail lets the settings through
  // (they are the user's now) and the engine resolves the real name before deciding.
  expect(() => ws.resolveForWrite(`${alias}/settings.json`)).not.toThrow()
  const engine = new PermissionEngine({ mode: 'autopilot', workspaceRoot: root, layers: [] })
  expect(engine.decide({ tool: 'Write', paths: [`${alias}/settings.json`] }).verdict).toBe('ask')
  expect(engine.decide({ tool: 'Write', paths: [`${alias}/state/logs/x.log`] }).verdict).toBe('deny')
})
