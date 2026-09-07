import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { absoluteOf, buildSkeleton, definedNames, importSpecs, isLinkableName, isTestPath, modulesOf, parseCommitLog, referenceEdges, resolveImport } from '../src/map/skeleton.js'
import type { FileOutline } from '../src/outline/repo-map.js'

/**
 * The map's skeleton is the part nobody writes: it must be exactly what the parsers and
 * git say. These pin the graph rules (what counts as a defining name, what is vocabulary,
 * which file is a test of which) and the reading of git's log.
 */

const outline = (path: string, names: string[], mentions: string[]): FileOutline => ({
  path,
  entries: names.map((name, i) => ({ kind: 'function', name, line: i + 1, depth: 0 })),
  identifiers: new Set([...names, ...mentions]),
})

describe('the reference graph', () => {
  test('a file that mentions a name another defines depends on it; short and common names do not count', () => {
    const files = [
      outline('src/orders.ts', ['placeOrder', 'run'], ['formatMoney']),
      outline('src/money.ts', ['formatMoney'], []),
      outline('src/cli.ts', [], ['placeOrder', 'run']),
    ]
    expect(definedNames(files[0]!.entries)).toEqual(['placeOrder'])
    const edges = referenceEdges(files)
    expect([...edges.get('src/orders.ts')!.keys()]).toEqual(['src/money.ts'])
    expect([...edges.get('src/cli.ts')!.keys()]).toEqual(['src/orders.ts'])
    expect(edges.get('src/money.ts')!.size).toBe(0)
  })

  test('a name defined in many files is vocabulary and links nothing', () => {
    const files = Array.from({ length: 30 }, (_, i) => outline(`f${i}.ts`, ['execute'], ['execute']))
    const edges = referenceEdges(files)
    for (const row of edges.values()) expect(row.size).toBe(0)
  })
})

describe('modules', () => {
  test('every directory on the way to a file is a module, with its files and children', () => {
    const modules = modulesOf(['a/b/c.ts', 'a/d.ts', 'e.ts'])
    expect(modules.map((m) => m.path)).toEqual(['', 'a', 'a/b'])
    expect(modules.find((m) => m.path === '')).toEqual({ path: '', files: ['e.ts'], children: ['a'] })
    expect(modules.find((m) => m.path === 'a')).toEqual({ path: 'a', files: ['a/d.ts'], children: ['a/b'] })
  })

  test('tests are told by their path', () => {
    expect(isTestPath('core/test/x.test.ts')).toBe(true)
    expect(isTestPath('src/a.spec.js')).toBe(true)
    expect(isTestPath('src/a.ts')).toBe(false)
  })
})

describe("git's log", () => {
  test('is read record by record: a subject, then the files', () => {
    const text = '\x1eadd orders\n\nsrc/orders.ts\nsrc/money.ts\n\x1efix cli\n\nsrc/cli.ts\n'
    expect(parseCommitLog(text)).toEqual([
      { subject: 'add orders', files: ['src/orders.ts', 'src/money.ts'] },
      { subject: 'fix cli', files: ['src/cli.ts'] },
    ])
  })
})

describe('a real repository', () => {
  let root: string
  const git = (args: string): void => { execSync(`git -c user.email=t@t -c user.name=t ${args}`, { cwd: root, stdio: 'ignore' }) }
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pc-map-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'test'), { recursive: true })
    writeFileSync(join(root, 'src', 'money.ts'), 'export function formatMoney(cents: number): string { return String(cents) }\n')
    writeFileSync(join(root, 'src', 'orders.ts'), 'import { formatMoney } from "./money"\nexport function placeOrder(total: number): string { return formatMoney(total) }\n')
    writeFileSync(join(root, 'test', 'orders.test.ts'), 'import { placeOrder } from "../src/orders"\ntest("places", () => { placeOrder(1) })\n')
    git('init -q --initial-branch=main .')
    git('add -A')
    git('commit -qm "orders and money together"')
    writeFileSync(join(root, 'src', 'orders.ts'), 'import { formatMoney } from "./money"\nexport function placeOrder(total: number): string { return formatMoney(total * 2) }\n')
    git('commit -qam "orders: double it"')
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  test('carries symbols, references, tests, co-changes and the commit subjects', async () => {
    const skeleton = await buildSkeleton(root)
    const orders = skeleton.files.find((f) => f.path === 'src/orders.ts')!
    expect(orders.symbols.map((s) => s.name)).toContain('placeOrder')
    expect(orders.uses).toEqual(['src/money.ts'])
    expect(orders.tests).toEqual(['test/orders.test.ts'])
    expect(orders.history).toEqual(['orders: double it', 'orders and money together'])
    expect(orders.coChanges).toEqual([{ path: 'src/money.ts', count: 1 }, { path: 'test/orders.test.ts', count: 1 }])
    const money = skeleton.files.find((f) => f.path === 'src/money.ts')!
    expect(money.usedBy).toEqual(['src/orders.ts'])
    expect(skeleton.commits).toBe(2)
    expect(skeleton.modules.map((m) => m.path)).toEqual(['', 'src', 'test'])
    expect(orders.hash).toMatch(/^[0-9a-f]{40}$/)
  })
})

describe('a workspace of several folders', () => {
  let base: string
  const git = (cwd: string, args: string): void => { execSync(`git -c user.email=t@t -c user.name=t ${args}`, { cwd, stdio: 'ignore' }) }
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'pc-map-multi-'))
    mkdirSync(join(base, 'lib', 'src'), { recursive: true })
    mkdirSync(join(base, 'api', 'src'), { recursive: true })
    mkdirSync(join(base, 'notes'), { recursive: true })
    writeFileSync(join(base, 'lib', 'src', 'money.ts'), 'export function formatMoney(cents: number): string { return String(cents) }\n')
    writeFileSync(join(base, 'api', 'src', 'orders.ts'), 'import { formatMoney } from "lib"\nexport function placeOrder(total: number): string { return formatMoney(total) }\n')
    writeFileSync(join(base, 'notes', 'todo.ts'), 'export function unrelatedThing(): number { return 1 }\n')
    for (const name of ['lib', 'api']) {
      git(join(base, name), 'init -q --initial-branch=main .')
      git(join(base, name), 'add -A')
      git(join(base, name), `commit -qm "${name}: first"`)
    }
  })
  afterEach(() => { rmSync(base, { recursive: true, force: true }) })

  test('paths carry the folder name, folders are the top modules, references cross folders, git is read per folder', async () => {
    const skeleton = await buildSkeleton([
      { name: 'api', root: join(base, 'api') }, { name: 'lib', root: join(base, 'lib') }, { name: 'notes', root: join(base, 'notes') },
    ])
    expect(skeleton.mounts.map((m) => m.name)).toEqual(['api', 'lib', 'notes'])
    expect(skeleton.files.map((f) => f.path)).toEqual(['api/src/orders.ts', 'lib/src/money.ts', 'notes/todo.ts'])
    expect(skeleton.modules.find((m) => m.path === '')?.children).toEqual(['api', 'lib', 'notes'])
    const orders = skeleton.files.find((f) => f.path === 'api/src/orders.ts')!
    expect(orders.uses).toEqual(['lib/src/money.ts'])
    expect(orders.history).toEqual(['api: first'])
    expect(skeleton.files.find((f) => f.path === 'lib/src/money.ts')?.usedBy).toEqual(['api/src/orders.ts'])
    // The folder outside git has no history and no co-changes, and is still on the map.
    const todo = skeleton.files.find((f) => f.path === 'notes/todo.ts')!
    expect(todo.history).toEqual([])
    expect(todo.uses).toEqual([])
    expect(skeleton.commits).toBe(2)
    expect(absoluteOf(skeleton, 'api/src/orders.ts')).toBe(join(base, 'api', 'src', 'orders.ts'))
    expect(absoluteOf(skeleton, 'nowhere/x.ts')).toBeNull()
  })
})

describe('imports and names', () => {
  test('a relative import that lands on a known file is an edge by itself; a bare one is not', () => {
    const files = [
      { ...outline('src/orders.ts', ['placeOrder'], []), imports: ['./money', 'node:fs', './nowhere'] },
      outline('src/money.ts', ['formatMoney'], []),
    ]
    const edges = referenceEdges(files)
    expect([...edges.get('src/orders.ts')!.entries()]).toEqual([['src/money.ts', 3]])
  })

  test('a specifier resolves the way the module systems do', () => {
    const known = new Set(['src/money.ts', 'src/ui/index.tsx', 'src/x.ts', 'lib/src/money.ts', 'pkg/mod.py', 'pkg/sub/__init__.py', 'pkg/main.py'])
    expect(resolveImport('src/orders.ts', './money', known)).toBe('src/money.ts')
    expect(resolveImport('src/orders.ts', './money.js', known)).toBe('src/money.ts')
    expect(resolveImport('src/orders.ts', './ui', known)).toBe('src/ui/index.tsx')
    expect(resolveImport('src/orders.ts', './x.js', known)).toBe('src/x.ts')
    expect(resolveImport('api/src/orders.ts', '../../lib/src/money', known)).toBe('lib/src/money.ts')
    expect(resolveImport('src/orders.ts', './gone', known)).toBeNull()
    expect(resolveImport('pkg/main.py', '.mod', known)).toBe('pkg/mod.py')
    expect(resolveImport('pkg/main.py', '.sub', known)).toBe('pkg/sub/__init__.py')
    expect(resolveImport('pkg/sub/a.py', '..mod', known)).toBe('pkg/mod.py')
  })

  test('specifiers are read from the three import forms, and from Python relative imports', () => {
    expect(importSpecs("import { a } from './a'\nconst b = require('../b.cjs')\nconst c = await import('./c/index.js')\nimport fs from 'node:fs'\n", 'ts')).toEqual(['./a', '../b.cjs', './c/index.js'])
    expect(importSpecs('from .mod import x\nfrom ..pkg.sub import y\nimport os\n', 'py')).toEqual(['.mod', '..pkg.sub'])
  })

  test('a linkable name has two words in it, or is a long capitalised one', () => {
    for (const yes of ['walkFiles', 'MAX_FILES', 'sha256', 'Workspace', 'OutlineEntry', 'read_history']) expect(isLinkableName(yes), yes).toBe(true)
    for (const no of ['parse', 'entries', 'target', 'person', 'Order', 'run', 'execute', '_private']) expect(isLinkableName(no), no).toBe(false)
  })
})
