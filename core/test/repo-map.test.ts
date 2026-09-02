import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  buildRepoMap, indexRepo, indexWorkspace, rankByReferences, renderFile, renderIndex, renderRepoMap,
  summariseLayout, type FileOutline,
} from '../src/outline/repo-map.js'

/**
 * The map the model reads before it asks anything.
 *
 * Two things are worth testing here and they pull in opposite directions: that the ranking
 * puts the load-bearing files first (a map is only worth its tokens if the right things fit
 * in the budget), and that the rendering never overstates what it knows.
 */

let root: string

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pc-map-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function write(rel: string, body: string): void {
  mkdirSync(join(root, rel, '..'), { recursive: true })
  writeFileSync(join(root, rel), body, 'utf8')
}

/** A hand-built outline, for the pure functions -- no tree-sitter, no filesystem. */
function outline(path: string, entries: [string, string, number][], ids: string[] = []): FileOutline {
  return {
    path,
    entries: entries.map(([kind, name, depth]) => ({ kind, name, depth, line: 1 })),
    identifiers: new Set(ids),
  }
}

describe('indexing a workspace', () => {
  test('parses supported sources and finds their definitions', async () => {
    write('src/store.ts', 'export class Store {\n  save() {}\n  load() {}\n}\n')
    write('src/util.ts', 'export function slug(s: string) { return s }\n')

    const files = await indexWorkspace(root)
    const paths = files.map((f) => f.path).sort()
    expect(paths).toEqual(['src/store.ts', 'src/util.ts'])

    const store = files.find((f) => f.path === 'src/store.ts')!
    expect(store.entries.map((e) => e.name)).toContain('Store')
    expect(store.entries.map((e) => e.name)).toContain('save')
  })

  test('a file with no definitions is not a line in the map', async () => {
    write('src/constants.ts', 'export const A = 1\n')
    write('src/real.ts', 'export function go() {}\n')
    const files = await indexWorkspace(root)
    expect(files.map((f) => f.path)).toEqual(['src/real.ts'])
  })

  test('an unparseable or unreadable file is skipped, not fatal', async () => {
    write('src/broken.ts', 'class {{{{ not typescript at all ((((')
    write('src/fine.ts', 'export function ok() {}\n')
    const files = await indexWorkspace(root)
    expect(files.map((f) => f.path)).toContain('src/fine.ts')
  })

  test('node_modules is not the project', async () => {
    write('node_modules/dep/index.js', 'function helper() {}\n')
    write('src/mine.ts', 'export function mine() {}\n')
    const files = await indexWorkspace(root)
    expect(files.map((f) => f.path)).toEqual(['src/mine.ts'])
  })
})

describe('ranking', () => {
  test('the file everything else mentions comes first', () => {
    const core = outline('src/core.ts', [['class', 'Engine', 0]], ['Engine'])
    const lonely = outline('src/lonely.ts', [['function', 'unused', 0]], ['unused'])
    const a = outline('src/a.ts', [['function', 'a', 0]], ['a', 'Engine'])
    const b = outline('src/b.ts', [['function', 'b', 0]], ['b', 'Engine'])

    expect(rankByReferences([lonely, a, b, core])[0]?.path).toBe('src/core.ts')
  })

  test('a file that merely exports a lot does not win by volume', () => {
    // The measure this deliberately avoids: barrels and generated type files export the
    // most names and tell you the least about a project.
    const barrel = outline(
      'src/index.ts',
      [['function', 'x1', 0], ['function', 'x2', 0], ['function', 'x3', 0], ['function', 'x4', 0]],
      ['x1', 'x2', 'x3', 'x4'],
    )
    const used = outline('src/engine.ts', [['class', 'Engine', 0]], ['Engine'])
    const consumer = outline('src/app.ts', [['function', 'main', 0]], ['main', 'Engine'])

    expect(rankByReferences([barrel, used, consumer])[0]?.path).toBe('src/engine.ts')
  })

  test('the order is stable when scores tie', () => {
    const a = outline('src/b.ts', [['function', 'f', 0]], ['f'])
    const b = outline('src/a.ts', [['function', 'g', 0]], ['g'])
    expect(rankByReferences([a, b]).map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  test('a compiler-confirmed edge lifts a file the text cannot see', () => {
    // The C# reality the semantic edges exist for: a DI registration reaches Service
    // through the container, so Service's NAME never appears in the files that depend on
    // it most — textually it looks lonely.
    const service = outline('src/Service.cs', [['class', 'Service', 1]], ['Service'])
    const textual = outline('src/Popular.cs', [['class', 'Popular', 1]], ['Popular'])
    const a = outline('src/A.cs', [['class', 'A', 1]], ['A', 'Popular'])
    const b = outline('src/B.cs', [['class', 'B', 1]], ['B', 'Popular'])
    const files = [service, textual, a, b]

    expect(rankByReferences(files)[0]?.path).toBe('src/Popular.cs')

    const edges = new Map([
      ['src/A.cs', new Map([['src/Service.cs', 3]])],
      ['src/B.cs', new Map([['src/Service.cs', 3]])],
    ])
    expect(rankByReferences(files, [], edges)[0]?.path).toBe('src/Service.cs')
  })

  test('edges naming files the index does not know are ignored, not fatal', () => {
    const a = outline('src/a.ts', [['function', 'f', 0]], ['f'])
    const b = outline('src/b.ts', [['function', 'g', 0]], ['g'])
    const edges = new Map([
      ['src/deleted.ts', new Map([['src/a.ts', 5]])],
      ['src/a.ts', new Map([['src/renamed.ts', 5], ['src/a.ts', 5]])],
    ])
    expect(rankByReferences([a, b], [], edges).map((f) => f.path))
      .toEqual(rankByReferences([a, b]).map((f) => f.path))
  })

  test('an empty edge map ranks exactly as no edge map', () => {
    const core = outline('src/core.ts', [['class', 'Engine', 0]], ['Engine'])
    const a = outline('src/a.ts', [['function', 'a', 0]], ['a', 'Engine'])
    expect(rankByReferences([a, core], [], new Map()).map((f) => f.path))
      .toEqual(rankByReferences([a, core]).map((f) => f.path))
  })
})

describe('rendering', () => {
  test('a class carries its members on its own line, every name with its line number', () => {
    // The line numbers are what make a map entry the ARGUMENT of the next call: with them,
    // `read_file(path, start_line, end_line)` for one method is writable from the map alone;
    // without them the only way to reach the method is to read the file — which is what the
    // recorded sessions show, 285 reads to 0 outlines.
    const file: FileOutline = {
      path: 'src/store.ts',
      entries: [
        { kind: 'class', name: 'Store', depth: 0, line: 3 },
        { kind: 'method', name: 'save', depth: 1, line: 5 },
        { kind: 'method', name: 'load', depth: 1, line: 9 },
        { kind: 'function', name: 'helper', depth: 0, line: 14 },
      ],
      identifiers: new Set(),
    }
    expect(renderFile(file)).toBe('src/store.ts\n  class Store :3: save :5, load :9\n  function helper :14')
  })

  test('the header says the map is a snapshot and not the truth', () => {
    // A model that treats a stale map as ground truth is worse off than one with no map.
    const text = renderRepoMap([outline('a.ts', [['function', 'f', 0]])])
    expect(text).toMatch(/snapshot/i)
    expect(text).toMatch(/out of date/i)
    expect(text).toMatch(/read_file|symbol_outline/)
  })

  test('a budget that cuts the listing SAYS how much it cut', () => {
    // Told "here is the project", a model reads a truncated list as complete and concludes
    // a file it cannot see does not exist.
    const files = Array.from({ length: 40 }, (_, i) =>
      outline(`src/file${i}.ts`, [['function', `fn${i}`, 0]]))
    const text = renderRepoMap(files, 1_200)
    expect(text).toMatch(/more source files are not listed/)
    expect(text.length).toBeLessThanOrEqual(1_400) // + the footer that admits it
  })

  test('nothing to say is an empty string, not an empty heading', () => {
    expect(renderRepoMap([])).toBe('')
    // A budget too small for even one file would otherwise emit a header promising a map
    // and then no map.
    expect(renderRepoMap([outline('a.ts', [['function', 'f', 0]])], 10)).toBe('')
  })
})

describe('building it for real', () => {
  test('end to end, a small project maps to its own structure', async () => {
    write('src/engine.ts', 'export class Engine {\n  start() {}\n}\n')
    write('src/app.ts', 'import { Engine } from "./engine"\nexport function main() { new Engine() }\n')

    const map = await buildRepoMap(root)
    expect(map).toContain('src/engine.ts')
    expect(map).toContain('class Engine :1: start :2')
    // Engine is referenced by app.ts, so it leads.
    expect(map.indexOf('src/engine.ts')).toBeLessThan(map.indexOf('src/app.ts'))
  })

  test('a workspace that cannot be indexed yields no map, never a throw', async () => {
    await expect(buildRepoMap(join(root, 'does', 'not', 'exist'))).resolves.toBe('')
  })
})

describe('the vocabulary rule', () => {
  test('a name in most files of a LARGE project stops counting as a reference', () => {
    // `validate` and `execute` appear in every tool in this codebase, which made a test
    // file listing them six times the very first entry of the real map. Spread that wide is
    // vocabulary, not evidence about the file that defines it.
    const everywhere = Array.from({ length: 30 }, (_, i) =>
      outline(`src/tool${i}.ts`, [['method', 'validate', 0]], ['validate', 'unique' + i]))
    const genuine = outline('src/engine.ts', [['class', 'Engine', 0]], ['Engine'])
    const users = Array.from({ length: 3 }, (_, i) =>
      outline(`src/use${i}.ts`, [['function', `u${i}`, 0]], [`u${i}`, 'Engine']))

    const ranked = rankByReferences([...everywhere, genuine, ...users])
    expect(ranked[0]?.path).toBe('src/engine.ts')
  })

  test('but in a SMALL project nothing is vocabulary', () => {
    // A share is a statistic and a statistic needs a population. In a four-file project the
    // name three of them mention is the most central thing there. The first version of the
    // damping scored that file zero and ranked it last.
    const core = outline('src/core.ts', [['class', 'Engine', 0]], ['Engine'])
    const a = outline('src/a.ts', [['function', 'a', 0]], ['a', 'Engine'])
    const b = outline('src/b.ts', [['function', 'b', 0]], ['b', 'Engine'])
    expect(rankByReferences([a, b, core])[0]?.path).toBe('src/core.ts')
  })
})

describe('breadth', () => {
  test('one enormous file cannot eat the whole map', () => {
    // protocol.ts defines ninety types; uncapped it took most of a 6k budget by itself and
    // left a map of five files where twenty-five would have been more use.
    const huge = outline(
      'src/protocol.ts',
      Array.from({ length: 90 }, (_, i) => ['type', `T${i}`, 0] as [string, string, number]),
    )
    const others = Array.from({ length: 20 }, (_, i) =>
      outline(`src/file${i}.ts`, [['function', `fn${i}`, 0]]))

    const text = renderRepoMap([huge, ...others], 4_000)
    expect(text).toMatch(/…and 84 more/)
    // Everything else still got a line.
    expect(text).toContain('src/file19.ts')
  })

  test('a class with thirty methods lists some of them, not all', () => {
    const entries: [string, string, number][] = [['class', 'Big', 0]]
    for (let i = 0; i < 30; i++) entries.push(['method', `m${i}`, 1])
    const rendered = renderFile(outline('src/big.ts', entries))
    expect(rendered).toContain('m0 :1, m1 :1')
    expect(rendered).toMatch(/…\+22/)
    expect(rendered).not.toContain('m29')
  })
})

describe('a C# file renders its types and their members, not its namespace', () => {
  test('a file-scoped namespace is folded away', () => {
    // What the map printed for every C# file before: `namespace App :1: Controller :4` —
    // the namespace as the class, the class as its only member, the endpoints invisible.
    const file: FileOutline = {
      path: 'Api/LeadsController.cs',
      entries: [
        { kind: 'namespace', name: 'App.Api', depth: 0, line: 1 },
        { kind: 'class', name: 'LeadsController', depth: 1, line: 4 },
        { kind: 'method', name: 'List', depth: 2, line: 9 },
        { kind: 'method', name: 'Get', depth: 2, line: 30 },
        { kind: 'record', name: 'LeadRow', depth: 1, line: 60 },
        { kind: 'property', name: 'Id', depth: 2, line: 61 },
      ],
      identifiers: new Set(),
    }
    expect(renderFile(file)).toBe(
      'Api/LeadsController.cs\n  class LeadsController :4: List :9, Get :30\n  record LeadRow :60: Id :61',
    )
  })

  test('a block namespace, and a nested one, fold the same way', () => {
    const file: FileOutline = {
      path: 'A.cs',
      entries: [
        { kind: 'namespace', name: 'Outer', depth: 0, line: 1 },
        { kind: 'namespace', name: 'Inner', depth: 1, line: 2 },
        { kind: 'class', name: 'Deep', depth: 2, line: 3 },
        { kind: 'method', name: 'Run', depth: 3, line: 4 },
        { kind: 'class', name: 'Shallow', depth: 1, line: 20 },
      ],
      identifiers: new Set(),
    }
    expect(renderFile(file)).toBe('A.cs\n  class Deep :3: Run :4\n  class Shallow :20')
  })
})

describe('the layout summary', () => {
  test('a big folder is opened into its sub-folders while the listing stays short', () => {
    // The question the model spent its first steps asking one list_dir at a time: which
    // folders exist and how much lives in each. Two thousand files must read as twenty lines.
    const paths: string[] = []
    for (let i = 0; i < 40; i++) paths.push(`src/backend/Api/Controllers/C${i}.cs`)
    for (let i = 0; i < 30; i++) paths.push(`src/backend/Domain/E${i}.cs`)
    for (let i = 0; i < 60; i++) paths.push(`src/frontend/app/P${i}.tsx`)
    for (let i = 0; i < 200; i++) paths.push(`src/frontend/public/svg/i${i}.svg`)
    for (let i = 0; i < 5; i++) paths.push(`docs/d${i}.md`)
    paths.push('README.md', 'package.json')

    const lines = summariseLayout(paths)
    expect(lines.length).toBeLessThanOrEqual(24)
    // `src/` alone would say nothing; it is opened until the folders that matter are named.
    expect(lines).not.toContain('src/ 330 (svg 200, tsx 60)')
    expect(lines.some((l) => l.startsWith('src/backend/Api/ 40 (cs 40)'))).toBe(true)
    expect(lines.some((l) => l.startsWith('src/frontend/public/ 200 (svg 200)'))).toBe(true)
    // A small folder keeps its one line and is not opened.
    expect(lines).toContain('docs/ 5 (md 5)')
    // Files directly under the root are not a folder and are not listed as one.
    expect(lines.some((l) => l.includes('README'))).toBe(false)
  })

  test('the map carries the layout under its header, in front of the file blocks', () => {
    const text = renderRepoMap(
      [outline('src/a.ts', [['function', 'f', 0]])], undefined, ['src/ 12 (ts 12)', 'docs/ 3 (md 3)'],
    )
    expect(text).toMatch(/Folders \(files under each/)
    expect(text.indexOf('src/ 12 (ts 12)')).toBeLessThan(text.indexOf('src/a.ts\n'))
  })

  test('a multi-folder index prefixes each folder\'s layout with the folder name', async () => {
    const a = join(root, 'a')
    const b = join(root, 'b')
    for (let i = 0; i < 4; i++) write(`a/lib/f${i}.ts`, `export function f${i}() {}\n`)
    for (let i = 0; i < 4; i++) write(`b/src/g${i}.ts`, `export function g${i}() {}\n`)
    const index = await indexRepo([
      { name: 'alpha', root: a, access: 'write', primary: true },
      { name: 'beta', root: b, access: 'read', primary: false },
    ])
    expect(index.folders[0]?.layout).toEqual(['alpha/lib/ 4 (ts 4)'])
    expect(index.folders[1]?.layout).toEqual(['beta/src/ 4 (ts 4)'])
    const text = renderIndex(index)
    expect(text).toContain('alpha/lib/ 4 (ts 4)')
    expect(text).toContain('beta/src/ 4 (ts 4)')
  })
})

describe('ranking is transitive, and can be focused', () => {
  /** A file whose only content is `entries` it defines plus `identifiers` it mentions. */
  const f = (path: string, defines: string[], mentions: string[]): FileOutline => ({
    path,
    entries: defines.map((name) => ({ kind: 'class', name, line: 1, depth: 0 })),
    identifiers: new Set([...defines, ...mentions]),
  })

  // hub is referenced by ONE file — but that file is what everything else refers to.
  // popular is referenced by three files that nothing refers to. Flat in-degree crowns
  // `popular`; transitive ranking sees that `hub` is the one that matters.
  const files = [
    f('hub.ts', ['Hub'], []),
    f('core.ts', ['Core'], ['Hub']),
    f('popular.ts', ['Popular'], []),
    f('leafA.ts', ['LeafA'], ['Popular']),
    f('leafB.ts', ['LeafB'], ['Popular']),
    f('leafC.ts', ['LeafC'], ['Popular']),
    ...Array.from({ length: 8 }, (_, i) => f(`user${i}.ts`, [`User${i}`], ['Core'])),
  ]

  test('importance flows through references, not just counted at the edge', () => {
    const ranked = rankByReferences(files).map((r) => r.path)
    // `hub.ts` is cited once and `popular.ts` three times; transitively hub wins because
    // its one citer is itself heavily cited.
    expect(ranked.indexOf('hub.ts')).toBeLessThan(ranked.indexOf('popular.ts'))
  })

  test('focus lifts the work without collapsing the map to it', () => {
    const ranked = rankByReferences(files, ['leafA.ts']).map((r) => r.path)
    expect(ranked[0]).toBe('leafA.ts')
    // Still a map: the rest of the repository is present and ordered, not discarded.
    expect(ranked).toHaveLength(files.length)
    expect(ranked).toContain('core.ts')
  })

  test('no focus is the plain repository ordering, unchanged', () => {
    expect(rankByReferences(files, []).map((r) => r.path))
      .toEqual(rankByReferences(files).map((r) => r.path))
  })
})

describe('a language whose types are not at the top level', () => {
  test('C# ranks by references rather than falling back to alphabetical order', async () => {
    // The defect: definers were collected from depth 0 only, which is a TypeScript
    // assumption. In C# the depth-0 entry is the NAMESPACE and the type sits under it, so
    // every file "defined" the same one or two namespace names, the graph had no usable
    // edges, PageRank returned its restart vector unchanged, and the tie-break sorted by
    // path. The shipped "transitively ranked" map was alphabetical order on every C#
    // repository. Measured on a real 40-file workspace: 0 edges before, 108 after.
    write('src/Zeta/Interfaces.cs', [
      'namespace App.Services;',
      'public interface IPlanner { void Build(); }',
      'public interface ILogger { void Info(string m); }',
    ].join('\n'))
    // Three files that all lean on the interfaces, and are alphabetically FIRST -- so a
    // ranking that merely sorted paths would put them on top and the interfaces last.
    for (const name of ['Alpha', 'Beta', 'Gamma']) {
      write(`src/${name}.cs`, [
        'namespace App;',
        `public sealed class ${name}`,
        '{',
        '    private readonly IPlanner _planner;',
        '    private readonly ILogger _logger;',
        `    public ${name}(IPlanner p, ILogger l) { _planner = p; _logger = l; }`,
        '}',
      ].join('\n'))
    }

    const ranked = rankByReferences(await indexWorkspace(root))
    expect(ranked.length).toBeGreaterThan(3)
    expect(ranked[0]?.path).toBe('src/Zeta/Interfaces.cs')
    // And it is genuinely not the alphabetical answer.
    expect(ranked.map((f) => f.path)).not.toEqual([...ranked.map((f) => f.path)].sort())
  })

  test('.NET build output is not part of the project', async () => {
    // 10 of the 40 files in one workspace's map were generated `obj/**/*.g.cs`: a quarter of
    // what the model was told the project consists of was machine-written.
    write('src/App.cs', 'namespace App;\npublic class App { }\n')
    write('src/obj/Debug/App.g.cs', 'namespace App;\npublic partial class App { }\n')
    write('src/bin/Release/Leftover.cs', 'namespace App;\npublic class Leftover { }\n')

    const paths = (await indexWorkspace(root)).map((f) => f.path)
    expect(paths).toContain('src/App.cs')
    expect(paths.some((p) => p.includes('obj/') || p.includes('bin/'))).toBe(false)
  })

  test('markup with no grammar is listed by name rather than left out', async () => {
    // `MainWindow.xaml` was the largest file in the workspace and the most-read file in the
    // longest recorded session, and it never once appeared in the map -- so the model was
    // told a WPF project consists of its code-behind. Its identifiers still join the graph.
    write('src/MainWindow.xaml', '<Window x:Class="App.MainWindow"><Grid/></Window>')
    write('src/MainWindow.xaml.cs', 'namespace App;\npublic partial class MainWindow { }\n')

    const files = await indexWorkspace(root)
    const xaml = files.find((f) => f.path === 'src/MainWindow.xaml')
    expect(xaml).toBeDefined()
    expect(xaml?.entries).toEqual([])
    expect(xaml?.identifiers.has('MainWindow')).toBe(true)
    // Named, and honestly: a path with nothing under it claims no definitions.
    expect(renderFile(xaml!).trim()).toBe('src/MainWindow.xaml')
  })
})
