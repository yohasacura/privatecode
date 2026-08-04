import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  loadMounts, mountName, saveWorkspaceFile, storedPath, workspaceFilePath,
} from '../src/mounts.js'

/**
 * A workspace of folders from anywhere on disk.
 *
 * Every failure here is a degrade, not a refusal: a folder that was renamed, a name that
 * collides, a file that stopped being valid JSON. Refusing to open a workspace because one of
 * five folders moved would be worse than opening the other four and saying so.
 */

let root: string

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pc-mounts-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function folder(name: string): string {
  const path = join(root, name)
  mkdirSync(path, { recursive: true })
  return path
}

function writeWorkspace(primary: string, body: unknown): void {
  mkdirSync(join(primary, '.privatecode'), { recursive: true })
  writeFileSync(workspaceFilePath(primary), JSON.stringify(body), 'utf8')
}

describe('naming a folder', () => {
  test('uses the basename, made path-safe', () => {
    expect(mountName('D:\\work\\my api', new Set())).toBe('my-api')
  })

  test('numbers a collision instead of losing the folder', () => {
    expect(mountName('D:\\a\\api', new Set(['api']))).toBe('api-2')
    expect(mountName('D:\\a\\api', new Set(['api', 'api-2']))).toBe('api-3')
  })

  test('collides case-insensitively, because the filesystem does', () => {
    // `API` and `api` naming two different folders would resolve to whichever the comparison
    // reached first, which is not a thing anyone can debug.
    expect(mountName('D:\\a\\API', new Set(['api']))).toBe('API-2')
  })
})

describe('loading a workspace', () => {
  test('a folder with no definition is one writable folder named after itself', () => {
    const primary = folder('project')
    const loaded = loadMounts(primary)
    expect(loaded.mounts).toHaveLength(1)
    expect(loaded.mounts[0]).toMatchObject({ name: 'project', access: 'write', primary: true })
    expect(loaded.problems).toEqual([])
    expect(loaded.file).toBeNull()
  })

  test('attached folders arrive after the primary, in order', () => {
    const primary = folder('app')
    const engine = folder('engine')
    const refs = folder('llama')
    writeWorkspace(primary, {
      version: 1,
      folders: [{ path: engine }, { path: refs, access: 'read' }],
    })
    const { mounts, problems } = loadMounts(primary)
    expect(problems).toEqual([])
    expect(mounts.map((m) => `${m.name}:${m.access}`)).toEqual([
      'app:write', 'engine:write', 'llama:read',
    ])
    expect(mounts[0]?.primary).toBe(true)
    expect(mounts[2]?.primary).toBe(false)
  })

  test('a folder that moved is reported and the rest still open', () => {
    const primary = folder('app')
    const engine = folder('engine')
    writeWorkspace(primary, {
      version: 1,
      folders: [{ path: join(root, 'gone') }, { path: engine }],
    })
    const { mounts, problems } = loadMounts(primary)
    expect(mounts.map((m) => m.name)).toEqual(['app', 'engine'])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('no longer at')
  })

  test('a folder inside another is refused, because one file cannot have two names', () => {
    const primary = folder('app')
    mkdirSync(join(primary, 'src'), { recursive: true })
    writeWorkspace(primary, { version: 1, folders: [{ path: join(primary, 'src') }] })
    const { mounts, problems } = loadMounts(primary)
    expect(mounts).toHaveLength(1)
    expect(problems[0]).toContain('overlaps')
  })

  test('two folders that would share a name both survive, renamed', () => {
    const a = folder('one/api')
    const b = folder('two/api')
    const primary = folder('app')
    writeWorkspace(primary, { version: 1, folders: [{ path: a }, { path: b }] })
    const { mounts, problems } = loadMounts(primary)
    expect(mounts.map((m) => m.name)).toEqual(['app', 'api', 'api-2'])
    expect(problems[0]).toContain('called "api"')
  })

  test('an access value that is neither falls back to read, and says so', () => {
    // Failing closed: a typo in a config file must not silently hand out write access.
    const primary = folder('app')
    const engine = folder('engine')
    writeWorkspace(primary, { version: 1, folders: [{ path: engine, access: 'wirte' }] })
    const { mounts, problems } = loadMounts(primary)
    expect(mounts[1]?.access).toBe('read')
    expect(problems[0]).toContain('must be "write" or "read"')
  })

  test('unparseable JSON opens the folder on its own rather than failing to open', () => {
    const primary = folder('app')
    mkdirSync(join(primary, '.privatecode'), { recursive: true })
    writeFileSync(workspaceFilePath(primary), '{ "folders": [', 'utf8')
    const { mounts, problems } = loadMounts(primary)
    expect(mounts).toHaveLength(1)
    expect(problems[0]).toContain('not valid JSON')
  })

  test('a relative path in the file is read against the primary folder', () => {
    const primary = folder('app')
    folder('engine')
    writeWorkspace(primary, { version: 1, folders: [{ path: '../engine' }] })
    const { mounts, problems } = loadMounts(primary)
    expect(problems).toEqual([])
    expect(mounts[1]?.name).toBe('engine')
  })
})

describe('writing a workspace', () => {
  test('a folder beside the primary is stored relative, so moving the tree survives', () => {
    const primary = folder('app')
    const engine = folder('engine')
    expect(storedPath(primary, engine)).toBe(join('..', 'engine'))
  })

  test('a folder on another drive is stored absolute, because it cannot be relative', () => {
    expect(storedPath('D:\\work\\app', 'C:\\refs\\llama')).toBe('C:\\refs\\llama')
  })

  test('saving and loading round-trips, profile included', () => {
    const primary = folder('app')
    const engine = folder('engine')
    saveWorkspaceFile(primary, {
      version: 1,
      name: 'Everything',
      folders: [{ path: storedPath(primary, engine), name: 'core', access: 'read' }],
      profile: { mode: 'plan' },
    })
    const { mounts, name, file } = loadMounts(primary)
    expect(name).toBe('Everything')
    expect(mounts[1]).toMatchObject({ name: 'core', access: 'read' })
    // Preserved verbatim: a folder edit from an older build must not drop a newer one's profile.
    expect(file?.profile).toEqual({ mode: 'plan' })
  })
})
