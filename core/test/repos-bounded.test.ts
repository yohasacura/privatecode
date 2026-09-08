import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { discoverRepos, hotspotsOf } from '../src/host/repos.js'
import { Workspace } from '../src/workspace.js'

/**
 * A real working tree's worst habits, and what the status answers with: a flood of
 * untracked files is counted and located rather than listed; the tracked changes come
 * first; a clone found under it is still its own repository; many clones are read
 * together.
 */

let root: string
const git = (cwd: string, args: string): void => { execSync(`git -c user.email=t@t -c user.name=t ${args}`, { cwd, stdio: 'ignore' }) }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-bounded-'))
  git(root, 'init -q --initial-branch=main .')
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'a.cs'), 'class A {}\n')
  writeFileSync(join(root, 'src', 'b.cs'), 'class B {}\n')
  git(root, 'add -A')
  git(root, 'commit -qm seed')
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('a flood of untracked files', () => {
  test('is listed up to the bound, tracked changes first, and located for the person', async () => {
    writeFileSync(join(root, 'src', 'a.cs'), 'class A { int x; }\n') // a real change
    for (const dir of ['src/App/obj/Debug', 'src/App/bin/Debug', 'gen']) mkdirSync(join(root, dir), { recursive: true })
    for (let i = 0; i < 1500; i++) writeFileSync(join(root, 'src', 'App', 'obj', 'Debug', `o${i}.tmp`), 'x')
    for (let i = 0; i < 700; i++) writeFileSync(join(root, 'src', 'App', 'bin', 'Debug', `b${i}.dll`), 'x')
    for (let i = 0; i < 300; i++) writeFileSync(join(root, 'gen', `g${i}.cs`), 'x')

    const found = await discoverRepos(new Workspace(root))
    const repo = found.repos[0]!
    expect(repo.problem).toBeUndefined()
    expect(repo.files.length).toBe(2000)
    expect(repo.omitted).toBe(2501 - 2000)
    // The modified file is first in the list, not somewhere among the flood.
    expect(repo.files[0]).toMatchObject({ path: 'src/a.cs', untracked: false })
    // The flood is named by where it lives, with the ignore line that ends it.
    expect(repo.hotspots).toEqual([
      { dir: 'src/App/obj', count: 1500, pattern: 'obj/', junk: true },
      { dir: 'src/App/bin', count: 700, pattern: 'bin/', junk: true },
      { dir: 'gen', count: 300, pattern: '/gen/', junk: false },
    ])
  }, 60_000)

  test('a small working tree carries neither a count nor hotspots', async () => {
    writeFileSync(join(root, 'src', 'c.cs'), 'class C {}\n')
    const repo = (await discoverRepos(new Workspace(root))).repos[0]!
    expect(repo.omitted).toBeUndefined()
    expect(repo.hotspots).toBeUndefined()
    expect(repo.files.map((f) => f.path)).toEqual(['src/c.cs'])
  })
})

describe('hotspots', () => {
  test('group at the first well-known junk directory, else at the top level, and rank by count', () => {
    expect(hotspotsOf([
      'src/App/obj/Debug/a.tmp', 'src/App/obj/Debug/b.tmp', 'src/App/obj/x.tmp',
      'node_modules/pkg/index.js', 'node_modules/pkg/lib/x.js',
      'docs/a.md', 'docs/b.md', 'docs/c.md', 'docs/d.md',
      'README.tmp',
    ])).toEqual([])
    // Below fifty files nothing is a flood; above it, a sliver beside the flood is left out.
    const flood = [
      ...Array.from({ length: 30_000 }, (_, i) => `node_modules/pkg/${i}.js`),
      ...Array.from({ length: 80 }, (_, i) => `src/mod/new${i}.cs`),
      ...Array.from({ length: 2_000 }, (_, i) => `docs/gen/${i}.md`),
    ]
    expect(hotspotsOf(flood)).toEqual([
      { dir: 'node_modules', count: 30_000, pattern: 'node_modules/', junk: true },
      { dir: 'docs', count: 2_000, pattern: '/docs/', junk: false },
    ])
    expect(hotspotsOf(['lone.txt'])).toEqual([])
  })
})

describe('many repositories', () => {
  test('are read together, and a clone under the primary is its own section', async () => {
    for (let i = 0; i < 9; i++) {
      const clone = join(root, 'libs', `lib${i}`)
      mkdirSync(clone, { recursive: true })
      git(clone, 'init -q --initial-branch=main .')
      writeFileSync(join(clone, 'lib.ts'), `export const n = ${i}\n`)
      git(clone, 'add -A')
      git(clone, 'commit -qm lib')
      writeFileSync(join(clone, 'lib.ts'), `export const n = ${i + 1}\n`)
    }
    const found = await discoverRepos(new Workspace(root))
    expect(found.repos.length).toBe(10)
    const nested = found.repos.filter((r) => r.relation === 'nested')
    expect(nested.length).toBe(9)
    for (const r of nested) expect(r.files.map((f) => f.code)).toEqual([' M'])
    // The primary does not list the clones' files as its own untracked directories.
    expect(found.repos[0]!.files.filter((f) => f.path.startsWith('libs/'))).toEqual([])
  }, 60_000)
})
