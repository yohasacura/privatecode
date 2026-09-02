import { readFile, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { walkFiles } from '../host/file-search.js'
import type { Mount } from '../mounts.js'
import { outlineFile, SUPPORTED_EXTENSIONS, type OutlineEntry } from './tree-sitter.js'

/**
 * A structural map of the project, for the top of the prompt.
 *
 * Without one the model orients by guessing: it greps for a name it hopes exists, reads a
 * file to find out it was the wrong one, and spends two or three steps arriving where a
 * developer would have started. The map is the answer to "what is in this project and where"
 * given before the question is asked.
 *
 * WHY IT IS AFFORDABLE HERE, specifically. Qwen3.6's recurrent blocks force an append-only
 * prompt (see DESIGN.md), which the whole design already exploits: everything before the
 * conversation is a stable prefix the server keeps cached. A map placed there is paid for
 * ONCE, on the first request of a session, and is free on every request after it. The same
 * text handed over as a tool result instead would cost a step, every time, and would still
 * end up in the transcript.
 *
 * WHAT IT DOES NOT CLAIM. It is a snapshot from session start, it lists only what fits its
 * budget, and it is derived from syntax, not from a type checker: a name here is a name that
 * was defined, not proof of what it does. The rendered header says all of this, because a
 * model that treats a stale map as ground truth is worse off than one with no map at all.
 */

/** Files parsed at most. A cap on work, not on the project: past it, the ranking simply
 * chooses from what it saw. */
const MAX_FILES = 500
/** Skipped outright — a generated bundle tells you nothing about a project's shape. */
const MAX_FILE_BYTES = 300_000
/**
 * Roughly 5k tokens of a 196k window, spent once per session and cached from then on.
 *
 * Measured on this project at 10k: 55 of 137 source files listed, 577 ms to build. The
 * number was raised from 6k after watching what it bought — at 6k the same map covered
 * barely a third as many files, and breadth is what a map is for — and again from 10k to
 * 20k for the workspaces this tool is actually used on: several folders, hundreds to
 * thousands of files, where a 10k map named one file in fifteen and the model spent its
 * first steps on `list_dir` (24 calls across the recorded sessions, one directory at a
 * time). The prefix is prewarmed when the workspace opens, so the extra 2.5k tokens cost
 * nothing at the moment a person is waiting; `prefix.mapChars` in settings.json overrides.
 */
export const DEFAULT_MAP_BUDGET = 20_000

export interface FileOutline {
  path: string
  entries: OutlineEntry[]
  /** Every identifier that appears anywhere in the file, for the reference count. */
  identifiers: Set<string>
  /**
   * Where the file lives on disk, so the source block can read its CURRENT text without a
   * second walk. Absent for an outline built by hand (tests), which the map never reads.
   */
  abs?: string
}

/**
 * Semantic reference edges, from a compiler rather than from text: `from` (workspace-relative
 * path) uses symbols that `to` defines, `weight` = how many reference sites. Same direction
 * as the textual graph in `rankByReferences` — A -> B means "A depends on B" — so the two
 * merge by addition. Harvested asynchronously (see csharp/reference-edges.ts) and consumed
 * synchronously at swap time; paths that are not in the index are ignored, so a stale
 * harvest degrades to the textual ranking instead of corrupting it.
 */
export type ReferenceEdges = ReadonlyMap<string, ReadonlyMap<string, number>>

/**
 * What one compiler-confirmed reference site is worth against textual mentions.
 *
 * A real edge usually coexists with a textual one (the name literally appears), so semantic
 * weight is a confirmation bonus, not a replacement. 2 lets ground truth win ties without
 * letting a partially-harvested graph (only the top files are queried) drown the textual
 * signal that still covers the whole repository.
 */
const SEMANTIC_EDGE_WEIGHT = 2

const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/g
const CONTAINER_KINDS = new Set(['class', 'interface', 'struct', 'record', 'enum', 'namespace'])

/**
 * Extensions listed on the map by NAME, with no outline: there is no grammar for them, but
 * their absence is a hole the model cannot see around. Their identifiers still count toward
 * the reference graph, which is how a `.xaml` view links itself to its view-model.
 */
const NAMED_ONLY = new Set(['.xaml', '.axaml', '.razor', '.cshtml', '.sql', '.sqlproj', '.csproj'])

/**
 * Which folders hold the files, and how many — the answer to the question the model spent
 * its first steps asking one `list_dir` at a time.
 *
 * A cut through the directory tree: the root's children, with the biggest of them opened
 * up into THEIR children while the listing stays short, so a workspace of two thousand
 * files reads as twenty lines of `src/frontend/src/app/ 64 (tsx 60)` rather than as one
 * line saying `src/ 881`. Counts include everything below a folder, the two commonest
 * extensions say what kind of thing lives there, and the walk's own exclusions (build
 * output, dependencies, dot-folders) apply. Deliberately not a tree: a tree of two
 * thousand files is the thing this replaces.
 */
export function summariseLayout(paths: readonly string[], maxEntries = LAYOUT_MAX_ENTRIES): string[] {
  interface Node {
    name: string
    /** Files anywhere below. */
    count: number
    /** Files directly in this folder, and what kind. */
    direct: number
    directExts: Map<string, number>
    exts: Map<string, number>
    children: Map<string, Node>
  }
  const make = (name: string): Node => ({
    name, count: 0, direct: 0, directExts: new Map(), exts: new Map(), children: new Map(),
  })
  const root = make('')
  for (const path of paths) {
    const parts = path.split('/')
    const ext = extname(path).toLowerCase().replace(/^\./, '') || '(none)'
    let node = root
    node.count++
    node.exts.set(ext, (node.exts.get(ext) ?? 0) + 1)
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i]!
      let child = node.children.get(name)
      if (child === undefined) { child = make(name); node.children.set(name, child) }
      node = child
      node.count++
      node.exts.set(ext, (node.exts.get(ext) ?? 0) + 1)
    }
    node.direct++
    node.directExts.set(ext, (node.directExts.get(ext) ?? 0) + 1)
  }
  if (root.count === 0) return []

  // The cut: start at the root's children and keep opening the largest entry that has at
  // least two sub-folders worth naming, while the listing stays within the cap.
  type Cut = { node: Node; path: string }
  const worth = (n: Node): boolean => n.count >= LAYOUT_MIN_FILES
  const cut: Cut[] = [...root.children.values()].filter(worth).map((n) => ({ node: n, path: n.name }))
  for (;;) {
    let best: number = -1
    for (const [i, entry] of cut.entries()) {
      const subs = [...entry.node.children.values()].filter(worth)
      if (subs.length < 2) continue
      if (cut.length - 1 + subs.length + (entry.node.direct > 0 ? 1 : 0) > maxEntries) continue
      if (best === -1 || entry.node.count > cut[best]!.node.count) best = i
    }
    if (best === -1) break
    const opened = cut[best]!
    const subs = [...opened.node.children.values()].filter(worth)
      .map((n) => ({ node: n, path: `${opened.path}/${n.name}` }))
    // The folder's own files stay visible as a line of their own, so `src/ (3 files here)`
    // is not lost when `src/` is opened into its sub-folders.
    const own = opened.node.direct > 0
      ? [{
        node: {
          ...opened.node, count: opened.node.direct, exts: opened.node.directExts,
          children: new Map<string, Node>(),
        },
        path: `${opened.path}/ (files directly in it)`,
      }]
      : []
    cut.splice(best, 1, ...own, ...subs)
  }

  const describe = (n: Node): string => {
    const exts = [...n.exts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2)
      .map(([e, c]) => `${e} ${c}`).join(', ')
    return exts === '' ? '' : ` (${exts})`
  }
  return cut
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((e) => e.path.endsWith('(files directly in it)')
      ? `${e.path.slice(0, -'(files directly in it)'.length).trimEnd()} ${e.node.count} directly here${describe(e.node)}`
      : `${e.path}/ ${e.node.count}${describe(e.node)}`)
}

/** Lines in a layout summary, at most — twenty-odd is a glance, sixty is a listing. */
const LAYOUT_MAX_ENTRIES = 24
/** A folder with fewer files than this is not worth a line of its own. */
const LAYOUT_MIN_FILES = 3

/** One folder's index: what was outlined, and the layout the walk saw on the way. */
export interface FolderIndex {
  files: FileOutline[]
  /** `summariseLayout` over every file the walk returned, source or not. */
  layout: string[]
}

/** Parses every supported source file in the workspace. Unreadable and unparseable files are
 * skipped: a map missing one file is useful, a map that failed to build is not. */
export async function indexWorkspace(root: string, maxFiles = MAX_FILES): Promise<FileOutline[]> {
  return (await indexFolder(root, maxFiles)).files
}

/** `indexWorkspace`, plus the layout summary of the same walk. */
export async function indexFolder(root: string, maxFiles = MAX_FILES): Promise<FolderIndex> {
  const supported = new Set(SUPPORTED_EXTENSIONS)
  const all = await walkFiles(root)
  const layout = summariseLayout(all)
  const candidates = all
    .filter((p) => supported.has(extname(p).toLowerCase()) || NAMED_ONLY.has(extname(p).toLowerCase()))
    .slice(0, maxFiles)

  const out: FileOutline[] = []
  for (const path of candidates) {
    const abs = join(root, path)
    try {
      if ((await stat(abs)).size > MAX_FILE_BYTES) continue
      const source = await readFile(abs, 'utf8')
      // No grammar, but the file still belongs on the map. A WPF window's markup is where
      // half the program lives and its code-behind means little without it — and
      // `MainWindow.xaml` was the largest file in the workspace and the most-read file in the
      // longest session, while never once appearing in the map. Its identifiers still join
      // the reference graph, so the markup is what links a view to its view-model.
      if (NAMED_ONLY.has(extname(path).toLowerCase())) {
        out.push({ path, entries: [], identifiers: new Set(source.match(IDENTIFIER) ?? []), abs })
        continue
      }
      const result = await outlineFile(abs, source)
      if ('unsupported' in result || result.length === 0) continue
      out.push({ path, entries: result, identifiers: new Set(source.match(IDENTIFIER) ?? []), abs })
    } catch {
      continue
    }
  }
  return { files: out, layout }
}

/**
 * A name so widespread it is vocabulary, not a reference.
 *
 * Above this share of files, a symbol's spread says nothing about the file that defines it.
 * The first version had no such rule and the very first entry of this project's own map was
 * a TEST file listing `validate, execute` six times — because those two names appear in
 * every tool in the codebase, so the count was enormous and meant nothing. A map whose top
 * line is noise is worse than no map, since it is read first and trusted most.
 */
const VOCABULARY_SHARE = 0.2

/**
 * Below this many files, NOTHING counts as vocabulary.
 *
 * A share is a statistic and a statistic needs a population. In a four-file project a name
 * appearing in three of them is the most central thing there, not a common word — and the
 * first version of this damping, with only a floor of 2, scored that file at zero and
 * ranked it last. Caught by the tests immediately: a rule added to fix a real defect on a
 * large repository had made the ranking useless on a small one.
 */
const MIN_FILES_FOR_VOCABULARY = 20

/** Tests are part of a project and last in a map of it: they are found from the code they
 * cover, and a 6k budget spent on them is a budget not spent on what they cover. */
const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$/i

/**
 * Orders files by how much of the project refers to them.
 *
 * Deliberately NOT "how many symbols does this file export": that measure crowns barrel
 * files and generated types, which are the least informative things in a repository. A file
 * whose names turn up in twenty others is one you need to know about; a file nobody mentions
 * can wait until someone opens it.
 *
 * It is textual, so it only ever decides the ORDER of a listing — never an answer.
 */
/** Standard damping. 20 iterations is far past convergence at this graph size. */
const DAMPING = 0.85
const PAGERANK_ITERATIONS = 20
/** How much of the restart mass goes to the focus files when there are any. The rest stays
 * spread over the repository, so a focused map is still a map and not a keyhole. */
const FOCUS_SHARE = 0.7

/**
 * Orders files by how much of the project refers to them, transitively.
 *
 * Deliberately NOT "how many symbols does this file export": that measure crowns barrel
 * files and generated types, which are the least informative things in a repository. A file
 * whose names turn up in twenty others is one you need to know about; a file nobody mentions
 * can wait until someone opens it.
 *
 * Transitively, because flat in-degree gets the second question wrong. A file referenced by
 * one file that everything else depends on matters more than a file referenced by three
 * leaves, and counting edges cannot see that. This is PageRank over a graph whose edge
 * A -> B means "A mentions a name B defines" — the technique Aider's repo map uses, whose
 * benchmarks are the external evidence that ranking is what makes a map worth its tokens.
 *
 * `focus` personalises it: restart mass concentrates on those paths, so files near the work
 * in progress rise. It is empty at session start — nothing has happened yet — and filled at
 * a compaction swap, which is the one moment we are rebuilding the system message anyway.
 * Re-ranking on every turn would be Aider's design, and here it would throw away the prompt
 * cache on every request: measured at 90 s per full re-prefill on a 43k transcript, which is
 * far more than a better-ordered map can be worth.
 *
 * Textual, so it only ever decides the ORDER of a listing — never an answer.
 */
export function rankByReferences(
  files: readonly FileOutline[], focus: readonly string[] = [],
  semanticEdges?: ReferenceEdges,
): FileOutline[] {
  // identifier -> how many files contain it at all.
  const spread = new Map<string, number>()
  for (const file of files) {
    for (const id of file.identifiers) spread.set(id, (spread.get(id) ?? 0) + 1)
  }
  const vocabularyAt = files.length < MIN_FILES_FOR_VOCABULARY
    ? Infinity
    : files.length * VOCABULARY_SHARE

  // Who defines what, ignoring names too widespread to mean anything.
  const definers = new Map<string, number[]>()
  files.forEach((file, i) => {
    for (const entry of file.entries) {
      // Depth 0 alone was a TypeScript assumption that silently emptied the graph on C#. In
      // C# the depth-0 entry is the NAMESPACE and the type sits at depth 1, so the definer
      // set was 40 namespaces sharing one name, the graph had no usable edges, PageRank
      // returned its restart vector unchanged, and the tie-break below sorted by path: the
      // "transitively ranked" map was alphabetical order on every C# repository. Measured on
      // the user's workspace before and after — 0 edges, then 108.
      if (entry.depth > 1 || entry.kind === '...') continue
      if ((spread.get(entry.name) ?? 1) >= vocabularyAt) continue
      const list = definers.get(entry.name)
      if (list === undefined) definers.set(entry.name, [i])
      else if (!list.includes(i)) list.push(i)
    }
  })

  // Outgoing edges: file i mentions a name defined in file j.
  const out: Map<number, number>[] = files.map(() => new Map<number, number>())
  files.forEach((file, i) => {
    for (const id of file.identifiers) {
      const targets = definers.get(id)
      if (targets === undefined) continue
      for (const j of targets) {
        if (j === i) continue // its own file always contains its own name
        out[i]!.set(j, (out[i]!.get(j) ?? 0) + 1)
      }
    }
  })

  // Compiler-confirmed edges join the same graph, weighted up. Path-keyed because the
  // harvest outlives no particular ranking call; anything the index does not know is
  // silently dropped — a renamed or deleted file must not crash a swap.
  if (semanticEdges !== undefined) {
    const indexOf = new Map(files.map((f, i) => [f.path, i]))
    for (const [from, tos] of semanticEdges) {
      const i = indexOf.get(from)
      if (i === undefined) continue
      for (const [to, weight] of tos) {
        const j = indexOf.get(to)
        if (j === undefined || j === i || !(weight > 0)) continue
        out[i]!.set(j, (out[i]!.get(j) ?? 0) + weight * SEMANTIC_EDGE_WEIGHT)
      }
    }
  }

  const n = files.length
  if (n === 0) return []
  const focusSet = new Set(focus)
  const focused = files.map((f) => focusSet.has(f.path))
  const focusCount = focused.filter(Boolean).length
  // The restart distribution: uniform, or tilted toward the work when there is any.
  const restart = files.map((_, i) =>
    focusCount === 0
      ? 1 / n
      : (focused[i] ? FOCUS_SHARE / focusCount : 0) + (1 - FOCUS_SHARE) / n)

  let rank = [...restart]
  for (let iter = 0; iter < PAGERANK_ITERATIONS; iter++) {
    const next = restart.map((r) => (1 - DAMPING) * r)
    let dangling = 0
    for (let i = 0; i < n; i++) {
      const edges = out[i]!
      let weight = 0
      for (const w of edges.values()) weight += w
      if (weight === 0) { dangling += rank[i]!; continue }
      for (const [j, w] of edges) next[j]! += DAMPING * rank[i]! * (w / weight)
    }
    // A file that references nothing would otherwise leak its mass out of the system.
    for (let i = 0; i < n; i++) next[i]! += DAMPING * dangling * restart[i]!
    rank = next
  }

  return files
    .map((file, i) => ({ file, score: rank[i]!, test: TEST_PATH.test(file.path) }))
    .sort((a, b) =>
      (Number(a.test) - Number(b.test)) ||
      (b.score - a.score) ||
      a.file.path.localeCompare(b.file.path))
    .map((s) => s.file)
}

/**
 * Definitions listed per file before the rest are summarised.
 *
 * Breadth beats depth in a map. This project's own `protocol.ts` defines forty type aliases
 * and, uncapped, ate most of a 6k budget by itself — leaving a map of five files where
 * twenty-five would have been more use. Knowing a file exists and roughly what it holds is
 * the job; `symbol_outline` gives the whole list for one file in one cheap call.
 */
const MAX_LINES_PER_FILE = 6
/** Members listed for one class or interface; see `renderFile`. */
const MAX_MEMBERS = 8

/**
 * One file's line in the map: its top-level definitions, with a container's own members
 * folded onto the same line rather than given a line each.
 *
 * Every name carries its line number (` :41`), and that is what turns the map from a list
 * of what exists into the ARGUMENT of the next call. Measured over the recorded sessions:
 * 285 `Read` calls against 11 `Grep` and 0 `symbol_outline`, nearly all of them
 * whole files — a 19k-character view-model read three times in one turn for edits that
 * touched one method each. A name with no line leaves the model exactly one way to reach
 * the method: read the file. A name with a line makes `Read(path, start_line,
 * end_line)` writable from the map alone, which `Read`'s own large-file answer
 * already relies on. Two tokens a name, paid once per session in the cached prefix.
 */
/**
 * The outline with its namespaces folded away, so a C# file renders like a TypeScript one.
 *
 * In C# the depth-0 entry is the NAMESPACE and every type sits at depth 1 under it, so
 * `renderFile` treating depth 0 as the file's top level printed `namespace App.Controllers
 * :17: LeadsController :22` — the namespace as the class and the class as its one member,
 * with the twenty endpoints under it invisible. Measured on a real two-folder C# workspace:
 * not one method name in a 20k-character map. The ranking learned this lesson first
 * (`rankByReferences` and its depth-1 definers); the rendering needed the same one. A
 * namespace is scaffolding, not a definition anyone opens a file for.
 */
function withoutNamespaces(entries: readonly OutlineEntry[]): OutlineEntry[] {
  const out: OutlineEntry[] = []
  // The depths of the namespaces currently open, deepest last: everything nested inside
  // them moves up by that many levels.
  const open: number[] = []
  for (const entry of entries) {
    while (open.length > 0 && entry.depth <= open[open.length - 1]!) open.pop()
    if (entry.kind === 'namespace') { open.push(entry.depth); continue }
    out.push(open.length === 0 ? entry : { ...entry, depth: entry.depth - open.length })
  }
  return out
}

export function renderFile(file: FileOutline): string {
  const lines: string[] = [file.path]
  const entries = withoutNamespaces(file.entries)
  // A file can genuinely define the same name twice at the top level -- object literals in
  // a test file produce a dozen identical `method validate` entries -- and repeating a line
  // spends budget to say nothing.
  const seen = new Set<string>()
  for (const [i, entry] of entries.entries()) {
    if (entry.depth !== 0 || entry.kind === '...') continue
    if (seen.has(`${entry.kind} ${entry.name}`)) continue
    seen.add(`${entry.kind} ${entry.name}`)
    if (!CONTAINER_KINDS.has(entry.kind)) {
      lines.push(`  ${entry.kind} ${entry.name} :${entry.line}`)
      continue
    }
    const members: string[] = []
    for (let j = i + 1; j < entries.length; j++) {
      const child = entries[j]!
      if (child.depth === 0) break
      if (child.depth === 1 && child.kind !== '...') members.push(`${child.name} :${child.line}`)
    }
    // Capped for the same reason the file list is: one class with thirty methods on one
    // line is most of a budget, and the thirtieth method name is not what tells you the
    // class is the one you want.
    const shown = members.length > MAX_MEMBERS
      ? [...members.slice(0, MAX_MEMBERS), `…+${members.length - MAX_MEMBERS}`]
      : members
    lines.push(shown.length === 0
      ? `  ${entry.kind} ${entry.name} :${entry.line}`
      : `  ${entry.kind} ${entry.name} :${entry.line}: ${shown.join(', ')}`)
  }

  const defined = lines.length - 1
  if (defined > MAX_LINES_PER_FILE) {
    const kept = lines.slice(0, MAX_LINES_PER_FILE + 1)
    kept.push(`  …and ${defined - MAX_LINES_PER_FILE} more (symbol_outline lists them all)`)
    return kept.join('\n')
  }
  return lines.join('\n')
}

/**
 * The whole block, within a character budget.
 *
 * Files are added most-referenced first and the listing stops when the budget is spent, with
 * a line saying how many were left out. Stating the omission matters: a model told "here is
 * the project" would take a truncated list as complete and conclude a file it cannot see
 * does not exist.
 */
const MAP_HEADER_HEAD =
  'PROJECT MAP\n' +
  'A snapshot of this workspace\'s structure, taken when the session started. It lists ' +
  'definitions only — not what they do — and it can be out of date, including because of ' +
  'your own edits. Use it to know where to look; '

const MAP_HEADER_TAIL = 'confirm with Read or symbol_outline before relying on it.\n'

/**
 * The one place a nudge toward `csharp_nav` is worth its tokens.
 *
 * It rides a header that is already in the prompt, and the C# clause REPLACES the general
 * one rather than being appended, so a C# workspace pays nothing extra and a workspace with
 * no .cs files pays nothing at all. That constraint is not fastidiousness: this same header
 * has named `symbol_outline` since the day it was written, and across 703 recorded tool
 * calls that tool was chosen exactly zero times. Naming a tool in the prompt has a measured
 * track record in this project, and the record is that it achieves nothing — so the version
 * of this idea that spends tokens on every turn of every session was refused, and this is
 * what was left. If it does not move the numbers either, it should be deleted rather than
 * grown.
 */
const MAP_HEADER_TAIL_CSHARP =
  'confirm with Read before relying on it — or, for how the C# in here connects, ask ' +
  'csharp_nav, which answers who calls what from the compiler rather than from this list.\n'

const mapHeader = (ranked: readonly FileOutline[]): string =>
  MAP_HEADER_HEAD +
  (ranked.some((f) => f.path.toLowerCase().endsWith('.cs'))
    ? MAP_HEADER_TAIL_CSHARP
    : MAP_HEADER_TAIL)

/** As many whole file blocks as fit. Returns what it spent so a caller splitting one budget
 * across folders can hand the remainder to the next one. */
function fitBlocks(
  ranked: readonly FileOutline[], budget: number,
): { text: string; spent: number; shown: number } {
  const blocks: string[] = []
  let spent = 0
  for (const file of ranked) {
    const block = renderFile(file)
    if (spent + block.length + 2 > budget) break
    blocks.push(block)
    spent += block.length + 2
  }
  return { text: blocks.join('\n\n'), spent, shown: blocks.length }
}

function omissionNote(omitted: number): string {
  return omitted > 0
    ? `\n\n(${omitted} more source file${omitted === 1 ? '' : 's'} are not listed here. ` +
      'Glob and Grep reach them.)'
    : ''
}

/**
 * The layout lines as a block under the header, or nothing. Kept short by construction
 * (`summariseLayout` caps its entries), so it is spent before the file blocks: knowing
 * which folders exist is worth more than the last three files that would have fitted.
 */
function layoutBlock(layout: readonly string[] | undefined): string {
  if (layout === undefined || layout.length === 0) return ''
  return `Folders (files under each, excluding build output and dependencies):\n${layout.map((l) => `  ${l}`).join('\n')}\n\n`
}

export function renderRepoMap(
  ranked: readonly FileOutline[], budget = DEFAULT_MAP_BUDGET, layout?: readonly string[],
): string {
  if (ranked.length === 0) return ''
  const header = mapHeader(ranked)
  const folders = layoutBlock(layout)
  const fitted = fitBlocks(ranked, budget - header.length - folders.length)
  if (fitted.shown === 0) return ''
  return `${header}\n${folders}${fitted.text}${omissionNote(ranked.length - fitted.shown)}`
}

/**
 * A folder gets map space in proportion to how much source it holds — but never less than
 * this, so a small folder is present rather than merely mentioned.
 */
const MIN_FOLDER_BUDGET = 1_200

/**
 * A read-only folder counts for half its size when the budget is divided.
 *
 * Not arbitrary: a reference folder is usually the biggest thing in the workspace (a whole
 * upstream project attached to be consulted) and it is the one place no edit will ever land.
 * What you need from it is "where is X", which search answers exactly; what you need from a
 * folder you are editing is the shape of the thing you are changing, which only the map gives
 * cheaply. Weighting by size alone let one attached reference push the working folders out of
 * their own map.
 */
const READ_WEIGHT = 0.5

export interface MappedFolder {
  name: string
  access: 'write' | 'read'
  ranked: readonly FileOutline[]
  /** Its layout lines, mount-prefixed. See `summariseLayout`. */
  layout?: readonly string[]
}

/**
 * One map covering several folders, each under its own heading, within one budget.
 *
 * The budget is divided by weighted file count and then spent in order, with whatever a
 * folder does not use passed to the next one — so a two-file folder cannot sit on a fifth of
 * the map, and a folder that came up short gets a second pass at the leftovers.
 */
function renderMultiRepoMap(
  folders: readonly MappedFolder[], budget = DEFAULT_MAP_BUDGET,
): string {
  const present = folders.filter((f) => f.ranked.length > 0)
  if (present.length === 0) return ''

  // Asked across every folder, not per folder: one C# folder among five is still a workspace
  // where the question "who calls this" has a better answer than reading.
  const heading = `${mapHeader(present.flatMap((f) => f.ranked))}\nThis workspace is made of ` +
    `${present.length} folders. Every path below starts with the folder it is in.\n`
  const weights = present.map((f) => f.ranked.length * (f.access === 'read' ? READ_WEIGHT : 1))
  const total = weights.reduce((a, b) => a + b, 0)
  // The separators are part of the text: one newline after the heading and a blank line
  // between sections. Small, but they are exactly the kind of thing that makes a budget an
  // approximation that drifts with the number of folders.
  const available = budget - heading.length - 1 - 2 * (present.length - 1)

  const shares = weights.map((w) => Math.max(MIN_FOLDER_BUDGET, Math.floor((available * w) / total)))
  const claimed = shares.reduce((a, b) => a + b, 0)
  // Only reachable when the floors alone oversubscribe the budget — many small folders.
  if (claimed > available) {
    for (let i = 0; i < shares.length; i++) shares[i] = Math.floor((shares[i]! * available) / claimed)
  }

  /**
   * One folder's whole section, guaranteed to fit in `allowance`, and what it actually cost.
   *
   * `spent` is the finished text's own length rather than a sum of the parts, because the
   * parts do not add up: the block loop counts a separator per block where the join writes
   * one per gap, and the "not listed here" note is not known until the loop has stopped.
   * Measured with the arithmetic version, three folders overshot a 10,000-char budget by 73.
   * The retry loop is what makes the bound hold rather than nearly hold — it converges
   * because `cap` strictly decreases.
   */
  function section(folder: MappedFolder, allowance: number): { text: string; spent: number } {
    const label = `## ${folder.name}/${folder.access === 'read' ? '   (read-only reference)' : ''}\n` +
      layoutBlock(folder.layout)
    let cap = allowance - label.length
    for (;;) {
      const fitted = fitBlocks(folder.ranked, cap)
      const note = omissionNote(folder.ranked.length - fitted.shown)
      const body = fitted.shown === 0 ? '(nothing fitted in the map for this folder)' : fitted.text
      const text = `${label}${body}${note}`
      if (text.length <= allowance || fitted.shown === 0) return { text, spent: text.length }
      cap -= text.length - allowance
    }
  }

  const sections: string[] = []
  const spentPer: number[] = []
  const truncatedFirst: number[] = []
  let leftover = 0
  for (const [i, folder] of present.entries()) {
    const rendered = section(folder, shares[i]! + leftover)
    leftover = shares[i]! + leftover - rendered.spent
    if (rendered.text.includes('not listed here')) truncatedFirst.push(i)
    spentPer.push(rendered.spent)
    sections.push(rendered.text)
  }

  // A folder later in the list finishing early leaves budget the earlier, truncated ones
  // could have used. One re-run of the first such folder spends it.
  //
  // The allowance is what that folder ACTUALLY spent plus the leftover, not its original
  // share plus the leftover: the difference is the part of its own share it failed to use,
  // which would be handed out twice and put the whole map over budget.
  const first = truncatedFirst[0]
  if (leftover > MIN_FOLDER_BUDGET / 2 && first !== undefined) {
    sections[first] = section(present[first]!, spentPer[first]! + leftover).text
  }

  return `${heading}\n${sections.join('\n\n')}`
}

/**
 * The parsed workspace, kept so the map can be re-ordered without touching the disk again.
 *
 * Indexing is the expensive half — a walk, a read and a tree-sitter parse per file, 577 ms
 * on this project and more on a real one. Ranking is arithmetic over what is already in
 * memory. Splitting them is what makes a focused re-rank affordable at all.
 */
export interface RepoIndex {
  /** One entry per mount; a single-folder workspace has one, unnamed. */
  folders: {
    name: string | null
    access: 'write' | 'read'
    files: FileOutline[]
    /** The folder's layout lines (`summariseLayout`), already carrying the mount prefix in a
     * multi-folder workspace. Absent for an index built by hand. */
    layout?: string[]
  }[]
}

/** Walks and parses. Never throws: a workspace it cannot index yields an empty index. */
export async function indexRepo(workspace: string | readonly Mount[]): Promise<RepoIndex> {
  try {
    if (typeof workspace === 'string' || workspace.length === 1) {
      const root = typeof workspace === 'string' ? workspace : workspace[0]!.root
      const { files, layout } = await indexFolder(root)
      return { folders: [{ name: null, access: 'write', files, layout }] }
    }
    const folders: RepoIndex['folders'] = []
    for (const mount of workspace) {
      const { files, layout } = await indexFolder(mount.root)
      folders.push({
        name: mount.name,
        access: mount.access,
        // Prefixed here rather than left to the section heading: a model reads one of these
        // lines and calls Read with exactly the text it saw, and a bare `src/boot.ts`
        // would be refused by the jail for not naming a folder.
        files: files.map((file) => ({
          ...file,
          path: `${mount.name}/${file.path.split(/[\\/]/).join('/')}`,
        })),
        layout: layout.map((line) => `${mount.name}/${line}`),
      })
    }
    return { folders }
  } catch {
    return { folders: [] }
  }
}

/**
 * Ranks and renders. Cheap enough to redo, which is the point.
 *
 * `focus` is the set of workspace-relative paths the session has been working in. Empty —
 * the session-start case, when nothing has happened yet — gives the plain repository
 * ordering. Supplied, it pulls the neighbourhood of the work upward without dropping the
 * rest, so what the model reads after a compaction swap is a map OF ITS TASK rather than a
 * map of the project in the abstract.
 */
export function renderIndex(
  index: RepoIndex, budget = DEFAULT_MAP_BUDGET, focus: readonly string[] = [],
  semanticEdges?: ReferenceEdges,
): string {
  try {
    if (index.folders.length === 0) return ''
    if (index.folders.length === 1 && index.folders[0]!.name === null) {
      const only = index.folders[0]!
      return renderRepoMap(rankByReferences(only.files, focus, semanticEdges), budget, only.layout)
    }
    // Semantic edges stop here on purpose: the harvest runs against one workspace root and
    // its paths are root-relative, while multi-mount files carry `name/` prefixes. Wiring
    // them through would attribute every edge to the wrong folder or to none — the textual
    // ranking, which reads the prefixed paths themselves, stays correct either way.
    // Ranked per folder, not across the whole workspace: the reference-count damping in
    // rankByReferences is calibrated against how many files it is looking at, and pooling a
    // 40-file project with a 900-file one silently retunes it for both.
    return renderMultiRepoMap(index.folders.map((f) => ({
      name: f.name ?? '',
      access: f.access,
      ranked: rankByReferences(f.files, focus),
      ...(f.layout !== undefined ? { layout: f.layout } : {}),
    })), budget)
  } catch {
    return ''
  }
}

/** Builds the map for a workspace. Never throws: a workspace it cannot index yields an empty
 * map, and a session with no map is exactly the session this feature did not exist for. */
export async function buildRepoMap(
  workspace: string | readonly Mount[], budget = DEFAULT_MAP_BUDGET,
): Promise<string> {
  return renderIndex(await indexRepo(workspace), budget)
}
