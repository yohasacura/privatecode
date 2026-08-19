import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'

/**
 * URL → readable text, the cheap way first.
 *
 * A plain fetch plus Firefox's own Reader Mode engine (@mozilla/readability) turns most
 * articles, docs pages and answers into clean prose for a fraction of a browser's cost —
 * no process, no window, ~200 ms. The escalation for pages that ship as a JavaScript
 * shell lives in the TOOL, not here: it needs the headless browser off the toolset, and
 * this module stays pure enough to test on canned HTML.
 */

export interface ReadResult {
  title: string
  text: string
  /** True when the static HTML looks like a JS shell — almost no readable text inside a
   * large document. The tool escalates those to the headless browser. */
  jsShell: boolean
}

const FETCH_TIMEOUT_MS = 20_000

/** Below this many characters of extracted text, a large HTML document is presumed to be
 * a script shell that renders client-side. Small documents are exempt: a 404 page or a
 * tiny plain page is legitimately short. */
const SHELL_TEXT_CHARS = 400
const SHELL_HTML_CHARS = 5_000

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8',
}

/** Collapse the whitespace an HTML-to-text pass leaves behind without flattening
 * paragraph structure: runs of blank lines become one, intra-line runs become a space. */
function tidy(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * The extraction itself, network-free for tests: HTML in, article out. Readability
 * first; when it declines (it refuses pages that do not look like articles at all), the
 * body's text content is the honest fallback — a link hub or an index page has no
 * "article" to find, but its text is still the page.
 */
export function extractReadable(html: string, url: string): ReadResult {
  const { document } = parseHTML(html)
  let title = document.querySelector('title')?.textContent?.trim() ?? ''
  let text = ''
  try {
    // Readability MUTATES the DOM it is given; it already has its own copy semantics
    // problem — so it gets its own parse, and the outer document stays pristine for the
    // fallback below.
    const article = new Readability(parseHTML(html).document as unknown as Document).parse()
    if (article !== null) {
      if (typeof article.title === 'string' && article.title.trim() !== '') title = article.title.trim()
      text = tidy(article.textContent ?? '')
    }
  } catch { /* Readability giving up is the fallback's cue, not an error */ }
  if (text === '') {
    for (const kill of document.querySelectorAll('script, style, noscript, svg')) kill.remove()
    text = tidy(document.body?.textContent ?? '')
  }
  const jsShell = html.length >= SHELL_HTML_CHARS && text.length < SHELL_TEXT_CHARS
  return { title: title === '' ? url : title, text, jsShell }
}

export interface FetchedPage {
  kind: 'html' | 'text'
  body: string
  contentType: string
  /** Where the request actually LANDED after redirects — the honest URL for the output. */
  finalUrl: string
  /** True when the body was cut at the byte cap; the caller announces it, never hides it. */
  truncated: boolean
}

/** Bytes read from a response before the tail is dropped. Time already had a budget;
 * memory needs one too — `response.text()` on a model-chosen URL was an unbounded
 * allocation. Four megabytes is dozens of times the largest article worth reading. */
export const MAX_BODY_BYTES = 4_000_000
const MAX_REDIRECTS = 5

/** Loopback, RFC1918, link-local, and the localhost name family. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0' || h === '::1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (m === null) return false
  const a = Number(m[1])
  const b = Number(m[2])
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 169 && b === 254)
}

/**
 * Whether a redirect hop may be followed: the refusal reason, or null for "go ahead".
 *
 * The approval the user gave named the STARTING origin, and `redirect: 'follow'` would
 * have quietly carried that approval anywhere — including into loopback, where this
 * machine's llama server and ws-bridge listen. So: a hop from a public start into a
 * private address is refused; everything else (www→apex, link shorteners, a private dev
 * server redirecting within itself) stays ordinary. Pure, so the policy is testable
 * without a network.
 */
export function redirectRefusal(start: URL, next: URL): string | null {
  if (next.protocol !== 'http:' && next.protocol !== 'https:') {
    return `redirect to ${next.protocol} refused — only http(s) can be followed`
  }
  if (next.origin !== start.origin && isPrivateHost(next.hostname) && !isPrivateHost(start.hostname)) {
    return `redirect to ${next.href} refused — a public page redirected into a private address`
  }
  return null
}

/** Reads the body up to the byte cap, decoding by the content-type charset — the Russian
 * web still ships windows-1251, and a UTF-8-only decode is the «???» bug in a new coat. */
async function readBody(response: Response, contentType: string): Promise<{ body: string; truncated: boolean }> {
  const reader = response.body?.getReader()
  const charset = /charset=([\w-]+)/i.exec(contentType)?.[1] ?? 'utf-8'
  let decoder: TextDecoder
  try {
    decoder = new TextDecoder(charset)
  } catch {
    decoder = new TextDecoder('utf-8')
  }
  if (reader === undefined) {
    const buf = Buffer.from(await response.arrayBuffer())
    return { body: decoder.decode(buf.subarray(0, MAX_BODY_BYTES)), truncated: buf.byteLength > MAX_BODY_BYTES }
  }
  const chunks: Buffer[] = []
  let total = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    chunks.push(Buffer.from(value))
    if (total >= MAX_BODY_BYTES) {
      truncated = true
      void reader.cancel().catch(() => { /* the tail is being abandoned either way */ })
      break
    }
  }
  return { body: decoder.decode(Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES)), truncated }
}

/** The fetch half: redirects followed by hand so each hop passes `redirectRefusal`,
 * binaries refused by content type, the body capped by bytes. */
export async function fetchPage(url: string, signal?: AbortSignal): Promise<FetchedPage> {
  const start = new URL(url)
  let current = start
  for (let hop = 0; ; hop++) {
    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS)
    const response = await fetch(current.href, {
      headers: HEADERS,
      redirect: 'manual',
      signal: signal !== undefined ? AbortSignal.any([signal, timeout]) : timeout,
    })
    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => { /* not reading a redirect body */ })
      const location = response.headers.get('location')
      if (location === null) throw new Error(`HTTP ${response.status} with no Location header`)
      if (hop >= MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects`)
      const next = new URL(location, current)
      const refusal = redirectRefusal(start, next)
      if (refusal !== null) throw new Error(refusal)
      current = next
      continue
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => { /* the status is the answer */ })
      throw new Error(`HTTP ${response.status} ${response.statusText}`)
    }
    const contentType = response.headers.get('content-type') ?? ''
    const kind = /html|xml/.test(contentType)
      ? 'html' as const
      : /^(text\/|application\/(json|javascript|x-ndjson))/.test(contentType)
        ? 'text' as const
        : null
    if (kind === null) {
      void response.body?.cancel().catch(() => { /* refusing the body unread */ })
      throw new Error(
        `the page is ${contentType || 'an unknown binary type'} — only HTML and text can be read`,
      )
    }
    const { body, truncated } = await readBody(response, contentType)
    return { kind, body, contentType, finalUrl: current.href, truncated }
  }
}
