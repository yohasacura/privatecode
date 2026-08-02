export type EditOutcome =
  | { ok: true; text: string; matchedExactly: boolean }
  | { ok: false; reason: 'empty' | 'not_found' | 'ambiguous'; hint: string }

function countOccurrences(haystack: string, needle: string): number {
  let n = 0
  let i = haystack.indexOf(needle)
  while (i !== -1) {
    n++
    i = haystack.indexOf(needle, i + needle.length)
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
    return { ok: true, text: source.replace(search, replace), matchedExactly: true }
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

  // Not found: point at the most similar line so the retry is cheap.
  let best = { line: '', score: 0, index: -1 }
  const firstSearchLine = search.split('\n')[0] ?? ''
  lines.forEach((line, index) => {
    const score = similarity(normalise(firstSearchLine), normalise(line))
    if (score > best.score) best = { line, score, index }
  })
  const hint = best.index >= 0 && best.score > 0.2
    ? `search_text was not found. The closest line in the file is line ${best.index + 1}: ` +
      `${JSON.stringify(best.line)}. Copy the text verbatim from the file.`
    : `search_text was not found anywhere in the file. Read the file again before editing.`
  return { ok: false, reason: 'not_found', hint }
}
