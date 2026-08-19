import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
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

/**
 * The address blocks that nothing on the public web may steer a fetch into: loopback,
 * RFC1918, link-local, the IPv6 unique-local and link-local ranges, and the unspecified
 * addresses.
 *
 * `net.BlockList` rather than a hand-written matcher because it also decodes IPv4-mapped
 * IPv6, and the hand-written one did not: `http://[::ffff:127.0.0.1]/` is serialised by
 * WHATWG to the hostname `::ffff:7f00:1`, which no dotted-quad regexp recognises and which
 * reaches 127.0.0.1 all the same. `[::]`, `fd00::/8` and `fe80::/10` were missed for the
 * same reason.
 */
const PRIVATE_BLOCKS = new BlockList()
for (const [block, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16],
] as const) {
  PRIVATE_BLOCKS.addSubnet(block, bits, 'ipv4')
}
for (const [block, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10]] as const) {
  PRIVATE_BLOCKS.addSubnet(block, bits, 'ipv6')
}

/** Whether a literal IP address — as typed in a URL, or as a resolver handed it back —
 * belongs to one of the blocks above. Anything that is not an IP address at all is not an
 * address to judge, so it is false here; names go through `isPrivateHost`. */
export function isPrivateAddress(address: string): boolean {
  // `fe80::1%eth0`: the zone id names a local interface and is not part of the address.
  const bare = address.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0] ?? ''
  const family = isIP(bare)
  if (family === 0) return false
  return PRIVATE_BLOCKS.check(bare, family === 6 ? 'ipv6' : 'ipv4')
}

/** Loopback, RFC1918, link-local, and the localhost name family. Lexical only: a name that
 * is not spelled like a private host can still RESOLVE to one, which is what
 * `redirectRefusalResolved` is for. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  return isPrivateAddress(h)
}

/**
 * Whether a redirect hop may be followed on its SPELLING alone: the refusal reason, or null
 * for "nothing lexical against it".
 *
 * The approval the user gave named the STARTING origin, and `redirect: 'follow'` would
 * have quietly carried that approval anywhere — including into loopback, where this
 * machine's llama server and ws-bridge listen. So: a hop from a public start into a
 * private address is refused; everything else (www→apex, link shorteners, a private dev
 * server redirecting within itself) stays ordinary. Pure, so the policy is testable
 * without a network.
 *
 * This is the fast half. A hostname that is not spelled privately can still resolve
 * privately, and `redirectRefusalResolved` is what fetchPage actually calls.
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

/** Hostname → the addresses it stands for. A parameter so the policy below can be proved
 * without a network and without a DNS server that answers the way a test needs. */
export type HostLookup = (hostname: string) => Promise<string[]>

const systemLookup: HostLookup = async (hostname) => {
  const records = await lookup(hostname, { all: true })
  return records.map((r) => r.address)
}

/**
 * The same policy, after asking what the name actually points at.
 *
 * Why it is not enough to read the URL: `lvh.me`, `127.0.0.1.nip.io` and any domain whose
 * A record an attacker controls are ordinary public names that resolve to 127.0.0.1. A
 * page the user approved as a public origin could answer `302 Location:
 * http://lvh.me:8080/props`, and the lexical check above sees a public hostname, follows
 * the hop, and hands the model whatever this machine's llama server said — the exact hop
 * `redirectRefusal` exists to refuse.
 *
 * The resolver is asked as rarely as possible, and never on the path that has no redirect
 * at all: a hop that stays inside the approved origin, a start that is already private,
 * and an address literal (which the lexical pass judged exactly) are all settled without
 * it. What remains is one getaddrinfo per cross-origin hop, against an OS cache the fetch
 * that follows is about to hit anyway.
 *
 * What this does NOT close, deliberately: the name is resolved here and resolved again by
 * the connect, so a record that changes between the two (DNS rebinding) still lands where
 * it likes. Closing that needs a custom undici dispatcher pinning the checked address, and
 * that is a bigger change than this gate. This turns a one-request trick into a race.
 */
export async function redirectRefusalResolved(
  start: URL, next: URL, resolveHost: HostLookup = systemLookup,
): Promise<string | null> {
  const lexical = redirectRefusal(start, next)
  if (lexical !== null) return lexical
  // Nothing new is being reached, or private space was already the approved starting point.
  if (next.origin === start.origin || isPrivateHost(start.hostname)) return null
  // An address literal was judged exactly above; resolving one asks a question already
  // answered.
  const bare = next.hostname.replace(/^\[|\]$/g, '')
  if (isIP(bare) !== 0) return null

  let addresses: string[]
  try {
    addresses = await resolveHost(next.hostname)
  } catch {
    // A name this machine cannot resolve is a name the fetch below cannot connect to
    // either, so the hop fails on its own. Refusing here would turn a flaky resolver into
    // an accusation against an innocent redirect.
    return null
  }
  const priv = addresses.find((a) => isPrivateAddress(a))
  if (priv === undefined) return null
  return `redirect to ${next.href} refused — a public page redirected into a private address ` +
    `(${next.hostname} resolves to ${priv})`
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

/** The fetch half: redirects followed by hand so each hop passes `redirectRefusalResolved`,
 * binaries refused by content type, the body capped by bytes. `resolveHost` is here for the
 * tests; production always wants the system resolver. */
export async function fetchPage(
  url: string, signal?: AbortSignal, resolveHost: HostLookup = systemLookup,
): Promise<FetchedPage> {
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
      const refusal = await redirectRefusalResolved(start, next, resolveHost)
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
