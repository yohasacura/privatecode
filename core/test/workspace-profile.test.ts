import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { loadMounts, readProfile, saveWorkspaceFile, storedPath } from '../src/mounts.js'

/**
 * What a workspace is FOR, not only what it contains.
 *
 * The mode a workspace opens in, and the check each folder gets. Both live in the primary
 * folder's `workspace.json` and nowhere else: a verify command is a shell command run without
 * a per-run approval, so an attached folder that could supply one would be a way to execute
 * code by pointing at a directory.
 */

let base: string

function folder(name: string): string {
  const path = join(base, name)
  mkdirSync(path, { recursive: true })
  return path
}

beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'pc-profile-')) })
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

function workspaceOf(profile: unknown): ReturnType<typeof loadMounts> {
  const primary = folder('app')
  const engine = folder('engine')
  saveWorkspaceFile(primary, {
    version: 1,
    folders: [{ path: storedPath(primary, engine), name: 'engine', access: 'write' }],
    profile: profile as never,
  })
  return loadMounts(primary)
}

describe('the mode a workspace opens in', () => {
  test('is taken from the profile', () => {
    const loaded = workspaceOf({ mode: 'plan' })
    expect(readProfile(loaded.file, loaded.mounts, 'w.json').mode).toBe('plan')
  })

  test('a mode that is not one of the four is reported and ignored', () => {
    const loaded = workspaceOf({ mode: 'yolo' })
    const profile = readProfile(loaded.file, loaded.mounts, 'w.json')
    expect(profile.mode).toBeUndefined()
    expect(profile.problems[0]).toContain('is not one of')
  })

  test('no profile at all leaves everything as it was', () => {
    const loaded = workspaceOf(undefined)
    const profile = readProfile(loaded.file, loaded.mounts, 'w.json')
    expect(profile.mode).toBeUndefined()
    expect(profile.verify).toEqual({})
    expect(profile.problems).toEqual([])
  })
})

describe('a check per folder', () => {
  test('a plain string is the command', () => {
    const loaded = workspaceOf({ verify: { app: 'npm test', engine: 'cargo test' } })
    const { verify } = readProfile(loaded.file, loaded.mounts, 'w.json')
    expect(verify.app?.command).toBe('npm test')
    expect(verify.engine?.command).toBe('cargo test')
    expect(verify.app?.timeoutMs).toBe(120_000)
  })

  test('the object form carries a timeout, capped', () => {
    const loaded = workspaceOf({ verify: { app: { command: 'x', timeoutMs: 9_000_000 } } })
    expect(readProfile(loaded.file, loaded.mounts, 'w.json').verify.app?.timeoutMs).toBe(600_000)
  })

  test('a command for a folder that is not in the workspace is reported, not silently kept', () => {
    // It looks like a configured check and is in fact a check that will never run, which is
    // exactly the shape of "I thought that was covered".
    const loaded = workspaceOf({ verify: { nope: 'npm test' } })
    const profile = readProfile(loaded.file, loaded.mounts, 'w.json')
    expect(profile.verify.nope).toBeUndefined()
    expect(profile.problems[0]).toContain('it will never run')
  })

  test('an empty command is refused rather than run as an empty shell line', () => {
    const loaded = workspaceOf({ verify: { app: '   ' } })
    const profile = readProfile(loaded.file, loaded.mounts, 'w.json')
    expect(profile.verify.app).toBeUndefined()
    expect(profile.problems[0]).toContain('must be a command string')
  })
})
