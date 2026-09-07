import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { execa } from 'execa'
import { walkFiles } from '../host/file-search.js'
import type { FileOutline } from '../outline/repo-map.js'
import { outlineFile, SUPPORTED_EXTENSIONS, type OutlineEntry } from '../outline/tree-sitter.js'

/**
 * The project map's skeleton: what is TRUE about the code, computed rather than written.
 *
 * The map (docs/MAP.md) is a wiki of the project the model writes for itself and for the
 * person, note by note, while the machine is idle. A wiki written from nothing drifts into
 * prose — "this module handles orders" — that nothing can be done with. So the model never
 * invents the structure: files, symbols, who uses whose names, which tests mention which
 * files, what changes together in git, and what the commits that touched a file said, are
 * all established here from parsers and from git, exactly, and the model only fills in the
 * words on top of nodes and edges that already exist. Every link in a note points at a real
 * file because it was made from this graph, not from the model's memory of it.
 */

export interface MapFileNode {
  /** Root-relative, forward slashes. */
  path: string
  /** sha1 of the content — what tells a note it has gone stale. */
  hash: string
  bytes: number
  lines: number
  /** The extension without its dot. */
  language: string
  symbols: OutlineEntry[]
  /** Files whose defined names this file mentions — what it depends on, textually. */
  uses: string[]
  /** Files that mention names this file defines. */
  usedBy: string[]
  /** Test files that mention this file's names, or are named after it. */
  tests: string[]
  isTest: boolean
  /** Files that changed in the same commits as this one, most often first. */
  coChanges: { path: string; count: number }[]
  /** Subjects of the last commits that touched the file, newest first — the "why" the code
   * itself never says. */
  history: string[]
}

export interface MapModuleNode {
  /** A directory, root-relative; `''` is the root itself. */
  path: string
  /** Files directly inside. */
  files: string[]
  /** Directories directly inside that hold files somewhere below. */
  children: string[]
}

/** One folder of the workspace, as the map addresses it: `name/` is the first segment of
 * every path inside it when the workspace has several folders, nothing when it has one. */
export interface MapMount {
  name: string
  root: string
}

export interface MapSkeleton {
  builtAt: string
  /** How many commits the co-change and history figures were read from; 0 outside git. */
  commits: number
  files: MapFileNode[]
  modules: MapModuleNode[]
  /** The folders the map was built from; several means paths carry the folder name. */
  mounts: MapMount[]
}

/** Where a map path lives on disk. */
export function absoluteOf(skeleton: Pick<MapSkeleton, 'mounts'>, path: string): string | null {
  if (skeleton.mounts.length === 1) return join(skeleton.mounts[0]!.root, path)
  const cut = path.indexOf('/')
  const name = cut === -1 ? path : path.slice(0, cut)
  const mount = skeleton.mounts.find((m) => m.name === name)
  if (mount === undefined) return null
  return join(mount.root, cut === -1 ? '' : path.slice(cut + 1))
}

/** Symbol kinds whose names count as a file's vocabulary for the reference graph. */
const DEFINING_KINDS = new Set(['class', 'interface', 'struct', 'record', 'enum', 'function', 'type', 'namespace'])
/** A name shorter than this is too common a word to link on (`run`, `str`, `list`). */
const MIN_NAME = 5
/** A name this long is distinctive enough to carry an edge on its own; shorter names need
 * company. `sha1` and `parse` link half a repository to itself; `renderFileNote` does not. */
const DISTINCTIVE_NAME = 8
/** An edge is kept from this weight: two ordinary shared names, or one distinctive one. */
const MIN_EDGE_WEIGHT = 2
/** An import that resolves to a known file is the dependency itself, no guessing in it. */
const IMPORT_WEIGHT = 3
/** Relative specifiers in `import … from`, `require()` and `import()`; bare ones name packages. */
const IMPORT_SPEC = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"](\.{1,2}\/[^'"\n]+)['"]/g
const PY_IMPORT = /^\s*from\s+(\.+[\w.]*)\s+import\b/gm
const SCRIPT_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.d.ts']
/** A name defined in more than this share of files is vocabulary, not a reference. */
const VOCABULARY_SHARE = 0.1
/** Edges kept per file, by weight: a map is a summary, not the whole graph. */
const MAX_EDGES = 12
const MAX_TESTS = 8
const MAX_CO_CHANGES = 6
const MAX_HISTORY = 8
/** Commits touching more files than this are refactors or imports and say nothing about
 * what belongs together. */
const MAX_COMMIT_FILES = 30
const COMMITS_TO_READ = 3000

const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$/i
/** The map indexes everything with a grammar, within reason; the repo map's tighter cap is
 * a prompt budget, which does not apply to notes on disk. */
const MAX_FILES = 4_000
const MAX_FILE_BYTES = 300_000
const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/g

interface Outlined extends FileOutline {
  content: string
  imports: string[]
}

/**
 * Every supported source file, parsed. Unlike the repo map's walk this KEEPS a file whose
 * outline is empty: a test file is usually nothing but calls, and a map that drops the
 * tests has no test edges at all.
 */
async function collectOutlines(root: string): Promise<Outlined[]> {
  const supported = new Set(SUPPORTED_EXTENSIONS)
  const all = await walkFiles(root)
  const out: Outlined[] = []
  for (const path of all.filter((p) => supported.has(extname(p).toLowerCase())).slice(0, MAX_FILES)) {
    const abs = join(root, path)
    try {
      if ((await stat(abs)).size > MAX_FILE_BYTES) continue
      const content = await readFile(abs, 'utf8')
      const result = await outlineFile(abs, content)
      out.push({
        path, entries: 'unsupported' in result ? [] : result, identifiers: new Set(content.match(IDENTIFIER) ?? []), abs, content,
        imports: importSpecs(content, extname(path).slice(1).toLowerCase()),
      })
    } catch {
      continue
    }
  }
  return out
}

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path)
}

/** The stem a test file is named after: `foo.test.ts` → `foo`, `FooTests.cs` → `foo`. */
function testStem(path: string): string {
  const base = path.split('/').pop() ?? path
  return base.replace(/\.(test|spec)\.[a-z]+$/i, '').replace(/tests?\.[a-z]+$/i, '').replace(/\.[a-z]+$/i, '').toLowerCase()
}

function stem(path: string): string {
  const base = path.split('/').pop() ?? path
  return base.replace(/\.[a-z]+$/i, '').toLowerCase()
}

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

/**
 * A name worth linking on: one made of two words (`walkFiles`, `MAX_FILES`, `sha256`) or a
 * long capitalised one (`Workspace`). `parse`, `entries`, `target` and `person` are
 * functions somewhere and English everywhere — the first live map linked a parser to a
 * slide-deck script on them.
 */
export function isLinkableName(name: string): boolean {
  if (name.length < MIN_NAME) return false
  if (/[a-z][A-Z]/.test(name) || /[A-Za-z]_[A-Za-z]/.test(name) || /\d/.test(name)) return true
  return /^[A-Z][a-z]+$/.test(name) && name.length >= DISTINCTIVE_NAME
}

/** Names a file defines, worth linking on. */
export function definedNames(entries: readonly OutlineEntry[]): string[] {
  const names = new Set<string>()
  for (const e of entries) {
    if (!DEFINING_KINDS.has(e.kind) || e.depth > 1 || !isLinkableName(e.name)) continue
    names.add(e.name)
  }
  return [...names]
}

/** The relative module specifiers a file imports — `./money`, `../lib/x.js`, `.mod` in Python. */
export function importSpecs(content: string, language: string): string[] {
  const out = new Set<string>()
  for (const m of content.matchAll(language === 'py' ? PY_IMPORT : IMPORT_SPEC)) out.add(m[1]!)
  return [...out]
}

function normalisePath(p: string): string {
  const parts: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') { parts.pop(); continue }
    parts.push(seg)
  }
  return parts.join('/')
}

/**
 * The known file a relative specifier names, or null: `./money` beside `orders.ts` is
 * `money.ts`, `./ui` may be `ui/index.tsx`, `./x.js` is `x.ts` in a TypeScript project, and
 * Python's `..pkg.mod` walks up a package. A specifier that resolves to nothing on the map
 * makes no edge — a guess is worse than a gap.
 */
export function resolveImport(from: string, spec: string, known: ReadonlySet<string>): string | null {
  const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : ''
  if (spec.startsWith('.') && !spec.startsWith('./') && !spec.startsWith('../')) {
    const ups = (/^\.+/.exec(spec)?.[0].length ?? 1) - 1
    let base = dir
    for (let i = 0; i < ups; i++) base = base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : ''
    const rel = spec.slice(ups + 1).replace(/\./g, '/')
    const target = normalisePath(base === '' ? rel : `${base}/${rel}`)
    for (const c of [`${target}.py`, `${target}/__init__.py`]) if (known.has(c)) return c
    return null
  }
  const target = normalisePath(dir === '' ? spec : `${dir}/${spec}`)
  const candidates = [target, ...SCRIPT_EXTENSIONS.map((ext) => `${target}${ext}`)]
  const scripted = /\.(js|jsx|mjs|cjs)$/.exec(target)
  if (scripted !== null) {
    const stem = target.slice(0, -scripted[0].length)
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`)
  }
  candidates.push(...SCRIPT_EXTENSIONS.map((ext) => `${target}/index${ext}`))
  for (const c of candidates) if (known.has(c)) return c
  return null
}

/**
 * Who depends on whom. An import that resolves to a file on the map is the dependency
 * itself; beyond that, textual — an identifier appearing in a file — with the dampings the
 * repo map learned the hard way: single words are words, and a name defined all over the
 * project is vocabulary.
 */
export function referenceEdges(files: readonly (FileOutline & { imports?: readonly string[] })[]): Map<string, Map<string, number>> {
  const definers = new Map<string, string[]>()
  for (const f of files) {
    // A test defines nothing anyone reuses; an edge INTO a test file is always noise.
    if (isTestPath(f.path)) continue
    for (const name of definedNames(f.entries)) {
      definers.set(name, [...(definers.get(name) ?? []), f.path])
    }
  }
  const known = new Set(files.map((f) => f.path))
  const vocabularyAbove = Math.max(2, Math.floor(files.length * VOCABULARY_SHARE))
  const edges = new Map<string, Map<string, number>>()
  for (const f of files) {
    const out = new Map<string, number>()
    for (const spec of f.imports ?? []) {
      const target = resolveImport(f.path, spec, known)
      if (target !== null && target !== f.path) out.set(target, (out.get(target) ?? 0) + IMPORT_WEIGHT)
    }
    for (const [name, owners] of definers) {
      if (owners.length > vocabularyAbove || !f.identifiers.has(name)) continue
      const weight = name.length >= DISTINCTIVE_NAME ? MIN_EDGE_WEIGHT : 1
      for (const owner of owners) {
        if (owner === f.path) continue
        out.set(owner, (out.get(owner) ?? 0) + weight)
      }
    }
    for (const [owner, weight] of out) {
      if (weight < MIN_EDGE_WEIGHT) out.delete(owner)
    }
    edges.set(f.path, out)
  }
  return edges
}

/** Parses `git log --name-only --format=%x1e%s` output into commits. Exported for the test. */
export function parseCommitLog(text: string): { subject: string; files: string[] }[] {
  const out: { subject: string; files: string[] }[] = []
  for (const record of text.split('\x1e')) {
    const lines = record.split(/\r?\n/).map((l) => l.trim())
    if (lines.length === 0 || lines[0] === '') continue
    const subject = lines[0]!
    const files = lines.slice(1).filter((l) => l !== '')
    out.push({ subject, files })
  }
  return out
}

/** What git remembers about the files under `root`: co-changes and the last subjects. */
export async function readHistory(root: string, known: ReadonlySet<string>): Promise<{
  commits: number
  coChanges: Map<string, Map<string, number>>
  history: Map<string, string[]>
}> {
  const coChanges = new Map<string, Map<string, number>>()
  const history = new Map<string, string[]>()
  let commits = 0
  try {
    const prefix = (await execa('git', ['rev-parse', '--show-prefix'], { cwd: root, reject: false, windowsHide: true })).stdout.trim()
    const log = await execa('git', ['log', '--name-only', '--format=%x1e%s', `-n`, String(COMMITS_TO_READ), '--', '.'], { cwd: root, reject: false, windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
    if (log.exitCode !== 0) return { commits: 0, coChanges, history }
    for (const commit of parseCommitLog(log.stdout)) {
      commits += 1
      const files = commit.files
        .map((f) => (prefix !== '' && f.startsWith(prefix) ? f.slice(prefix.length) : prefix === '' ? f : ''))
        .filter((f) => f !== '' && known.has(f))
      for (const f of files) {
        const h = history.get(f) ?? []
        if (h.length < MAX_HISTORY) { h.push(commit.subject); history.set(f, h) }
      }
      if (files.length > MAX_COMMIT_FILES || files.length < 2) continue
      for (const a of files) {
        const row = coChanges.get(a) ?? new Map<string, number>()
        for (const b of files) {
          if (a !== b) row.set(b, (row.get(b) ?? 0) + 1)
        }
        coChanges.set(a, row)
      }
    }
  } catch {
    // Not a repository, or no git: the map still has everything the parsers give it.
  }
  return { commits, coChanges, history }
}

function topOf(row: Map<string, number> | undefined, max: number): { path: string; count: number }[] {
  if (row === undefined) return []
  return [...row.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([path, count]) => ({ path, count }))
}

/** The modules a set of file paths implies: every directory on the way to a file. */
export function modulesOf(paths: readonly string[]): MapModuleNode[] {
  const files = new Map<string, string[]>()
  const children = new Map<string, Set<string>>()
  const ensure = (dir: string): void => {
    if (!files.has(dir)) files.set(dir, [])
    if (!children.has(dir)) children.set(dir, new Set())
  }
  ensure('')
  for (const path of paths) {
    const parts = path.split('/')
    const dir = parts.slice(0, -1).join('/')
    ensure(dir)
    files.get(dir)!.push(path)
    for (let i = parts.length - 1; i >= 1; i -= 1) {
      const child = parts.slice(0, i).join('/')
      const parent = parts.slice(0, i - 1).join('/')
      ensure(child)
      ensure(parent)
      children.get(parent)!.add(child)
    }
  }
  return [...files.keys()].sort().map((path) => ({
    path,
    files: [...files.get(path)!].sort(),
    children: [...children.get(path)!].sort(),
  }))
}

/**
 * Everything the map knows without the model: the parsers' outlines, the reference graph,
 * the tests, and what git remembers. Reads every supported source file once.
 *
 * A workspace of several folders is one map: each folder is a top-level module, its paths
 * carry the folder's name the way every other path in the app does, git is read per folder
 * (each may be its own repository, or none), and the reference graph runs across folders —
 * a name defined in `lib/` and used in `api/` is an edge, which is how the map tells two
 * related projects from two that merely sit side by side.
 */
export async function buildSkeleton(target: string | readonly MapMount[]): Promise<MapSkeleton> {
  const mounts: MapMount[] = typeof target === 'string' ? [{ name: '', root: target }] : target.map((m) => ({ name: m.name, root: m.root }))
  const multi = mounts.length > 1
  const outlines: Outlined[] = []
  let commits = 0
  const coChanges = new Map<string, Map<string, number>>()
  const history = new Map<string, string[]>()
  for (const mount of mounts) {
    const own = await collectOutlines(mount.root)
    const prefix = multi ? `${mount.name}/` : ''
    const known = new Set(own.map((f) => f.path))
    const remembered = await readHistory(mount.root, known)
    commits += remembered.commits
    for (const [a, row] of remembered.coChanges) {
      coChanges.set(`${prefix}${a}`, new Map([...row].map(([b, n]) => [`${prefix}${b}`, n])))
    }
    for (const [a, subjects] of remembered.history) history.set(`${prefix}${a}`, subjects)
    for (const f of own) outlines.push({ ...f, path: `${prefix}${f.path}` })
  }
  const edges = referenceEdges(outlines)

  // Reverse edges and tests, in one pass over the forward graph.
  const usedBy = new Map<string, Map<string, number>>()
  for (const [from, row] of edges) {
    for (const [to, weight] of row) {
      const rev = usedBy.get(to) ?? new Map<string, number>()
      rev.set(from, weight)
      usedBy.set(to, rev)
    }
  }
  const testsByStem = new Map<string, string[]>()
  for (const f of outlines) {
    if (!isTestPath(f.path)) continue
    const key = testStem(f.path)
    testsByStem.set(key, [...(testsByStem.get(key) ?? []), f.path])
  }

  const files: MapFileNode[] = []
  for (const f of outlines) {
    const content = f.content
    const mentionedByTests = [...(usedBy.get(f.path)?.keys() ?? [])].filter(isTestPath)
    const namedTests = testsByStem.get(stem(f.path)) ?? []
    const tests = [...new Set([...namedTests, ...mentionedByTests])].filter((t) => t !== f.path).slice(0, MAX_TESTS)
    files.push({
      path: f.path,
      hash: sha1(content),
      bytes: Buffer.byteLength(content, 'utf8'),
      lines: content === '' ? 0 : content.split('\n').length,
      language: extname(f.path).slice(1).toLowerCase(),
      symbols: f.entries,
      uses: topOf(edges.get(f.path), MAX_EDGES).map((e) => e.path),
      usedBy: topOf(usedBy.get(f.path), MAX_EDGES).map((e) => e.path).filter((p) => !isTestPath(p)),
      tests,
      isTest: isTestPath(f.path),
      coChanges: topOf(coChanges.get(f.path), MAX_CO_CHANGES),
      history: history.get(f.path) ?? [],
    })
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { builtAt: new Date().toISOString(), commits, files, modules: modulesOf(files.map((f) => f.path)), mounts }
}
