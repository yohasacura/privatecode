export type EditOutcome =
  | { ok: true; text: string; matchedExactly: boolean }
  | { ok: false; reason: 'empty' | 'not_found' | 'ambiguous'; hint: string }

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

export function applySearchReplace(source: string, search: string, replace: string): EditOutcome {
  if (search.trim() === '') {
    return {
      ok: false,
      reason: 'empty',
      hint: 'search_text was empty or whitespace only. Quote the exact lines you want to ' +
            'change, copied from the file.',
    }
  }

  const exact = countOccurrences(source, search)
  if (exact === 1) {
    // A function replacer inserts `replace` literally. The two-argument form of String.replace
    // treats a string second argument as a replacement *pattern* and still expands $$, $&, $`
    // and $' even though `search` itself is a plain string, not a regex.
    return { ok: true, text: source.replace(search, () => replace), matchedExactly: true }
  }
  if (exact > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      hint: `search_text occurs in ${exact} places. Include more surrounding lines so it ` +
            `identifies exactly one.`,
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
    const text = [...before, ...replace.split('\n'), ...after].join('\n')
    return { ok: true, text, matchedExactly: false }
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      hint: `search_text matches ${candidates.length} places once whitespace is ignored. ` +
            `Include more surrounding lines.`,
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
  const hint = best.index >= 0 && best.score > 0.2
    ? `search_text was not found. The closest match in the file starts at line ${best.index + 1}: ` +
      `${JSON.stringify(best.window)}. Copy the text verbatim from the file.`
    : `search_text was not found anywhere in the file. Read the file again before editing.`
  return { ok: false, reason: 'not_found', hint }
}
