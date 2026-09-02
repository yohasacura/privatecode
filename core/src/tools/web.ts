import { MAX_BODY_BYTES, extractReadable, fetchPage } from '../web/read.js'
import { renderHits, webSearch } from '../web/search.js'
import { countLines, headLines, overflowNotice, spillToLog } from './output-log.js'
import type { ApprovalPreview, PermissionKey, Tool, ToolContext, ToolResult } from './types.js'

/**
 * The model's way onto the internet: search, then read. Two tools, named as Claude Code
 * names them — `WebSearch` and `WebFetch` — so a plugin's hook matcher, an agent's `tools:`
 * line and a permission rule written for Claude Code mean the same thing here.
 *
 * Built after watching the alternative fail live: asked to look something up, the model
 * opened the visible browser at nothing (an empty Edge window over the user's work),
 * found no way to search, and fell back to raw curl through Bash. Search is a
 * first-class tool here — the HTML endpoints of DuckDuckGo/Bing, no keys, no
 * accounts (an owner-level constraint, not an optimization) — and reading is fetch +
 * Firefox's Reader engine, escalating to the HEADLESS browser only when a page ships as
 * a JavaScript shell. The visible `browser` tool stays what it was: for pages the user
 * should watch being driven.
 *
 * `WebSearch` carries the fixed permission target `'search'` — the engine allows it in
 * every working mode without asking (it reaches only the search engine), while an
 * explicit `deny: ["WebSearch"]` rule still kills it. `WebFetch` is keyed on the URL,
 * origin rules and all, exactly like `browser` — reading an arbitrary site is the act
 * worth a decision.
 */

export interface WebSearchArgs { query: string }
export interface WebFetchArgs { url: string }

/** The permission target every search call carries; the engine's mode defaults match
 * on it. A literal, not a URL — there is no origin decision to make about searching. */
export const WEB_SEARCH_TARGET = 'search'

const MAX_OUTPUT_CHARS = 8_000
const HEAD_LINES = 60
const MAX_QUERY_CHARS = 400

const ALLOWED_SCHEMES = ['http:', 'https:']

/** Bounded copy for the model, untruncated for the person — Bash's discipline. */
async function paged(ctx: ToolContext, full: string): Promise<ToolResult> {
  if (full.length <= MAX_OUTPUT_CHARS) return { ok: true, content: full, display: full }
  const log = await spillToLog(ctx.workspace, 'web', full)
  const content = log === null
    ? `${headLines(full, HEAD_LINES)}\n... (output truncated; the log file could not be written)`
    : `${headLines(full, HEAD_LINES)}${overflowNotice(log, Math.min(HEAD_LINES, countLines(full)))}`
  return { ok: true, content, display: full }
}

export const webSearchTool: Tool<WebSearchArgs> = {
  name: 'WebSearch',
  // The external-tool family precedent: reaching the network is never plan-safe.
  readOnly: false,
  description:
    'Search the internet and get titles, URLs and snippets — use it whenever you need ' +
    'information you do not have: documentation, error messages, versions, APIs. Read a ' +
    'result with WebFetch. Never use curl or a browser window for this.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to look for.' },
    },
    required: ['query'],
  },

  validate(raw) {
    const r = raw as Partial<WebSearchArgs>
    if (typeof r?.query !== 'string' || r.query.trim() === '') {
      return { ok: false, error: 'query must be non-empty' }
    }
    if (r.query.length > MAX_QUERY_CHARS) {
      return { ok: false, error: `the query is ${r.query.length} characters; the limit is ${MAX_QUERY_CHARS}` }
    }
    return { ok: true, args: { query: r.query.trim() } }
  },

  permissionKey(): PermissionKey {
    return { tool: 'WebSearch', target: WEB_SEARCH_TARGET }
  },

  approvalPreview(args): ApprovalPreview {
    return { summary: `search: ${args.query}`, detail: `Search the web for:\n${args.query}` }
  },

  async execute(args, ctx): Promise<ToolResult> {
    try {
      const { hits, engine } = await webSearch(args.query, ctx.signal)
      return paged(ctx, renderHits(hits, engine))
    } catch (e) {
      return { ok: false, content: `web search failed: ${(e as Error).message}` }
    }
  },
}

export const webFetchTool: Tool<WebFetchArgs> = {
  name: 'WebFetch',
  readOnly: false,
  description:
    'Fetch one http:// or https:// URL and return it as clean readable text — a page ' +
    'from a WebSearch result, documentation, an issue. A page that needs JavaScript is ' +
    'rendered headlessly. Never use curl or a browser window for this.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'An http:// or https:// URL.' },
    },
    required: ['url'],
  },

  validate(raw) {
    const r = raw as Partial<WebFetchArgs>
    if (typeof r?.url !== 'string' || r.url.trim() === '') {
      return { ok: false, error: 'url must be non-empty' }
    }
    let parsed: URL
    try {
      parsed = new URL(r.url.trim())
    } catch {
      return { ok: false, error: `"${r.url}" is not a URL. Include the scheme, e.g. https://example.com` }
    }
    if (!ALLOWED_SCHEMES.includes(parsed.protocol)) {
      return {
        ok: false,
        error: `${parsed.protocol} URLs cannot be read here (only http:, https:). ` +
          'Local files are Read\'s job.',
      }
    }
    // Credentials inside a URL would ride into the permission key, the approval dialog
    // and the logs — and an origin rule built from such a target can never match it
    // (the origin has no userinfo). Refused outright rather than silently stripped.
    if (parsed.username !== '' || parsed.password !== '') {
      return { ok: false, error: 'a URL carrying credentials (user:pass@) is not accepted' }
    }
    return { ok: true, args: { url: parsed.href } }
  },

  permissionKey(args): PermissionKey {
    return { tool: 'WebFetch', target: args.url }
  },

  approvalPreview(args): ApprovalPreview {
    return {
      summary: `fetch ${args.url}`,
      detail: `Fetch and read as text:\n${args.url}\n\nNo browser window opens; ` +
        'a page that needs JavaScript is rendered headlessly.',
    }
  },

  async execute(args, ctx): Promise<ToolResult> {
    const url = args.url
    try {
      const page = await fetchPage(url, ctx.signal)
      // The FINAL URL, said out loud: an approval named the requested origin, and a
      // redirect that moved elsewhere must be visible in the record, not smoothed over.
      const arrived = page.finalUrl !== url ? `(arrived at ${page.finalUrl} after redirects)\n` : ''
      const clipNote = page.truncated
        ? `\n\n(the page was larger than ${MAX_BODY_BYTES.toLocaleString()} bytes; the tail past the cap was not fetched)`
        : ''
      if (page.kind === 'text') {
        return paged(ctx, `${arrived}${page.finalUrl}\n(${page.contentType})\n\n${page.body}${clipNote}`)
      }
      const article = extractReadable(page.body, page.finalUrl)
      if (!article.jsShell) {
        return paged(ctx, `${arrived}${page.finalUrl}\n${article.title}\n\n${article.text}${clipNote}`)
      }
      // The page is a JavaScript shell: the static HTML carries no text worth reading.
      // Render it for real — headlessly, in the renderer the toolset keeps for exactly
      // this, never the visible browser.
      if (ctx.webRenderer === undefined) {
        return paged(ctx,
          `${url}\n${article.title}\n\n${article.text}\n\n(the page needs JavaScript ` +
          'to render and no headless browser is available in this session)')
      }
      const rendered = await ctx.webRenderer.open()
      const { timedOut } = await rendered.navigate(url)
      const snap = await rendered.snapshot()
      const note = timedOut ? '(the page did not finish loading within 30 s; what rendered is below)\n' : ''
      return paged(ctx, `${note}${snap.url}\n${snap.title}\n\n${snap.text}`)
    } catch (e) {
      return { ok: false, content: `could not read ${url}: ${(e as Error).message}` }
    }
  },
}
