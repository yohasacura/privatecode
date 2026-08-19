import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { Mount } from '../src/mounts.js'
import { deleteFileTool } from '../src/tools/delete-file.js'
import { moveFileTool } from '../src/tools/move-file.js'
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

describe('a folder root is not a file', () => {
  /**
   * `resolve('engine')` deliberately returns the engine folder's own root — reads need that,
   * and they still get it. Writes are the other half: every write tool carried its own
   * `opensAsWorkspaceRoot(abs, workspace.root)` guard, and `workspace.root` is `mounts[0]`,
   * the PRIMARY folder. So the guard compared the attached D:\engine against C:\proj, said
   * "not the root", and `delete_file({ path: 'engine', recursive: true })` removed the whole
   * attached project — permanently, since delete_file writes no checkpoint, and with no
   * approval card at all in autopilot.
   */
  test('a write to an attached folder root is refused, and the refusal names the folder', () => {
    let message = ''
    try { ws.resolveForWrite('engine') } catch (e) { message = (e as Error).message }
    expect(message).toContain('root of the folder "engine"')
  })

  test('the primary folder root too, which is the only one the old guard covered', () => {
    expect(() => ws.resolveForWrite('app')).toThrow(/root of the folder "app"/)
  })

  test('and the trailing-space spellings Windows opens as that same root', () => {
    // `<root>\. ` opens the root: the same rule the single-folder guard already knew about,
    // now applied to every folder.
    expect(() => ws.resolveForWrite('engine/. ')).toThrow(/root of the folder "engine"/)
    expect(() => ws.resolveForWrite('engine\\.')).toThrow(/root of the folder "engine"/)
  })

  test.skipIf(process.platform !== 'win32')('case alone does not get one past the check', () => {
    // What reaches the tools is whatever `resolveIn` returns, and for an absolute path with a
    // trailing space that is the caller's own casing — which a raw string comparison against
    // the recorded root does not match, on a filesystem where the two are the same directory.
    expect(() => ws.resolveForWrite(`${mounts[1]!.root.toUpperCase()}${sep}. `))
      .toThrow(/root of the folder "engine"/)
  })

  test('a single-folder workspace still refuses its own root, in words that name it', () => {
    // The write tools' own tests match on "workspace root"; a multi-folder wording that lost
    // that phrase would leave those refusals unrecognisable.
    const single = new Workspace(mounts[0]!.root)
    expect(() => single.resolveForWrite('.')).toThrow(/workspace root/i)
    expect(() => single.resolveForWrite('. ')).toThrow(/workspace root/i)
  })

  test('delete_file cannot remove an attached folder', async () => {
    const r = await deleteFileTool.execute({ path: 'engine', recursive: true }, { workspace: ws })
    expect(r.ok).toBe(false)
    expect(r.content).toContain('root of the folder "engine"')
    // The part that actually matters: the attached project is still on disk.
    expect(readFileSync(join(mounts[1]!.root, 'lib.rs'), 'utf8')).toBe('fn main() {}\n')
  })

  test('move_file cannot rename an attached folder away, nor onto one', async () => {
    const away = await moveFileTool.execute(
      { from: 'engine', to: 'app/engine-was-here' }, { workspace: ws },
    )
    expect(away.ok).toBe(false)
    expect(away.content).toContain('root of the folder "engine"')
    expect(existsSync(join(mounts[1]!.root, 'lib.rs'))).toBe(true)
    expect(existsSync(join(mounts[0]!.root, 'engine-was-here'))).toBe(false)

    // The destination end used to be refused only incidentally, by the "already a directory"
    // check — which says nothing about folders and would not have applied to a folder root
    // that did not exist on disk.
    const onto = await moveFileTool.execute(
      { from: 'app/src/main.ts', to: 'engine', overwrite: true }, { workspace: ws },
    )
    expect(onto.ok).toBe(false)
    expect(onto.content).toContain('root of the folder "engine"')
    expect(existsSync(join(mounts[0]!.root, 'src', 'main.ts'))).toBe(true)
  })

  test('ordinary paths inside a folder are untouched', async () => {
    const r = await deleteFileTool.execute({ path: 'engine/lib.rs' }, { workspace: ws })
    expect(r.ok).toBe(true)
    expect(existsSync(join(mounts[1]!.root, 'lib.rs'))).toBe(false)
    // And the folder itself survived its own file being deleted.
    expect(existsSync(mounts[1]!.root)).toBe(true)
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
