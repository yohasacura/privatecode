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
 * Roughly 2.5k tokens of a 131k window, spent once per session and cached from then on.
 *
 * Measured on this project at that budget: 55 of 137 source files listed, 577 ms to build.
 * The number was raised from 6k after watching what it bought — at 6k the same map covered
 * barely a third as many files, and breadth is what a map is for.
 */
export const DEFAULT_MAP_BUDGET = 10_000

export interface FileOutline {
  path: string
  entries: OutlineEntry[]
  /** Every identifier that appears anywhere in the file, for the reference count. */
  identifiers: Set<string>
}

const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/g
const CONTAINER_KINDS = new Set(['class', 'interface', 'struct', 'record', 'enum', 'namespace'])

/**
 * Extensions listed on the map by NAME, with no outline: there is no grammar for them, but
 * their absence is a hole the model cannot see around. Their identifiers still count toward
 * the reference graph, which is how a `.xaml` view links itself to its view-model.
 */
const NAMED_ONLY = new Set(['.xaml', '.axaml', '.razor', '.cshtml', '.sql', '.sqlproj', '.csproj'])

/** Parses every supported source file in the workspace. Unreadable and unparseable files are
 * skipped: a map missing one file is useful, a map that failed to build is not. */
export async function indexWorkspace(root: string, maxFiles = MAX_FILES): Promise<FileOutline[]> {
  const supported = new Set(SUPPORTED_EXTENSIONS)
  const all = await walkFiles(root)
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
        out.push({ path, entries: [], identifiers: new Set(source.match(IDENTIFIER) ?? []) })
        continue
      }
      const result = await outlineFile(abs, source)
      if ('unsupported' in result || result.length === 0) continue
      out.push({ path, entries: result, identifiers: new Set(source.match(IDENTIFIER) ?? []) })
    } catch {
      continue
    }
  }
  return out
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

/** One file's line in the map: its top-level definitions, with a container's own members
 * folded onto the same line rather than given a line each. */
export function renderFile(file: FileOutline): string {
  const lines: string[] = [file.path]
  // A file can genuinely define the same name twice at the top level -- object literals in
  // a test file produce a dozen identical `method validate` entries -- and repeating a line
  // spends budget to say nothing.
  const seen = new Set<string>()
  for (const [i, entry] of file.entries.entries()) {
    if (entry.depth !== 0 || entry.kind === '...') continue
    if (seen.has(`${entry.kind} ${entry.name}`)) continue
    seen.add(`${entry.kind} ${entry.name}`)
    if (!CONTAINER_KINDS.has(entry.kind)) {
      lines.push(`  ${entry.kind} ${entry.name}`)
      continue
    }
    const members: string[] = []
    for (let j = i + 1; j < file.entries.length; j++) {
      const child = file.entries[j]!
      if (child.depth === 0) break
      if (child.depth === 1 && child.kind !== '...') members.push(child.name)
    }
    // Capped for the same reason the file list is: one class with thirty methods on one
    // line is most of a budget, and the thirtieth method name is not what tells you the
    // class is the one you want.
    const shown = members.length > MAX_MEMBERS
      ? [...members.slice(0, MAX_MEMBERS), `…+${members.length - MAX_MEMBERS}`]
      : members
    lines.push(shown.length === 0
      ? `  ${entry.kind} ${entry.name}`
      : `  ${entry.kind} ${entry.name}: ${shown.join(', ')}`)
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

const MAP_HEADER_TAIL = 'confirm with read_file or symbol_outline before relying on it.\n'

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
  'confirm with read_file before relying on it — or, for how the C# in here connects, ask ' +
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
      'find_files and search_code reach them.)'
    : ''
}

export function renderRepoMap(ranked: readonly FileOutline[], budget = DEFAULT_MAP_BUDGET): string {
  if (ranked.length === 0) return ''
  const header = mapHeader(ranked)
  const fitted = fitBlocks(ranked, budget - header.length)
  if (fitted.shown === 0) return ''
  return `${header}\n${fitted.text}${omissionNote(ranked.length - fitted.shown)}`
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
}

/**
 * One map covering several folders, each under its own heading, within one budget.
 *
 * The budget is divided by weighted file count and then spent in order, with whatever a
 * folder does not use passed to the next one — so a two-file folder cannot sit on a fifth of
 * the map, and a folder that came up short gets a second pass at the leftovers.
 */
export function renderMultiRepoMap(
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
    const label = `## ${folder.name}/${folder.access === 'read' ? '   (read-only reference)' : ''}\n`
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
  folders: { name: string | null; access: 'write' | 'read'; files: FileOutline[] }[]
}

/** Walks and parses. Never throws: a workspace it cannot index yields an empty index. */
export async function indexRepo(workspace: string | readonly Mount[]): Promise<RepoIndex> {
  try {
    if (typeof workspace === 'string' || workspace.length === 1) {
      const root = typeof workspace === 'string' ? workspace : workspace[0]!.root
      return { folders: [{ name: null, access: 'write', files: await indexWorkspace(root) }] }
    }
    const folders: RepoIndex['folders'] = []
    for (const mount of workspace) {
      folders.push({
        name: mount.name,
        access: mount.access,
        // Prefixed here rather than left to the section heading: a model reads one of these
        // lines and calls read_file with exactly the text it saw, and a bare `src/boot.ts`
        // would be refused by the jail for not naming a folder.
        files: (await indexWorkspace(mount.root)).map((file) => ({
          ...file,
          path: `${mount.name}/${file.path.split(/[\\/]/).join('/')}`,
        })),
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
): string {
  try {
    if (index.folders.length === 0) return ''
    if (index.folders.length === 1 && index.folders[0]!.name === null) {
      return renderRepoMap(rankByReferences(index.folders[0]!.files, focus), budget)
    }
    // Ranked per folder, not across the whole workspace: the reference-count damping in
    // rankByReferences is calibrated against how many files it is looking at, and pooling a
    // 40-file project with a 900-file one silently retunes it for both.
    return renderMultiRepoMap(index.folders.map((f) => ({
      name: f.name ?? '',
      access: f.access,
      ranked: rankByReferences(f.files, focus),
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
