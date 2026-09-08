export type EditOutcome =
  | { ok: true; text: string; matchedExactly: boolean; /** How many places changed: 1, or every occurrence under `all`. */ replaced: number }
  | { ok: false; reason: 'empty' | 'not_found' | 'ambiguous'; hint: string }

/** How many places an ambiguous anchor is reported at before the list is cut. */
const MAX_LISTED_PLACES = 8

/** 1-based line numbers of every exact occurrence, for the ambiguity hint. */
function linesOf(source: string, needle: string): number[] {
  const out: number[] = []
  let i = source.indexOf(needle)
  while (i !== -1) {
    out.push(source.slice(0, i).split('\n').length)
    i = source.indexOf(needle, i + 1)
  }
  return out
}

function listPlaces(lines: number[]): string {
  const shown = lines.slice(0, MAX_LISTED_PLACES).join(', ')
  return lines.length > MAX_LISTED_PLACES ? `lines ${shown}, …` : `line${lines.length === 1 ? '' : 's'} ${shown}`
}

/**
 * Where the anchor and the closest window first part ways, line by line and ignoring
 * whitespace — the one fact that makes the retry a copy rather than a second guess. Null
 * when the two agree on every line (a length mismatch, then) or the window is empty.
 */
function firstDifference(search: string, window: string): { line: number; wrote: string; has: string } | null {
  const norm = (s: string): string => s.replace(/[ \t]+/g, ' ').trim()
  const a = search.split('\n')
  const b = window.split('\n')
  const clip = (s: string): string => (s.length > 120 ? `${s.slice(0, 119)}…` : s)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const wrote = a[i]
    const has = b[i]
    if (wrote === undefined || has === undefined) return null
    if (norm(wrote) !== norm(has)) return { line: i + 1, wrote: clip(wrote.trim()), has: clip(has.trim()) }
  }
  return null
}

/** Counts overlapping occurrences too, so a self-overlapping anchor (`==` inside `===`) isn't undercounted. */
function countOccurrences(haystack: string, needle: string): number {
  let n = 0
  let i = haystack.indexOf(needle)
  while (i !== -1) {
    n++
    i = haystack.indexOf(needle, i + 1)
  }
  return n
}

/** The leading whitespace of a line, or '' when it has none. */
function indentOf(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? ''
}

/**
 * The replacement's lines, shifted so they sit at the indentation the FILE had.
 *
 * Only reached from the whitespace-tolerant fallback, which by definition matched a window
 * whose indentation differs from what the model wrote. The shift is computed once, from the
 * first line of each side, and applied to every line — so the replacement's INTERNAL
 * structure (a nested block, a continued expression) is preserved and only the block as a
 * whole moves. A line that cannot absorb the shift because it has less indentation than the
 * amount being removed is left alone rather than mangled.
 *
 * Blank lines stay blank: trailing whitespace on an empty line is not indentation, and
 * adding some is how a diff acquires noise nobody asked for.
 */
function reindent(replace: string, matchedFirstLine: string): string[] {
  const lines = replace.split('\n')
  const want = indentOf(matchedFirstLine)
  // The first NON-BLANK line, not `lines[0]`. A replacement that opens with a newline makes
  // `lines[0]` the empty string, whose indent is '' -- which sent every line down the
  // `had === ''` branch below and prepended the file's indent to lines that already carried
  // their own. Measured: a correctly-indented 4-space replacement came back at 8 spaces with
  // `ok:true`, and python then refused the file with "IndentationError: unindent does not
  // match any outer indentation level". A blank line carries no indentation information and
  // must not be asked for any.
  const anchor = lines.find((line) => line.trim() !== '')
  if (anchor === undefined) return lines
  const had = indentOf(anchor)
  if (want === had) return lines
  return lines.map((line) => {
    if (line.trim() === '') return ''
    if (had !== '' && line.startsWith(had)) return want + line.slice(had.length)
    if (had === '') return want + line
    // Less indentation than the block's own first line: keep it as written rather than
    // guessing, which is the direction that cannot corrupt anything.
    return line
  })
}

/** Collapses runs of whitespace so indentation drift cannot break an otherwise good anchor. */
function normalise(s: string): string {
  return s.replace(/[ \t]+/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').trim()
}

/** Cheap similarity for the not-found hint: fraction of shared trigrams. */
function similarity(a: string, b: string): number {
  const grams = (s: string) => {
    const out = new Set<string>()
    for (let i = 0; i < s.length - 2; i++) out.add(s.slice(i, i + 3))
    return out
  }
  const A = grams(a), B = grams(b)
  if (A.size === 0 || B.size === 0) return 0
  let shared = 0
  for (const g of A) if (B.has(g)) shared++
  return shared / Math.max(A.size, B.size)
}

export function applySearchReplace(
  source: string, search: string, replace: string,
  /** `all`: change every exact occurrence — a rename — instead of requiring one. */
  opts: { all?: boolean } = {},
): EditOutcome {
  if (search.trim() === '') {
    return {
      ok: false,
      reason: 'empty',
      hint: 'search_text was empty or whitespace only. Quote the exact lines you want to ' +
            'change, copied from the file.',
    }
  }

  const exact = countOccurrences(source, search)
  if (opts.all === true && exact >= 1) {
    // Exact occurrences only: a rename applied through the whitespace-tolerant matcher
    // would re-indent every block it touched, and "every place that roughly looks like
    // this" is not what anyone asked for.
    const places = linesOf(source, search)
    return { ok: true, text: source.split(search).join(replace), matchedExactly: true, replaced: places.length }
  }
  if (exact === 1) {
    // A function replacer inserts `replace` literally. The two-argument form of String.replace
    // treats a string second argument as a replacement *pattern* and still expands $$, $&, $`
    // and $' even though `search` itself is a plain string, not a regex.
    return { ok: true, text: source.replace(search, () => replace), matchedExactly: true, replaced: 1 }
  }
  if (exact > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      hint: `search_text occurs in ${exact} places (${listPlaces(linesOf(source, search))}). Include more ` +
            'surrounding lines so it identifies exactly one, or set replace_all to change every occurrence.',
    }
  }

  // Fallback: match ignoring indentation and internal whitespace runs.
  const normSearch = normalise(search)
  const lines = source.split('\n')
  const searchLineCount = search.split('\n').length
  const candidates: number[] = []
  for (let i = 0; i + searchLineCount <= lines.length; i++) {
    const window = lines.slice(i, i + searchLineCount).join('\n')
    if (normalise(window) === normSearch) candidates.push(i)
  }
  if (candidates.length === 1) {
    const start = candidates[0]!
    const before = lines.slice(0, start)
    const after = lines.slice(start + searchLineCount)
    // The FILE's indentation wins, not the model's.
    //
    // This branch is entered precisely because the model's whitespace did not match the
    // file's, so its replacement's indentation is the half we already know is wrong — and
    // writing it back verbatim re-indents the block. In C# or TypeScript that is cosmetic;
    // in Python or YAML it changes what the code means, and it lands exactly when the model
    // was least sure about layout. The fix is to re-anchor the replacement onto the leading
    // whitespace the matched window actually had.
    const text = [...before, ...reindent(replace, lines[start] ?? ''), ...after].join('\n')
    return { ok: true, text, matchedExactly: false, replaced: 1 }
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      hint: `search_text matches ${candidates.length} places once whitespace is ignored ` +
            `(${listPlaces(candidates.map((i) => i + 1))}). Include more surrounding lines.`,
    }
  }

  // Not found: point at the most similar window so the retry is cheap. Score against the
  // same multi-line window shape as the whitespace-tolerant matcher above (not just the
  // anchor's first line) so two blocks sharing an identical opener don't tie and hide which
  // block the near-miss is actually in.
  const windowSize = Math.max(1, Math.min(searchLineCount, lines.length))
  let best = { window: '', score: 0, index: -1 }
  for (let i = 0; i + windowSize <= lines.length; i++) {
    const window = lines.slice(i, i + windowSize).join('\n')
    const score = similarity(normSearch, normalise(window))
    if (score > best.score) best = { window, score, index: i }
  }
  // The closest window, and WHERE it differs: "line 3 of your anchor says X, the file has Y"
  // turns the retry into a copy. Measured on the sessions this tool ran in: every not-found
  // was retried, and every retry after the closest-match hint succeeded — this makes the
  // first retry the right one rather than the second.
  const diff = best.index >= 0 ? firstDifference(search, best.window) : null
  const hint = best.index >= 0 && best.score > 0.2
    ? `search_text was not found. The closest match in the file starts at line ${best.index + 1}: ` +
      `${JSON.stringify(best.window)}.` +
      (diff !== null
        ? ` It differs at line ${diff.line} of your anchor: you wrote ${JSON.stringify(diff.wrote)}, the file has ${JSON.stringify(diff.has)}.`
        : ` Your anchor has ${searchLineCount} line${searchLineCount === 1 ? '' : 's'}; the match ends there.`) +
      ' Copy the text verbatim from the file.'
    : `search_text was not found anywhere in the file. Read the file again before editing.`
  return { ok: false, reason: 'not_found', hint }
}
