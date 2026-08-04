import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Finding a file by typing part of its name.
 *
 * Separate from `find_files`, which is the MODEL's tool and takes a glob: a person typing
 * `@stat` into the composer is not writing a pattern, they are half-remembering a name. So
 * this is subsequence matching with a ranking, and it is deliberately its own module
 * because the ranking is the part worth testing — a picker that puts the right file third
 * is a picker you stop using.
 */

/** Directories never walked. The same list `list_dir` and `find_files` refuse to enumerate,
 * for the same reason: nobody is looking for a file inside `node_modules` by name. */
const SKIP = new Set(['.git', 'node_modules', '.privatecode', 'dist', 'build', 'target', '.next', '.venv', '__pycache__'])

/** A ceiling on the walk, not on the answer. A repository with 200k files must not freeze
 * the window on every keystroke; stopping early gives a worse ranking, never a hang. */
const MAX_WALKED = 20_000

export interface FileMatch {
  path: string
  /** Higher is better. Exposed so callers can merge result sets without re-scoring. */
  score: number
}

/** Every file under `root`, relative and slash-separated, bounded by `MAX_WALKED`. */
export async function walkFiles(root: string, max = MAX_WALKED): Promise<string[]> {
  const out: string[] = []
  const queue: string[] = ['']

  while (queue.length > 0 && out.length < max) {
    const rel = queue.shift()!
    let entries
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true })
    } catch {
      continue // a directory that vanished or cannot be read is not a reason to fail a search
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.github') continue
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) queue.push(child)
      } else if (entry.isFile()) {
        out.push(child)
        if (out.length >= max) break
      }
    }
  }
  return out
}

/**
 * How well `path` answers `query`, or `null` for no match.
 *
 * The rules, in the order they matter to someone typing:
 *  - the query must appear as a subsequence, so `stt` finds `stats.ts`;
 *  - a match in the FILENAME beats one in the directory, because that is what people type;
 *  - contiguous beats scattered, so `stats` ranks `stats.ts` over `sessions-tabs.tsx`;
 *  - earlier beats later, and a shorter path breaks the remaining ties.
 */
export function scorePath(path: string, query: string): number | null {
  if (query === '') return 0
  const haystack = path.toLowerCase()
  const needle = query.toLowerCase()

  const slash = haystack.lastIndexOf('/')
  const name = haystack.slice(slash + 1)

  const inName = subsequenceScore(name, needle)
  const inPath = subsequenceScore(haystack, needle)
  if (inName === null && inPath === null) return null

  // A filename hit is worth more than the same hit in a directory, and a whole-path hit
  // still counts when the name alone does not contain the query (`host/replay`).
  const best = inName !== null ? inName + 1000 : inPath!
  return best - path.length / 100
}

/** Subsequence score, or null. Contiguity and an early start are what it rewards. */
function subsequenceScore(haystack: string, needle: string): number | null {
  let hi = 0
  let score = 0
  let run = 0
  let firstAt = -1

  for (const ch of needle) {
    const found = haystack.indexOf(ch, hi)
    if (found === -1) return null
    if (firstAt === -1) firstAt = found
    run = found === hi ? run + 1 : 0
    score += 10 + run * 15
    hi = found + 1
  }
  return score - firstAt
}

/**
 * The best `limit` matches for `query`, best first.
 *
 * An empty query returns the head of the list AS GIVEN rather than sorting it. The picker
 * opens on a bare `@`, when there is nothing to rank by — and the caller's order is
 * meaningful (the walk is breadth-first, so the shallowest files come first, which is a
 * better first screen than everything beginning with `a`).
 */
export function rankFiles(paths: readonly string[], query: string, limit = 20): FileMatch[] {
  if (query === '') return paths.slice(0, limit).map((path) => ({ path, score: 0 }))
  const scored: FileMatch[] = []
  for (const path of paths) {
    const score = scorePath(path, query)
    if (score !== null) scored.push({ path, score })
  }
  scored.sort((a, b) => (b.score - a.score) || a.path.localeCompare(b.path))
  return scored.slice(0, limit)
}
