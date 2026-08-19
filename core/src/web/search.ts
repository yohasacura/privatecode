import { parseHTML } from 'linkedom'

/**
 * Web search over the HTML endpoints of DuckDuckGo and Bing — the no-JS faces both
 * engines keep for old browsers.
 *
 * Deliberately NOT a browser and NOT an API: a rendered results page snapshot is
 * thousands of tokens of chrome around ten links (context is the scarcest resource in
 * this system), and an API means a key, an account and a bill — all three ruled out by
 * the owner in as many words. The HTML endpoint is the wire format of search: one HTTP
 * request, a stable layout that has outlived years of frontend rewrites, and a result
 * list that parses into title/url/snippet.
 *
 * DDG first, Bing as the fallback: DDG's endpoint exists FOR machine-adjacent use and
 * blocks least; when it rate-limits (a captcha page parses as zero results), Bing's
 * `b_algo` list answers the same question.
 */

export interface SearchHit {
  title: string
  url: string
  snippet: string
}

/** Results handed to the model per search. Eight is a screenful of leads; more is noise
 * that competes with the pages themselves for context. */
const MAX_HITS = 8

const FETCH_TIMEOUT_MS = 15_000

/** A real browser's header set. The endpoints serve plain HTML to anything, but an
 * empty UA is the one thing that reads as a bot everywhere. */
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8',
}

/** DDG wraps every result href in a redirect: `//duckduckgo.com/l/?uddg=<encoded>`.
 * The real URL is the `uddg` parameter; a href that is not a redirect passes through. */
export function unwrapDdgHref(href: string): string {
  try {
    const url = new URL(href, 'https://duckduckgo.com')
    if (url.hostname.endsWith('duckduckgo.com') && url.pathname.startsWith('/l/')) {
      const real = url.searchParams.get('uddg')
      if (real !== null && real !== '') return real
    }
    return url.href
  } catch {
    return href
  }
}

/** The DDG results page, parsed. Exported for tests — fixtures in, hits out, no network. */
export function parseDdgResults(html: string): SearchHit[] {
  const { document } = parseHTML(html)
  const hits: SearchHit[] = []
  for (const result of document.querySelectorAll('.result')) {
    // Sponsored blocks wear `result--ad`; the model asked for answers, not ads.
    if (result.className.includes('result--ad')) continue
    const link = result.querySelector('.result__a')
    if (link === null) continue
    const href = link.getAttribute('href') ?? ''
    const title = link.textContent?.trim() ?? ''
    if (href === '' || title === '') continue
    const snippet = result.querySelector('.result__snippet')?.textContent?.trim() ?? ''
    hits.push({ title, url: unwrapDdgHref(href), snippet })
    if (hits.length >= MAX_HITS) break
  }
  return hits
}

/** The Bing results page, parsed. Same contract as `parseDdgResults`. */
export function parseBingResults(html: string): SearchHit[] {
  const { document } = parseHTML(html)
  const hits: SearchHit[] = []
  for (const result of document.querySelectorAll('li.b_algo')) {
    const link = result.querySelector('h2 a')
    if (link === null) continue
    const href = link.getAttribute('href') ?? ''
    const title = link.textContent?.trim() ?? ''
    if (href === '' || title === '') continue
    const snippet = result.querySelector('.b_caption p, p')?.textContent?.trim() ?? ''
    hits.push({ title, url: href, snippet })
    if (hits.length >= MAX_HITS) break
  }
  return hits
}

async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  const response = await fetch(url, {
    headers: HEADERS,
    redirect: 'follow',
    signal: signal !== undefined ? AbortSignal.any([signal, timeout]) : timeout,
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.text()
}

/**
 * One search, both engines if it comes to that. Returns the hits and which engine
 * answered; throws only when BOTH engines failed to produce anything — the caller turns
 * that into an honest tool failure rather than an empty success.
 */
export async function webSearch(
  query: string, signal?: AbortSignal,
): Promise<{ hits: SearchHit[]; engine: 'duckduckgo' | 'bing' }> {
  const q = encodeURIComponent(query)
  let ddgError = ''
  try {
    const hits = parseDdgResults(await fetchText(`https://html.duckduckgo.com/html/?q=${q}`, signal))
    if (hits.length > 0) return { hits, engine: 'duckduckgo' }
    ddgError = 'no results parsed (rate-limited, or the query genuinely matches nothing)'
  } catch (e) {
    ddgError = (e as Error).message
  }
  try {
    const hits = parseBingResults(await fetchText(`https://www.bing.com/search?q=${q}`, signal))
    if (hits.length > 0) return { hits, engine: 'bing' }
    throw new Error('no results parsed')
  } catch (e) {
    throw new Error(
      `search failed on both engines — DuckDuckGo: ${ddgError}; Bing: ${(e as Error).message}`,
    )
  }
}

/** The model-facing rendering: numbered, compact, one lead per block. */
export function renderHits(hits: SearchHit[], engine: string): string {
  const lines = hits.map((h, i) =>
    `${i + 1}. ${h.title}\n   ${h.url}${h.snippet !== '' ? `\n   ${h.snippet}` : ''}`)
  return `${lines.join('\n')}\n\n(${hits.length} results via ${engine}; ` +
    'open one with action="read")'
}
