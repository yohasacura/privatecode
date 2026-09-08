import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { LlamaClient } from '../src/llama/client.js'
import { MapBuilder, mapExists, mapStatus, readIndex, type MapProgress, parseModuleNote, parseProjectNote } from '../src/map/builder.js'
import { noteName, renderFileNote, wikilink } from '../src/map/notes.js'
import { readMapNote, mapTree } from '../src/map/read.js'
import { orientationFor, projectMapTool, searchNotes } from '../src/map/tool.js'
import { Workspace } from '../src/workspace.js'

/**
 * The builder against a scripted model: one build writes the vault, a second build with
 * nothing changed writes nothing, a changed file re-notes itself and everything above it,
 * the self-check scores a note, and a turn holding the slot makes the build wait.
 */

let root: string
let dir: string

/** A model that fills every form it is handed, and records what it was asked. */
function scriptedClient(log: string[], opts: { busy?: () => boolean } = {}): LlamaClient {
  return {
    chat: async (req: { jsonSchema?: { name: string }; messages: { role: string; content: string | null }[] }) => {
      const name = req.jsonSchema?.name ?? 'none'
      const user = req.messages.find((m) => m.role === 'user')?.content ?? ''
      log.push(`${name}:${/File: (\S+)|Directory: (\S+)/.exec(user)?.[1] ?? /Directory: (\S+)/.exec(user)?.[1] ?? 'project'}`)
      if (opts.busy?.() === true) throw new Error('the slot was busy — the build asked while a turn ran')
      const answer = (() => {
        switch (name) {
          case 'file_note': {
            const file = /File: (\S+)/.exec(user)?.[1] ?? '?'
            return { what: `Handles ${file}.`, why: 'Because the commits said so.', contracts: [{ symbol: 'placeOrder', guarantees: 'returns the formatted total' }], invariants: ['totals are cents'], gotchas: ['doubles the total'] }
          }
          case 'module_note':
            return { purpose: 'The orders module.', entryPoints: [{ symbol: 'placeOrder', path: 'src/orders.ts', role: 'the way in' }], flows: [{ name: 'placing an order', steps: ['src/orders.ts: placeOrder formats the total'] }], interactions: ['talks to money'] }
          case 'project_note':
            // `docs/` is a folder with no source files and `placeOrder` a symbol taken for a
            // path — the two ways the model writes a path that is on no note.
            return { overview: 'A shop.', subsystems: [{ path: 'src/', role: 'the code' }, { path: 'docs/', role: 'the words' }], conventions: ['cents everywhere'], startHere: [{ path: 'src/orders.ts', why: 'the entry point' }, { path: 'placeOrder', why: 'a symbol, not a file' }] }
          case 'map_questions':
            return { questions: [{ q: 'What does placeOrder return?', a: 'the formatted total' }, { q: 'Unit?', a: 'cents' }, { q: 'Doubling?', a: 'yes' }] }
          case 'map_answers':
            return { answers: ['the formatted total', 'cents', 'not in the note'] }
          case 'map_verdicts':
            return { verdicts: [true, true, false] }
          default:
            return {}
        }
      })()
      return { message: { role: 'assistant', content: JSON.stringify(answer) }, finishReason: 'stop', wallSeconds: 0 }
    },
  } as unknown as LlamaClient
}

const git = (args: string): void => { execSync(`git -c user.email=t@t -c user.name=t ${args}`, { cwd: root, stdio: 'ignore' }) }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-mapb-'))
  dir = join(root, '.privatecode', 'map')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'money.ts'), 'export function formatMoney(cents: number): string { return String(cents) }\n')
  writeFileSync(join(root, 'src', 'orders.ts'), 'import { formatMoney } from "./money"\nexport function placeOrder(total: number): string { return formatMoney(total) }\n')
  git('init -q --initial-branch=main .')
  git('add -A')
  git('commit -qm "the shop"')
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function builder(log: string[], progress: MapProgress[] = [], busy: () => boolean = () => false): MapBuilder {
  return new MapBuilder({ root, dir, client: scriptedClient(log, { busy }), model: 'scripted', onProgress: (p) => progress.push(p), isBusy: busy })
}

describe('building the map', () => {
  test('writes a note per file, per module and for the project, as a vault with links', async () => {
    const log: string[] = []
    const progress: MapProgress[] = []
    const result = await builder(log, progress).build()
    expect(result).toMatchObject({ phase: 'done', filesWritten: 2, modulesWritten: 2, projectWritten: true, failed: [] })
    expect(log).toEqual(['file_note:src/money.ts', 'file_note:src/orders.ts', 'module_note:src/', 'module_note:.', 'project_note:project'])
    const orders = readFileSync(join(dir, `${noteName('file', 'src/orders.ts')}.md`), 'utf8')
    expect(orders).toContain('# src/orders.ts')
    expect(orders).toContain('## What\nHandles src/orders.ts.')
    expect(orders).toContain(`**placeOrder** — returns the formatted total`)
    expect(orders).toContain(wikilink('file', 'src/money.ts'))
    expect(orders).toContain(wikilink('module', 'src'))
    expect(readFileSync(join(dir, 'modules', 'src.md'), 'utf8')).toContain('### placing an order')
    expect(readFileSync(join(dir, 'Project.md'), 'utf8')).toContain('## Overview\nA shop.')
    expect(existsSync(join(dir, 'README.md'))).toBe(true)
    expect(progress.map((p) => p.phase)).toEqual(['skeleton', 'files', 'files', 'modules', 'modules', 'project', 'done'])
    const status = mapStatus(dir)
    expect(status).toMatchObject({ exists: true, files: 2, modules: 2, noted: 2, stale: 0, verified: 0, fidelity: null })
    expect(mapExists(dir)).toBe(true)
  })

  test('a second build with nothing changed asks the model nothing; a changed file re-notes itself and everything above', async () => {
    await builder([]).build()
    const again: string[] = []
    expect(await builder(again).build()).toMatchObject({ phase: 'done', filesWritten: 0, modulesWritten: 0, projectWritten: false })
    expect(again).toEqual([])

    writeFileSync(join(root, 'src', 'orders.ts'), 'export function placeOrder(total: number): string { return String(total * 2) }\n')
    const after: string[] = []
    expect(await builder(after).build()).toMatchObject({ phase: 'done', filesWritten: 1, modulesWritten: 2, projectWritten: true })
    expect(after).toEqual(['file_note:src/orders.ts', 'module_note:src/', 'module_note:.', 'project_note:project'])
    expect(mapStatus(dir).stale).toBe(0)
  })

  test('the self-check scores a note by the questions it can answer', async () => {
    const log: string[] = []
    const result = await builder(log).build({ verify: true, limit: 1 })
    // One of two files noted: the module above them waits, and so does the project note —
    // a module described from half its files is a module the model would make up.
    expect(result).toMatchObject({ filesWritten: 1, verified: 1, modulesWritten: 0, projectWritten: false })
    const index = readIndex(dir)!
    expect(index.notes.files['src/money.ts']?.fidelity).toBe(0.67)
    expect(readFileSync(join(dir, `${noteName('file', 'src/money.ts')}.md`), 'utf8')).toContain('fidelity: 0.67')
    expect(mapStatus(dir)).toMatchObject({ noted: 1, stale: 1, verified: 1, fidelity: 0.67 })
  })

  test('a build waits while a turn holds the slot', async () => {
    let busy = true
    setTimeout(() => { busy = false }, 2_500)
    const log: string[] = []
    const started = Date.now()
    const result = await builder(log, [], () => busy).build({ limit: 1 })
    expect(result.phase).toBe('done')
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_000)
  }, 20_000)

  test('a build that is stopped keeps what it wrote and says so', async () => {
    const log: string[] = []
    const b = builder(log)
    const run = b.build()
    b.cancel()
    const result = await run
    expect(['stopped', 'done']).toContain(result.phase)
    expect(readIndex(dir)).not.toBeNull()
  })
})

describe('reading the map', () => {
  test('a note comes with the links it carries, and the tree says which files have fresh notes', async () => {
    await builder([]).build()
    const index = readIndex(dir)!
    const note = readMapNote(dir, index, 'src/orders.ts')
    expect(note.kind).toBe('file')
    expect(note.links).toEqual(expect.arrayContaining([
      { kind: 'module', path: 'src', label: 'src' },
      { kind: 'file', path: 'src/money.ts', label: 'money.ts' },
    ]))
    const project = readMapNote(dir, index, 'Project')
    expect(project.kind).toBe('project')
    // The model's `src/` became `src`; `docs/` and `placeOrder` are on no note, so they are
    // named in the markdown and absent from the links.
    expect(project.links).toEqual([
      { kind: 'module', path: 'src', label: 'src' },
      { kind: 'file', path: 'src/orders.ts', label: 'orders.ts' },
    ])
    expect(project.markdown).toContain('`docs` — the words')
    expect(project.markdown).toContain('`placeOrder` — a symbol, not a file')
    expect(project.markdown).toContain(`${wikilink('module', 'src')} — the code`)
    expect(readMapNote(dir, index, '.').kind).toBe('module')
    expect(readMapNote(dir, index, 'nowhere.ts').kind).toBe('missing')
    const tree = mapTree(index)
    expect(tree.modules.find((m) => m.path === 'src')?.files).toEqual([
      { path: 'src/money.ts', noted: true, fidelity: null },
      { path: 'src/orders.ts', noted: true, fidelity: null },
    ])
    // A file edited since its note was written is stale — told apart from one never noted —
    // as soon as a build has read the code again, even one that wrote nothing.
    writeFileSync(join(root, 'src', 'orders.ts'), 'export function placeOrder(total: number): string { return String(total * 3) }\n')
    await builder([]).build({ limit: 0 })
    expect(mapTree(readIndex(dir)!).modules.find((m) => m.path === 'src')?.files).toEqual([
      { path: 'src/money.ts', noted: true, fidelity: null },
      { path: 'src/orders.ts', noted: false, stale: true, fidelity: null },
    ])
  })

  test('the tool answers with the project note, a note by path, and a search', async () => {
    await builder([]).build()
    const ctx = { workspace: new Workspace(root) }
    const project = await projectMapTool.execute({}, ctx)
    expect(project.ok).toBe(true)
    expect(project.content).toContain('## Overview')
    const byPath = await projectMapTool.execute({ path: 'src/orders.ts' }, ctx)
    expect(byPath.content).toContain('# src/orders.ts')
    const module = await projectMapTool.execute({ path: 'src' }, ctx)
    expect(module.content).toContain('# src/')
    // A path and a query together: the path's note, not a search.
    expect((await projectMapTool.execute({ path: 'src', query: 'placeOrder' }, ctx)).content).toContain('# src/')
    const hits = searchNotes(readIndex(dir)!, 'placeOrder formatted')
    expect(hits[0]?.path).toBe('src/orders.ts')
    // A hit carries the note's lines that matched: the answer is in the hit, not behind it.
    expect(hits[0]?.lines).toEqual(['  · contract: placeOrder — returns the formatted total'])
    const search = await projectMapTool.execute({ query: 'placeOrder' }, ctx)
    expect(search.content).toContain('src/orders.ts — Handles src/orders.ts.\n  · contract: placeOrder — returns the formatted total')
    const missing = await projectMapTool.execute({ path: 'src/nothing.ts' }, ctx)
    expect(missing.ok).toBe(false)
  })

  test('the first move is made by the harness: the notes nearest a request, or nothing', async () => {
    await builder([]).build()
    const index = readIndex(dir)!
    const block = orientationFor(index, 'Where is placeOrder and what does it return?')!
    expect(block.startsWith('Project map — the notes nearest this request')).toBe(true)
    expect(block).toContain('- src/orders.ts — Handles src/orders.ts.')
    expect(block).toContain('  · contract: placeOrder — returns the formatted total')
    // Square brackets never reach the block: it lives inside one the window strips by depth.
    expect(block).not.toMatch(/[[\]]/)
    // A request about nothing on the map costs nothing.
    expect(orientationFor(index, 'Why does the login page flicker on Safari?')).toBeNull()
    // A file edited since its note was written is still offered, and says so.
    writeFileSync(join(root, 'src', 'orders.ts'), 'export function placeOrder(total: number): string { return String(total * 3) }\n')
    await builder([]).build({ limit: 0 })
    expect(orientationFor(readIndex(dir)!, 'Where is placeOrder and what does it return?')).toContain('- src/orders.ts (note from an earlier version of the file) — Handles src/orders.ts.')
  })

  test('without a map the tool says so and points at the tab', async () => {
    const r = await projectMapTool.execute({}, { workspace: new Workspace(root) })
    expect(r.ok).toBe(false)
    expect(r.content).toContain('Map tab')
  })

  test('a rendered file note names its module, its symbols and its history', () => {
    const md = renderFileNote(
      { kind: 'file', path: 'src/a.ts', hash: 'h', what: 'W', why: 'Y', contracts: [], invariants: ['I'], gotchas: [], builtAt: 't', model: 'm', fidelity: 1 },
      { path: 'src/a.ts', hash: 'h', bytes: 1, lines: 1, language: 'ts', symbols: [{ kind: 'function', name: 'f', line: 1, depth: 0 }], uses: [], usedBy: [], tests: [], isTest: false, coChanges: [], history: ['first'] },
    )
    expect(md.startsWith('---\nkind: "file"\npath: "src/a.ts"')).toBe(true)
    expect(md).toContain('[[modules/src|src]]')
    expect(md).toContain('- `function` **f** (line 1)')
    expect(md).toContain('## History\n- first')
  })
})

describe('reading the forms', () => {
  test("paths come back as the skeleton writes them, whatever the model's habit", () => {
    const module = parseModuleNote({
      purpose: 'p',
      entryPoints: [{ symbol: 'main', path: './core/src/main.ts', role: 'r' }, { symbol: 'x', path: '', role: 'r' }],
      flows: [{ name: 'f', steps: ['1. first', '2) second', 'a. third', 'plain'] }],
      interactions: [],
    })!
    expect(module.entryPoints).toEqual([{ symbol: 'main', path: 'core/src/main.ts', role: 'r' }])
    expect(module.flows[0]!.steps).toEqual(['first', 'second', 'third', 'plain'])
    const project = parseProjectNote({
      overview: 'o',
      subsystems: [{ path: 'core/', role: 'a' }, { path: '.', role: 'b' }, { path: 'app\\src\\', role: 'c' }],
      conventions: [],
      startHere: [{ path: './core/src/map/builder.ts', why: 'w' }],
    })!
    expect(project.subsystems.map((s) => s.path)).toEqual(['core', '', 'app/src'])
    expect(project.startHere[0]!.path).toBe('core/src/map/builder.ts')
  })
})
