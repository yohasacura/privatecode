import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { buildSystemPrompt } from '../src/agent/prompt.js'
import type { Mount } from '../src/mounts.js'
import { findFilesTool } from '../src/tools/find-files.js'
import { listDirTool } from '../src/tools/list-dir.js'
import { searchCodeTool } from '../src/tools/search-code.js'
import { Workspace } from '../src/workspace.js'

/**
 * What the model can see once a workspace is several folders.
 *
 * The point of every case here is that ONE call covers the whole workspace. A find or a
 * search that only ever looked at the primary folder would make the other folders decorative:
 * the model would have to be told, per call, which of five places to look, and it would get
 * that wrong in a way nothing could catch.
 */

let base: string
let ws: Workspace
let mounts: Mount[]

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'pc-tools-mnt-'))
  const app = join(base, 'app')
  const engine = join(base, 'engine')
  const refs = join(base, 'refs')
  mkdirSync(join(app, 'src'), { recursive: true })
  mkdirSync(join(engine, 'src'), { recursive: true })
  mkdirSync(refs, { recursive: true })
  writeFileSync(join(app, 'src', 'main.ts'), 'export function boot() { return 1 }\n', 'utf8')
  writeFileSync(join(engine, 'src', 'boot.ts'), 'export function boot() { return 2 }\n', 'utf8')
  writeFileSync(join(refs, 'notes.md'), 'boot is documented here\n', 'utf8')
  mounts = [
    { name: 'app', root: app, access: 'write', primary: true },
    { name: 'engine', root: engine, access: 'write', primary: false },
    { name: 'refs', root: refs, access: 'read', primary: false },
  ]
  ws = new Workspace(mounts)
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

describe('list_dir', () => {
  test('the root is the list of folders, not a refusal', async () => {
    // The jail refuses `.` in a multi-folder workspace, which is right for a path and wrong
    // for a listing: `list_dir(".")` is the obvious first move and has to answer something.
    const r = await listDirTool.execute({ path: '.' }, { workspace: ws })
    expect(r.ok).toBe(true)
    expect(r.content).toContain('app/')
    expect(r.content).toContain('engine/')
    expect(r.content).toContain('refs/')
    expect(r.content).toContain('read-only reference')
  })

  test('a folder name lists that folder', async () => {
    const r = await listDirTool.execute({ path: 'engine' }, { workspace: ws })
    expect(r.ok).toBe(true)
    expect(r.content).toContain('src/')
  })
})

describe('find_files', () => {
  test('a pattern with no folder name searches every folder', async () => {
    const r = await findFilesTool.execute({ glob: '**/*.ts' }, { workspace: ws })
    expect(r.ok).toBe(true)
    expect(r.content.split('\n').sort()).toEqual(['app/src/main.ts', 'engine/src/boot.ts'])
  })

  test('a pattern that starts with a folder name searches only that folder', async () => {
    const r = await findFilesTool.execute({ glob: 'engine/**/*.ts' }, { workspace: ws })
    expect(r.ok).toBe(true)
    expect(r.content).toBe('engine/src/boot.ts')
  })

  test('a folder name on its own lists what is in it', async () => {
    const r = await findFilesTool.execute({ glob: 'refs' }, { workspace: ws })
    expect(r.ok).toBe(true)
    expect(r.content).toBe('refs/notes.md')
  })

  test('a single-folder workspace returns unprefixed paths, exactly as before', async () => {
    const single = new Workspace(mounts[0]!.root)
    const r = await findFilesTool.execute({ glob: '**/*.ts' }, { workspace: single })
    expect(r.content).toBe('src/main.ts')
  })
})

describe('search_code', () => {
  test('one search covers every folder, and each hit says which one', async () => {
    const r = await searchCodeTool.execute({ pattern: 'boot' }, { workspace: ws })
    expect(r.ok).toBe(true)
    const paths = r.content.split('\n').map((l) => l.split(':')[0])
    expect(paths).toContain('app/src/main.ts')
    expect(paths).toContain('engine/src/boot.ts')
    expect(paths).toContain('refs/notes.md')
  })

  test('a read-only folder is searched like any other — reading is the whole point of it', async () => {
    const r = await searchCodeTool.execute({ pattern: 'documented' }, { workspace: ws })
    expect(r.content).toContain('refs/notes.md')
  })

  test('scoping to a folder searches only it', async () => {
    const r = await searchCodeTool.execute({ pattern: 'boot', path: 'engine' }, { workspace: ws })
    expect(r.ok).toBe(true)
    expect(r.content).toContain('engine/src/boot.ts')
    expect(r.content).not.toContain('app/src/main.ts')
  })
})

describe('the system prompt', () => {
  test('names the folders and the addressing rule, and never a path on disk', () => {
    const prompt = buildSystemPrompt({
      workspaceRoot: mounts[0]!.root,
      mode: 'normal',
      folders: mounts.map((m) => ({ name: m.name, access: m.access })),
    })
    expect(prompt).toContain('app')
    expect(prompt).toContain('read-only reference')
    expect(prompt).toContain('app/src/thing.ts')
    expect(prompt).toContain('A path with no folder name is refused')
    // The disk layout is not the model's business and does not belong in a transcript.
    expect(prompt).not.toContain(mounts[1]!.root)
    expect(prompt).not.toContain(base)
  })

  test('a single folder produces the prompt it always did', () => {
    const before = buildSystemPrompt({ workspaceRoot: 'D:\\p', mode: 'normal' })
    const withOne = buildSystemPrompt({
      workspaceRoot: 'D:\\p', mode: 'normal', folders: [{ name: 'p', access: 'write' }],
    })
    expect(withOne).toBe(before)
    expect(before).toContain('working in the local workspace D:\\p')
  })
})
