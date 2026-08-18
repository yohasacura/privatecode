import { navProcess, toWorkspacePath } from './nav-process.js'
import { rankByReferences, type FileOutline, type ReferenceEdges, type RepoIndex } from '../outline/repo-map.js'

/** The two questions the harvest asks, as a shape rather than the class: what a test fakes
 * and what `NavProcess` structurally is. */
export interface NavAsker {
  ensureLoaded(root: string): Promise<Record<string, unknown>>
  ask(op: string, params: Record<string, unknown>): Promise<Record<string, unknown>>
}

/**
 * File-level reference edges from the Roslyn helper, for the repo-map rerank.
 *
 * The textual graph in `rankByReferences` sees that a NAME appears in a file; the compiler
 * sees that the SYMBOL is used. On C# repositories the difference is exactly the files the
 * map exists to surface: DI registrations, interface implementations behind a factory, a
 * view-model reached only through markup. This harvest asks `references` for the types the
 * outline already found and turns the answers into file -> file edges the ranker can add
 * to its graph.
 *
 * Async on purpose, and NEVER on the swap path. The rerank callback is synchronous inside
 * `buildSwapTranscript` — shared by the swap and its prewarm, which must agree — while a
 * helper question is a process round trip that can take seconds. So the host kicks this off
 * in the background once the index exists, keeps the result, and the swap-time rerank reads
 * whatever has been gathered by then. A swap before the harvest lands ranks exactly as it
 * does today; nothing here is allowed to make a swap slower or fail it.
 *
 * Frozen at harvest time, like the outline index it is built from: `RepoIndex` is walked
 * once per workspace load, and edges that described the code at the same moment are
 * consistent with the map they reorder. (Ordering tolerates staleness; answers would not.)
 *
 * Bounded everywhere. Symbols per file, symbols in total, rows per question and one overall
 * deadline — a 1468-file backend at 0.2-4.5 s per question could otherwise keep the helper
 * busy for ten minutes to reorder a listing. Whatever is gathered when the deadline hits is
 * the harvest.
 */

/** Types asked about per file. Top-level types carry the file's identity; asking about
 * every private helper as well would triple the questions for edges the first few already
 * imply. */
const MAX_SYMBOLS_PER_FILE = 3
/** Questions in total. At the measured 0.2-4.5 s per answer this bounds the harvest to
 * roughly half a minute of helper time on a big project. */
const MAX_SYMBOLS = 60
/** Reference rows per question — the tool's own validated ceiling, taken whole: a capped
 * row set truncates edge WEIGHT, never which files get edges first. */
const ROW_LIMIT = 200
/** The whole harvest gives up past this, keeping what it has. */
const DEADLINE_MS = 120_000

/** Kinds whose references say something about the FILE. A namespace is defined everywhere
 * and an `...` entry is the outline saying "more of the same". */
const SYMBOL_KINDS = new Set(['class', 'interface', 'struct', 'record', 'enum'])

/**
 * Harvests reference edges for a single-folder workspace, or null when there is nothing to
 * harvest: no helper in this build, a multi-mount workspace (the map renders those per
 * folder with prefixed paths the harvest cannot address), or an index with no C# in it.
 *
 * `nav` is injectable for tests; the default is the shared helper process.
 */
export async function harvestReferenceEdges(
  root: string,
  index: RepoIndex,
  nav: NavAsker | null = navProcess(),
  deadlineMs = DEADLINE_MS,
): Promise<ReferenceEdges | null> {
  try {
    if (nav === null) return null
    if (index.folders.length !== 1 || index.folders[0]!.name !== null) return null
    const files = index.folders[0]!.files
    const csFiles = files.filter((f) => f.path.toLowerCase().endsWith('.cs'))
    if (csFiles.length === 0) return null

    const loaded = await nav.ensureLoaded(root)
    if (loaded['ok'] !== true) return null

    // Question order = map order: the textual ranking already knows which files matter,
    // and a deadline that cuts the harvest short should cut the LEAST important files.
    const candidates = collectSymbols(rankByReferences(files).filter((f) => csFiles.includes(f)))

    const started = Date.now()
    const edges = new Map<string, Map<string, number>>()
    let asked = 0
    for (const { symbol, definedIn } of candidates) {
      if (asked >= MAX_SYMBOLS || Date.now() - started > deadlineMs) break
      asked++
      let reply: Record<string, unknown>
      try {
        reply = await nav.ask('references', { symbol, limit: ROW_LIMIT })
      } catch {
        // One dead question is one missing symbol, not a lost harvest — but a helper that
        // died mid-run fails every question after it instantly; the deadline check above
        // is what keeps that from looping through the whole candidate list.
        continue
      }
      if (reply['ok'] !== true) continue
      const rows = Array.isArray(reply['results']) ? reply['results'] as Record<string, unknown>[] : []
      for (const row of rows) {
        const abs = row['file']
        if (typeof abs !== 'string') continue
        const from = toWorkspacePath(abs, root)
        if (from === definedIn) continue // a file always references its own types
        const tos = edges.get(from) ?? new Map<string, number>()
        tos.set(definedIn, (tos.get(definedIn) ?? 0) + 1)
        edges.set(from, tos)
      }
    }
    return edges.size > 0 ? edges : null
  } catch {
    return null
  }
}

/**
 * The types worth asking about, in map order, each attributed to the ONE file that defines
 * it — a name two files define cannot say which of them a reference row belongs to, so it
 * is skipped rather than guessed about.
 *
 * Ambiguity is judged against EVERY entry of every file — any kind, any depth, past every
 * cap — because that is the universe the helper resolves in: `references` matches source
 * declarations by simple name wherever they sit, so a name this scan declared unique while
 * a fourth type, a nested class or a mere property elsewhere shares it would have its rows
 * silently credited to the wrong file. The asking caps limit only what is ASKED, never what
 * disqualifies. (An outline truncated with `...` entries can still hide a declaration; that
 * residue is accepted — the alternative is reading every file again.)
 */
function collectSymbols(
  ranked: readonly FileOutline[],
): { symbol: string; definedIn: string }[] {
  const declaredIn = new Map<string, string | null>() // null = ambiguous, do not ask
  for (const file of ranked) {
    for (const entry of file.entries) {
      if (entry.kind === '...') continue
      const prev = declaredIn.get(entry.name)
      declaredIn.set(entry.name, prev === undefined || prev === file.path ? file.path : null)
    }
  }
  const out: { symbol: string; definedIn: string }[] = []
  const taken = new Set<string>()
  for (const file of ranked) {
    let fromThisFile = 0
    for (const entry of file.entries) {
      if (fromThisFile >= MAX_SYMBOLS_PER_FILE) break
      // Depth <= 1 for the same reason the ranker's definer scan reads: in C# depth 0 is
      // the namespace and the type lives at depth 1.
      if (entry.depth > 1 || !SYMBOL_KINDS.has(entry.kind)) continue
      if (declaredIn.get(entry.name) !== file.path || taken.has(entry.name)) continue
      taken.add(entry.name)
      out.push({ symbol: entry.name, definedIn: file.path })
      fromThisFile++
    }
  }
  return out
}
