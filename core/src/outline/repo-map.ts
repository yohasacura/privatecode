import { readFile, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { walkFiles } from '../host/file-search.js'
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

/** Parses every supported source file in the workspace. Unreadable and unparseable files are
 * skipped: a map missing one file is useful, a map that failed to build is not. */
export async function indexWorkspace(root: string, maxFiles = MAX_FILES): Promise<FileOutline[]> {
  const supported = new Set(SUPPORTED_EXTENSIONS)
  const candidates = (await walkFiles(root))
    .filter((p) => supported.has(extname(p).toLowerCase()))
    .slice(0, maxFiles)

  const out: FileOutline[] = []
  for (const path of candidates) {
    const abs = join(root, path)
    try {
      if ((await stat(abs)).size > MAX_FILE_BYTES) continue
      const source = await readFile(abs, 'utf8')
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
export function rankByReferences(files: readonly FileOutline[]): FileOutline[] {
  // identifier -> how many files contain it at all.
  const spread = new Map<string, number>()
  for (const file of files) {
    for (const id of file.identifiers) spread.set(id, (spread.get(id) ?? 0) + 1)
  }
  const vocabularyAt = files.length < MIN_FILES_FOR_VOCABULARY
    ? Infinity
    : files.length * VOCABULARY_SHARE

  const score = (file: FileOutline): number => {
    let total = 0
    for (const entry of file.entries) {
      if (entry.depth !== 0 || entry.kind === '...') continue
      const seen = spread.get(entry.name) ?? 1
      if (seen >= vocabularyAt) continue
      // Minus one: its own file always contains its own name, and that is not a reference.
      total += Math.max(0, seen - 1)
    }
    return total
  }

  return [...files]
    .map((file) => ({ file, score: score(file), test: TEST_PATH.test(file.path) }))
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
export function renderRepoMap(ranked: readonly FileOutline[], budget = DEFAULT_MAP_BUDGET): string {
  if (ranked.length === 0) return ''

  const header =
    'PROJECT MAP\n' +
    'A snapshot of this workspace\'s structure, taken when the session started. It lists ' +
    'definitions only — not what they do — and it can be out of date, including because of ' +
    'your own edits. Use it to know where to look; confirm with read_file or symbol_outline ' +
    'before relying on it.\n'

  const blocks: string[] = []
  let spent = header.length
  let shown = 0
  for (const file of ranked) {
    const block = renderFile(file)
    if (spent + block.length + 2 > budget) break
    blocks.push(block)
    spent += block.length + 2
    shown++
  }

  if (shown === 0) return ''
  const omitted = ranked.length - shown
  const footer = omitted > 0
    ? `\n\n(${omitted} more source file${omitted === 1 ? '' : 's'} are not listed here. ` +
      'find_files and search_code reach them.)'
    : ''
  return `${header}\n${blocks.join('\n\n')}${footer}`
}

/** Builds the map for a workspace. Never throws: a workspace it cannot index yields an empty
 * map, and a session with no map is exactly the session this feature did not exist for. */
export async function buildRepoMap(root: string, budget = DEFAULT_MAP_BUDGET): Promise<string> {
  try {
    return renderRepoMap(rankByReferences(await indexWorkspace(root)), budget)
  } catch {
    return ''
  }
}
