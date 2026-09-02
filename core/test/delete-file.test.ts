import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ROSLYN_ENV, navProcess, stopNavProcess } from '../src/csharp/nav-process.js'
import { deleteFileTool } from '../src/tools/delete-file.js'
import { Workspace } from '../src/workspace.js'

/**
 * What a delete has to tell the rest of the session.
 *
 * The C# navigation index is built once per workspace: `ensureLoaded` answers
 * `{ ok: true, cached: true }` for as long as `loadedRoot` matches, and nothing but an
 * explicit `invalidate()` ever clears it. edit_file, write_file and move_file all report
 * their writes; delete_file reported nothing, so `csharp_nav` went on naming a definition in
 * a file that no longer existed — with ok:true, which the model has no reason to doubt until
 * `read_file` on that path answers "File not found".
 *
 * The helper is never spawned here: `navProcess()` only constructs, and a .NET process starts
 * on the first question, which these tests do not ask.
 */

let base: string
let root: string
let ws: Workspace
let previousHelper: string | undefined

/** The private field the tool is expected to clear, reached the way csharp-nav.test.ts does. */
function loadedRoot(): string | null {
  return (navProcess() as unknown as { loadedRoot: string | null }).loadedRoot
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'pc-del-'))
  root = join(base, 'ws')
  mkdirSync(root)
  ws = new Workspace(root)
  // `resolveHelper` asks only that the path exist, so a stand-in file is enough to get a real
  // NavProcess back on a machine whose vendored helper may or may not be built. Outside the
  // workspace, so no test can delete the thing it is testing with.
  previousHelper = process.env[ROSLYN_ENV]
  const standIn = join(base, 'stand-in-for-roslyn-nav')
  writeFileSync(standIn, '', 'utf8')
  process.env[ROSLYN_ENV] = standIn
})

afterEach(async () => {
  // Drops the module-level singleton this file created, so no other suite inherits it.
  await stopNavProcess()
  if (previousHelper === undefined) delete process.env[ROSLYN_ENV]
  else process.env[ROSLYN_ENV] = previousHelper
  rmSync(base, { recursive: true, force: true })
})

describe('the C# index after a delete', () => {
  test('deleting a .cs file is remembered, so the next question re-reads it — and finds it gone', async () => {
    writeFileSync(join(root, 'Legacy.cs'), 'class Legacy {}\n', 'utf8')
    // Pretend a load succeeded, the way one does.
    ;(navProcess() as unknown as { loadedRoot: string | null }).loadedRoot = root

    const r = await deleteFileTool.execute({ path: 'Legacy.cs' }, { workspace: ws })
    expect(r.ok).toBe(true)
    // Not dropped: a reload is 0.5–12 s, and a `sync` of one path is what the next question
    // pays instead. The path is the ABSOLUTE one, because the index may be rooted at one
    // folder of a multi-folder workspace and the model's spelling is relative to all of it.
    expect(loadedRoot()).toBe(root)
    const dirty = (navProcess() as unknown as { dirty: Set<string> }).dirty
    expect([...dirty].map((p) => p.replace(/\\/g, '/'))).toEqual([join(root, 'Legacy.cs').replace(/\\/g, '/')])
  })

  test('a recursive directory delete drops it too, whatever the directory was called', async () => {
    // The extension is all `noteWorkspaceWrite` looks at, and a directory has none — yet this
    // is the delete that can take every .cs file in a subtree with it, and afterwards there is
    // nothing left to inspect to find out whether it did.
    mkdirSync(join(root, 'Legacy'))
    writeFileSync(join(root, 'Legacy', 'Thing.cs'), 'class Thing {}\n', 'utf8')
    ;(navProcess() as unknown as { loadedRoot: string | null }).loadedRoot = root

    const r = await deleteFileTool.execute({ path: 'Legacy', recursive: true }, { workspace: ws })
    expect(r.ok).toBe(true)
    expect(loadedRoot()).toBeNull()
  })

  test('deleting a README does not cost a reload', async () => {
    // 0.5-12 s depending on the project. Paying it because a markdown file went away would be
    // a tax on every session that merely happens to contain C# as well.
    writeFileSync(join(root, 'README.md'), '# notes\n', 'utf8')
    ;(navProcess() as unknown as { loadedRoot: string | null }).loadedRoot = root

    const r = await deleteFileTool.execute({ path: 'README.md' }, { workspace: ws })
    expect(r.ok).toBe(true)
    expect(loadedRoot()).toBe(root)
  })

  test('a delete that failed leaves the index alone', async () => {
    ;(navProcess() as unknown as { loadedRoot: string | null }).loadedRoot = root

    const r = await deleteFileTool.execute({ path: 'Gone.cs' }, { workspace: ws })
    expect(r.ok).toBe(false)
    expect(loadedRoot()).toBe(root)
  })
})
