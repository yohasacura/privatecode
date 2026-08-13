import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { CheckpointSet } from '../src/checkpoints/set.js'
import { discoverUnits, findNestedRepos } from '../src/checkpoints/units.js'
import type { Mount } from '../src/mounts.js'

/**
 * The undo, once a workspace is more than one tree.
 *
 * The test this file exists for is "a nested repository comes back". Before snapshot units,
 * it did not: `git add -A` records a directory containing `.git` as a gitlink — a pointer to
 * a commit — so a rewind restored the pointer and not one file inside it, silently. The
 * guard-against-the-guard below reproduces exactly that, so the fix cannot quietly stop
 * being a fix.
 */

let base: string

function git(cwd: string, args: string): void {
  execSync(`git -c user.email=t@t -c user.name=t ${args}`, { cwd, stdio: 'ignore' })
}

function repo(path: string, file: string, content: string): void {
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, file), content, 'utf8')
  git(path, 'init -q .')
  git(path, 'add -A')
  git(path, 'commit -qm init')
}

beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'pc-units-')) })
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

describe('finding what has to be snapshotted separately', () => {
  test('a repository nested inside a folder is found', async () => {
    const root = join(base, 'app')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'a.ts'), 'x', 'utf8')
    repo(join(root, 'vendor-lib'), 'lib.ts', 'y')
    expect(await findNestedRepos(root)).toEqual([join(root, 'vendor-lib')])
  })

  test('a repository inside node_modules is a dependency, not the user\'s work', async () => {
    const root = join(base, 'app')
    mkdirSync(root, { recursive: true })
    repo(join(root, 'node_modules', 'dep'), 'index.js', 'z')
    expect(await findNestedRepos(root)).toEqual([])
  })

  test('the folder itself being a repository does not make it nested', async () => {
    const root = join(base, 'app')
    repo(root, 'a.ts', 'x')
    expect(await findNestedRepos(root)).toEqual([])
  })
})

describe('the units a workspace needs', () => {
  test('one per writable folder, one per nested repository, none for read-only', async () => {
    const app = join(base, 'app')
    mkdirSync(app, { recursive: true })
    repo(join(app, 'inner'), 'i.ts', 'i')
    const engine = join(base, 'engine')
    mkdirSync(engine, { recursive: true })
    const refs = join(base, 'refs')
    mkdirSync(refs, { recursive: true })

    const mounts: Mount[] = [
      { name: 'app', root: app, access: 'write', primary: true },
      { name: 'engine', root: engine, access: 'write', primary: false },
      { name: 'refs', root: refs, access: 'read', primary: false },
    ]
    const units = await discoverUnits(mounts, app)
    expect(units.map((u) => u.label)).toEqual(['app', 'app/inner', 'engine'])
    // Nothing is ever written to a read-only folder, so there is nothing to undo there.
    expect(units.some((u) => u.label === 'refs')).toBe(false)
    // The outer unit must not swallow the inner one.
    expect(units[0]?.excluded).toEqual(['/inner/'])
    expect(units[1]?.excluded).toEqual([])
  })

  test('the primary folder keeps the store it already had, and attached folders stay clean', async () => {
    const app = join(base, 'app')
    const engine = join(base, 'engine')
    mkdirSync(app, { recursive: true })
    mkdirSync(engine, { recursive: true })
    const units = await discoverUnits([
      { name: 'app', root: app, access: 'write', primary: true },
      { name: 'engine', root: engine, access: 'write', primary: false },
    ], app)
    expect(units[0]?.gitDir).toBe(join(app, '.privatecode', 'state', 'checkpoints.git'))
    // Under the PRIMARY folder, not under the attached one: pointing the agent at someone
    // else's project is not permission to leave our files in it.
    expect(units[1]?.gitDir.startsWith(join(app, '.privatecode'))).toBe(true)
    expect(existsSync(join(engine, '.privatecode'))).toBe(false)
  })
})

describe('rewinding across units', () => {
  test('a file inside a nested repository comes back', async () => {
    const app = join(base, 'app')
    mkdirSync(app, { recursive: true })
    writeFileSync(join(app, 'top.txt'), 'top v1', 'utf8')
    repo(join(app, 'inner'), 'in.txt', 'inner v1')

    const units = await discoverUnits(
      [{ name: 'app', root: app, access: 'write', primary: true }], app,
    )
    expect(units).toHaveLength(2)
    const checkpoints = new CheckpointSet(units, app)
    const baseline = await checkpoints.take({})
    expect(baseline).not.toBeNull()

    writeFileSync(join(app, 'top.txt'), 'top CHANGED', 'utf8')
    writeFileSync(join(app, 'inner', 'in.txt'), 'inner CHANGED', 'utf8')
    await checkpoints.rewind(baseline!.id)

    expect(readFileSync(join(app, 'top.txt'), 'utf8')).toBe('top v1')
    // The whole point. This line failed before snapshot units existed.
    expect(readFileSync(join(app, 'inner', 'in.txt'), 'utf8')).toBe('inner v1')
    // And the user's own repository is untouched by any of it.
    expect(existsSync(join(app, 'inner', '.git'))).toBe(true)
  })

  test('guard against the guard: one store over the whole tree does NOT bring it back', async () => {
    // Reproduces the defect exactly, so the fix above cannot silently stop being one. If this
    // test ever starts passing the nested file back, git changed and the exclusion machinery
    // may no longer be needed — but until then, this is why it exists.
    const app = join(base, 'app')
    mkdirSync(app, { recursive: true })
    writeFileSync(join(app, 'top.txt'), 'top v1', 'utf8')
    repo(join(app, 'inner'), 'in.txt', 'inner v1')

    const [outer] = await discoverUnits(
      [{ name: 'app', root: app, access: 'write', primary: true }], app,
    )
    const naive = new CheckpointSet([{ ...outer!, excluded: [] }], app)
    const baseline = await naive.take({})
    writeFileSync(join(app, 'top.txt'), 'top CHANGED', 'utf8')
    writeFileSync(join(app, 'inner', 'in.txt'), 'inner CHANGED', 'utf8')
    await naive.rewind(baseline!.id)

    expect(readFileSync(join(app, 'top.txt'), 'utf8')).toBe('top v1')
    expect(readFileSync(join(app, 'inner', 'in.txt'), 'utf8')).toBe('inner CHANGED')
  })

  test('two folders on different paths both rewind from one checkpoint', async () => {
    const app = join(base, 'app')
    const engine = join(base, 'engine')
    mkdirSync(app, { recursive: true })
    mkdirSync(engine, { recursive: true })
    writeFileSync(join(app, 'a.txt'), 'a v1', 'utf8')
    writeFileSync(join(engine, 'e.txt'), 'e v1', 'utf8')

    const units = await discoverUnits([
      { name: 'app', root: app, access: 'write', primary: true },
      { name: 'engine', root: engine, access: 'write', primary: false },
    ], app)
    const checkpoints = new CheckpointSet(units, app)
    const baseline = await checkpoints.take({})

    writeFileSync(join(app, 'a.txt'), 'a CHANGED', 'utf8')
    writeFileSync(join(engine, 'e.txt'), 'e CHANGED', 'utf8')
    writeFileSync(join(engine, 'new.txt'), 'created since', 'utf8')
    await checkpoints.rewind(baseline!.id)

    expect(readFileSync(join(app, 'a.txt'), 'utf8')).toBe('a v1')
    expect(readFileSync(join(engine, 'e.txt'), 'utf8')).toBe('e v1')
    expect(existsSync(join(engine, 'new.txt'))).toBe(false)
  })

  test('a rewind is still undoable, across every folder', async () => {
    const app = join(base, 'app')
    const engine = join(base, 'engine')
    mkdirSync(app, { recursive: true })
    mkdirSync(engine, { recursive: true })
    writeFileSync(join(app, 'a.txt'), 'a v1', 'utf8')
    writeFileSync(join(engine, 'e.txt'), 'e v1', 'utf8')
    const units = await discoverUnits([
      { name: 'app', root: app, access: 'write', primary: true },
      { name: 'engine', root: engine, access: 'write', primary: false },
    ], app)
    const checkpoints = new CheckpointSet(units, app)
    const baseline = await checkpoints.take({})

    writeFileSync(join(app, 'a.txt'), 'a v2', 'utf8')
    writeFileSync(join(engine, 'e.txt'), 'e v2', 'utf8')
    const { undo } = await checkpoints.rewind(baseline!.id)
    expect(readFileSync(join(app, 'a.txt'), 'utf8')).toBe('a v1')

    // Rewinding to the wrong point is the real risk; going forward again is the answer.
    await checkpoints.rewind(undo.id)
    expect(readFileSync(join(app, 'a.txt'), 'utf8')).toBe('a v2')
    expect(readFileSync(join(engine, 'e.txt'), 'utf8')).toBe('e v2')
  })
})

describe('putting one file back', () => {
  test('it goes to the folder that actually holds it', async () => {
    const app = join(base, 'app')
    const engine = join(base, 'engine')
    mkdirSync(app, { recursive: true })
    mkdirSync(engine, { recursive: true })
    writeFileSync(join(app, 'a.txt'), 'a v1', 'utf8')
    writeFileSync(join(engine, 'e.txt'), 'e v1', 'utf8')
    const units = await discoverUnits([
      { name: 'app', root: app, access: 'write', primary: true },
      { name: 'engine', root: engine, access: 'write', primary: false },
    ], app)
    const checkpoints = new CheckpointSet(units, app)
    const baseline = await checkpoints.take({})

    writeFileSync(join(app, 'a.txt'), 'a CHANGED', 'utf8')
    writeFileSync(join(engine, 'e.txt'), 'e CHANGED', 'utf8')
    await checkpoints.restoreFile(baseline!.id, join(engine, 'e.txt'))

    expect(readFileSync(join(engine, 'e.txt'), 'utf8')).toBe('e v1')
    // Only that one file: the other folder's edit is left exactly alone.
    expect(readFileSync(join(app, 'a.txt'), 'utf8')).toBe('a CHANGED')
  })
})

describe('a failing checkpoint store can be heard', () => {
  test('collects the store\'s problems on the single-unit path too', async () => {
    // The path almost every workspace takes short-circuited straight to the one store and
    // skipped `collectProblems`, so `CheckpointSet.problems` was permanently empty for a
    // single-folder workspace — and `CheckpointStore` reports failures by pushing onto
    // `problems` and returning null, never by throwing. The loudest case is not a mid-run
    // disk failure: it is the first launch on a machine with no git on PATH, where every
    // checkpoint quietly does nothing and History says "No checkpoints yet" forever.
    const root = mkdtempSync(join(tmpdir(), 'pc-cpfail-'))
    try {
      const set = new CheckpointSet([{
        id: 'primary',
        label: 'primary',
        root,
        gitDir: join(root, '.privatecode', 'state', 'checkpoints.git'),
        stateRoot: root,
        excluded: [],
      }], root)
      // A file where the state directory has to go, so the store cannot create its shadow
      // repository. Whatever the exact message, the contract under test is that the failure
      // REACHES here instead of being stranded on the store.
      writeFileSync(join(root, '.privatecode'), 'not a directory', 'utf8')
      await set.take({ sessionId: 's1', turn: 1 })
      expect(set.problems.length).toBeGreaterThan(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
