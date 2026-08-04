import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { Mount } from '../src/mounts.js'
import { writeFileTool } from '../src/tools/write-file.js'
import { Workspace, WorkspaceViolation } from '../src/workspace.js'

/**
 * The jail, once a workspace has several folders.
 *
 * The rule that earns its strictness: in a multi-folder workspace the folder name is REQUIRED.
 * A bare `src/server.ts` is refused rather than assumed to mean the primary folder, because a
 * write that silently landed in the wrong repository is the one failure this whole design
 * exists to make impossible. The refusal names the folders, so being wrong costs one step.
 */

let base: string
let ws: Workspace
let mounts: Mount[]

function dir(...parts: string[]): string {
  const path = join(base, ...parts)
  mkdirSync(path, { recursive: true })
  return path
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'pc-wsm-'))
  const app = dir('app')
  const engine = dir('engine')
  const refs = dir('refs')
  mkdirSync(join(app, 'src'), { recursive: true })
  writeFileSync(join(app, 'src', 'main.ts'), 'export const x = 1\n', 'utf8')
  writeFileSync(join(engine, 'lib.rs'), 'fn main() {}\n', 'utf8')
  writeFileSync(join(refs, 'notes.md'), '# notes\n', 'utf8')
  mounts = [
    { name: 'app', root: app, access: 'write', primary: true },
    { name: 'engine', root: engine, access: 'write', primary: false },
    { name: 'refs', root: refs, access: 'read', primary: false },
  ]
  ws = new Workspace(mounts)
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

describe('addressing', () => {
  test('a prefixed path lands in that folder', () => {
    expect(ws.resolve('engine/lib.rs')).toBe(join(mounts[1]!.root, 'lib.rs'))
    expect(ws.resolve('app/src/main.ts')).toBe(join(mounts[0]!.root, 'src', 'main.ts'))
  })

  test('either separator works, because a model writes both', () => {
    expect(ws.resolve('app\\src\\main.ts')).toBe(join(mounts[0]!.root, 'src', 'main.ts'))
  })

  test('the folder name alone addresses the folder itself', () => {
    expect(ws.resolve('engine')).toBe(mounts[1]!.root)
  })

  test('an unprefixed path is refused, and the refusal names the folders', () => {
    let message = ''
    try { ws.resolve('src/main.ts') } catch (e) { message = (e as Error).message }
    expect(message).toContain('"src" is not a folder in this workspace')
    expect(message).toContain('app')
    expect(message).toContain('engine')
    expect(message).toContain('refs (read-only)')
  })

  test('the workspace root itself is not a place, and the error says what to do', () => {
    expect(() => ws.resolve('.')).toThrow(/start the path with a folder name/)
    expect(() => ws.resolve('')).toThrow(/start the path with a folder name/)
  })

  test('the name is matched case-insensitively, like the filesystem', () => {
    expect(ws.resolve('ENGINE/lib.rs')).toBe(join(mounts[1]!.root, 'lib.rs'))
  })

  test('escaping a folder is still refused after the prefix is stripped', () => {
    expect(() => ws.resolve('engine/../../elsewhere')).toThrow(WorkspaceViolation)
  })

  test('the secrets denylist still applies inside an attached folder', () => {
    expect(() => ws.resolve('engine/.env')).toThrow(/access denied/)
  })

  test('an absolute path inside a folder resolves; outside every folder it does not', () => {
    expect(ws.resolve(join(mounts[1]!.root, 'lib.rs'))).toBe(join(mounts[1]!.root, 'lib.rs'))
    expect(() => ws.resolve(join(base, 'nowhere', 'x.ts')))
      .toThrow(/not inside any of its folders/)
  })
})

describe('read-only folders', () => {
  test('read what you like', () => {
    expect(ws.resolve('refs/notes.md')).toBe(join(mounts[2]!.root, 'notes.md'))
  })

  test('but a write is refused by the jail, not by a rule', () => {
    // In the jail on purpose: a rule can be written, remembered and granted, and a reference
    // folder that a rule could open is not a reference folder.
    let message = ''
    try { ws.resolveForWrite('refs/notes.md') } catch (e) { message = (e as Error).message }
    expect(message).toContain('"refs" is attached read-only')
  })

  test('a writable folder is unaffected', () => {
    expect(ws.resolveForWrite('engine/lib.rs')).toBe(join(mounts[1]!.root, 'lib.rs'))
  })

  test('the write tools themselves refuse it, and say why', async () => {
    const refused = await writeFileTool.execute(
      { path: 'refs/notes.md', content: 'overwritten' }, { workspace: ws },
    )
    expect(refused.ok).toBe(false)
    expect(refused.content).toContain('attached read-only')
    // And the file on disk is untouched, which is the part that matters.
    expect(readFileSync(join(mounts[2]!.root, 'notes.md'), 'utf8')).toBe('# notes\n')

    const allowed = await writeFileTool.execute(
      { path: 'engine/new.rs', content: 'fn ok() {}\n' }, { workspace: ws },
    )
    expect(allowed.ok).toBe(true)
  })
})

describe('what the model is shown', () => {
  test('a path is written back with its folder name', () => {
    expect(ws.display(join(mounts[1]!.root, 'lib.rs'))).toBe('engine/lib.rs')
    expect(ws.display(mounts[1]!.root)).toBe('engine')
  })

  test('a single-folder workspace shows no prefix at all', () => {
    const single = new Workspace(mounts[0]!.root)
    expect(single.multi).toBe(false)
    expect(single.display(join(mounts[0]!.root, 'src', 'main.ts'))).toBe('src/main.ts')
    expect(single.resolve('src/main.ts')).toBe(join(mounts[0]!.root, 'src', 'main.ts'))
    expect(single.resolve('.')).toBe(mounts[0]!.root)
  })

  test('the folder a path belongs to can be asked for', () => {
    expect(ws.mountFor(join(mounts[2]!.root, 'notes.md'))?.name).toBe('refs')
    expect(ws.mountFor(join(base, 'elsewhere'))).toBeUndefined()
  })
})
