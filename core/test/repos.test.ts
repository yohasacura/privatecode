import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { Mount } from '../src/mounts.js'
import { discoverRepos, toRepoPaths } from '../src/host/repos.js'
import { Workspace } from '../src/workspace.js'

/**
 * Five folders, and git in a different state under each.
 *
 * This is the case that makes multi-folder workspaces real rather than a demo: one folder is
 * a repository, one is not under version control at all, one is a subdirectory of a bigger
 * repository, one has repositories inside it, and two turn out to be the same repository seen
 * twice. Every one of those has a different right answer, and assuming any of them is how a
 * panel ends up offering to commit forty files nobody looked at.
 */

let base: string

function git(cwd: string, args: string): void {
  execSync(`git -c user.email=t@t -c user.name=t ${args}`, { cwd, stdio: 'ignore' })
}

function repoAt(path: string, file = 'seed.txt'): string {
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, file), 'seed\n', 'utf8')
  git(path, 'init -q .')
  git(path, 'add -A')
  git(path, 'commit -qm init')
  return path
}

function dir(...parts: string[]): string {
  const path = join(base, ...parts)
  mkdirSync(path, { recursive: true })
  return path
}

function mount(name: string, root: string, access: 'write' | 'read' = 'write', primary = false): Mount {
  return { name, root, access, primary }
}

beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'pc-repos-')) })
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

describe('what git is under each folder', () => {
  test('a folder that is a repository, and one that is not', async () => {
    const app = repoAt(join(base, 'app'))
    const notes = dir('notes')
    const found = await discoverRepos(new Workspace([
      mount('app', app, 'write', true), mount('notes', notes),
    ]))
    expect(found.repos).toHaveLength(1)
    expect(found.repos[0]).toMatchObject({ relation: 'folder', label: 'app' })
    // Not an error, and not silence: a folder with no repository still gets checkpoints, and
    // an empty panel with no explanation reads as broken.
    expect(found.unversioned).toEqual([{ mount: 'notes' }])
  })

  /** A committed monorepo with two packages, then one edit in each and one at the top. */
  function monorepo(): string {
    const root = join(base, 'monorepo')
    mkdirSync(join(root, 'packages', 'api'), { recursive: true })
    mkdirSync(join(root, 'packages', 'web'), { recursive: true })
    writeFileSync(join(root, 'packages', 'api', 'a.ts'), 'a\n', 'utf8')
    writeFileSync(join(root, 'packages', 'web', 'w.ts'), 'w\n', 'utf8')
    writeFileSync(join(root, 'root-level.txt'), 'r\n', 'utf8')
    git(root, 'init -q .')
    git(root, 'add -A')
    git(root, 'commit -qm init')
    writeFileSync(join(root, 'packages', 'api', 'a.ts'), 'a changed\n', 'utf8')
    writeFileSync(join(root, 'packages', 'web', 'w.ts'), 'w changed\n', 'utf8')
    writeFileSync(join(root, 'root-level.txt'), 'r changed\n', 'utf8')
    return root
  }

  test('a folder that is a subdirectory of a bigger repository shows only its own subtree', async () => {
    const root = monorepo()
    const found = await discoverRepos(new Workspace([
      mount('api', join(root, 'packages', 'api'), 'write', true),
    ]))
    expect(found.repos).toHaveLength(1)
    expect(found.repos[0]?.relation).toBe('above')
    expect(found.repos[0]?.label).toContain('part of monorepo')
    // The changes outside the mounted package are not this workspace's business, and offering
    // them for commit would be offering work nobody here has looked at.
    expect(found.repos[0]?.files.map((f) => f.path)).toEqual(['a.ts'])
  })

  test('two folders that are one repository appear once, with both scopes', async () => {
    const root = monorepo()
    const found = await discoverRepos(new Workspace([
      mount('api', join(root, 'packages', 'api'), 'write', true),
      mount('web', join(root, 'packages', 'web')),
    ]))
    // Two sections would let a commit from one quietly stage the other's files.
    expect(found.repos).toHaveLength(1)
    expect(found.repos[0]?.scopes.map((s) => s.mount)).toEqual(['api', 'web'])
    expect(found.repos[0]?.files.map((f) => f.path).sort()).toEqual(['api/a.ts', 'web/w.ts'])
    // Still not the file at the repository root: it is in neither folder.
    expect(found.repos[0]?.files.map((f) => f.path)).not.toContain('root-level.txt')
  })

  test('a folder with repositories inside it lists each of them', async () => {
    const work = dir('work')
    repoAt(join(work, 'one'))
    repoAt(join(work, 'two'))
    writeFileSync(join(work, 'one', 'seed.txt'), 'changed\n', 'utf8')

    const found = await discoverRepos(new Workspace([mount('work', work, 'write', true)]))
    expect(found.repos.map((r) => r.relation)).toEqual(['nested', 'nested'])
    expect(found.unversioned).toEqual([{ mount: 'work' }])
    const one = found.repos.find((r) => r.root.endsWith('one'))
    // Unprefixed: this workspace has one folder, so paths are addressed as they always were.
    expect(one?.files.map((f) => f.path)).toEqual(['one/seed.txt'])
  })

  test('a repository nested inside a repository is its own section, not one changed file', async () => {
    const app = repoAt(join(base, 'app'))
    repoAt(join(app, 'vendored'))
    writeFileSync(join(app, 'vendored', 'seed.txt'), 'changed\n', 'utf8')

    const found = await discoverRepos(new Workspace([mount('app', app, 'write', true)]))
    expect(found.repos).toHaveLength(2)
    const outer = found.repos.find((r) => r.relation === 'folder')
    // Git reports the nested repository to its parent as one modified gitlink entry, which
    // reads as "one changed file" for what is a whole separate project.
    expect(outer?.files).toEqual([])
    const inner = found.repos.find((r) => r.relation === 'nested')
    expect(inner?.files.map((f) => f.path)).toEqual(['vendored/seed.txt'])
  })

  test('a read-only folder has no section at all', async () => {
    const app = repoAt(join(base, 'app'))
    const refs = repoAt(join(base, 'refs'))
    writeFileSync(join(refs, 'seed.txt'), 'changed\n', 'utf8')
    const found = await discoverRepos(new Workspace([
      mount('app', app, 'write', true), mount('refs', refs, 'read'),
    ]))
    expect(found.repos).toHaveLength(1)
    expect(found.repos[0]?.scopes[0]?.mount).toBe('app')
  })
})

describe('committing into the right repository', () => {
  test('workspace paths become repository paths', () => {
    const app = dir('app')
    const engine = dir('engine')
    const ws = new Workspace([mount('app', app, 'write', true), mount('engine', engine)])
    expect(toRepoPaths(ws, engine, ['engine/src/lib.rs'])).toEqual({ ok: true, paths: ['src/lib.rs'] })
  })

  test('a selection that leaves the repository is refused, not silently dropped', () => {
    // Dropping one of the files someone selected produces a commit that does not contain
    // what its author believes it contains.
    const app = dir('app')
    const engine = dir('engine')
    const ws = new Workspace([mount('app', app, 'write', true), mount('engine', engine)])
    const result = toRepoPaths(ws, engine, ['engine/src/lib.rs', 'app/main.ts'])
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.problem).toContain('not in this repository')
  })
})

describe('one directory, two names', () => {
  // Windows opens a directory under more than one name at a time -- an 8.3 alias, a
  // junction, a differing case -- and the panel's two halves get their names from different
  // places: the mount root is however the folder was ATTACHED, while `git rev-parse
  // --show-toplevel` answers with the name the filesystem reports, whichever one it was
  // asked under. Compared as strings, those two said "different directory", `path.relative`
  // returned a `..\..\`-laden path, every changed file was filtered out as "outside the
  // workspace", and the Changes panel was empty. No error anywhere -- it simply showed
  // nothing, which looks exactly like a clean tree.
  //
  // Twelve tests failed this way on a GitHub runner and passed on the machine they were
  // written on, whose username is short enough to have no 8.3 alias at all. So this uses a
  // JUNCTION rather than a short name: it produces the same two-spellings situation on any
  // Windows machine, including one with 8.3 generation switched off, instead of only where
  // the paths happen to be long.
  const junctionsWork = process.platform === 'win32'

  test.runIf(junctionsWork)('a folder opened through a junction still shows its changes', () => {
    const real = repoAt(dir('actual-project'))
    writeFileSync(join(real, 'seed.txt'), 'edited\n', 'utf8')
    const link = join(base, 'through-link')
    symlinkSync(real, link, 'junction')

    return discoverRepos(new Workspace(link)).then((found) => {
      expect(found.repos).toHaveLength(1)
      // `folder`, not `above`: the junction IS the repository, and calling it "part of
      // something bigger" is the first visible symptom of the comparison having failed.
      expect(found.repos[0]?.relation).toBe('folder')
      expect(found.repos[0]?.files.map((f) => f.path)).toEqual(['seed.txt'])
    })
  })

  test.runIf(junctionsWork)('and its files can still be staged by the name the panel shows', () => {
    const real = repoAt(dir('stageable'))
    writeFileSync(join(real, 'seed.txt'), 'edited\n', 'utf8')
    const link = join(base, 'stage-link')
    symlinkSync(real, link, 'junction')
    const ws = new Workspace(link)

    return discoverRepos(ws).then((found) => {
      const repo = found.repos[0]
      expect(repo).toBeDefined()
      // The round trip is the point: the panel shows `seed.txt`, and staging it has to reach
      // git as `seed.txt` in THIS repository rather than as "not in this repository".
      expect(toRepoPaths(ws, repo!.root, ['seed.txt'])).toEqual({ ok: true, paths: ['seed.txt'] })
    })
  })
})
