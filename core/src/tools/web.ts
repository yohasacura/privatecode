import { MAX_BODY_BYTES, extractReadable, fetchPage } from '../web/read.js'
import { renderHits, webSearch } from '../web/search.js'
import { countLines, headLines, overflowNotice, spillToLog } from './output-log.js'
import type { ApprovalPreview, PermissionKey, Tool, ToolContext, ToolResult } from './types.js'

/**
 * The model's way onto the internet: search, then read.
 *
 * Built after watching the alternative fail live: asked to look something up, the model
 * opened the visible browser at nothing (an empty Edge window over the user's work),
 * found no way to search, and fell back to raw curl through run_command. Search is a
 * first-class action here — the HTML endpoints of DuckDuckGo/Bing, no keys, no
 * accounts (an owner-level constraint, not an optimization) — and reading is fetch +
 * Firefox's Reader engine, escalating to the HEADLESS browser only when a page ships as
 * a JavaScript shell. The visible `browser` tool stays what it was: for pages the user
 * should watch being driven.
 *
 * `search` carries the fixed permission target `'search'` — the engine allows it in
 * every working mode without asking (it reaches only the search engine), while an
 * explicit `deny: ["web"]` rule still kills it. `read` is keyed on the URL, origin
 * rules and all, exactly like `browser` — reading an arbitrary site is the act worth a
 * decision.
 */

export type WebAction = 'search' | 'read'

export interface WebArgs {
  action: WebAction
  query?: string
  url?: string
}

/** The permission target every `search` call carries; the engine's mode defaults match
 * on it. A literal, not a URL — there is no origin decision to make about searching. */
export const WEB_SEARCH_TARGET = 'search'

const MAX_OUTPUT_CHARS = 8_000
const HEAD_LINES = 60
const MAX_QUERY_CHARS = 400

const ALLOWED_SCHEMES = ['http:', 'https:']

/** Bounded copy for the model, untruncated for the person — run_command's discipline. */
async function paged(ctx: ToolContext, full: string): Promise<ToolResult> {
  if (full.length <= MAX_OUTPUT_CHARS) return { ok: true, content: full, display: full }
  const log = await spillToLog(ctx.workspace, 'web', full)
  const content = log === null
    ? `${headLines(full, HEAD_LINES)}\n... (output truncated; the log file could not be written)`
    : `${headLines(full, HEAD_LINES)}${overflowNotice(log, Math.min(HEAD_LINES, countLines(full)))}`
  return { ok: true, content, display: full }
}

export const webTool: Tool<WebArgs> = {
  name: 'web',
  // The external-tool family precedent: reaching the network is never plan-safe.
  readOnly: false,
  description:
    'Search the internet and read pages. action="search" runs a web search and returns ' +
    'titles, URLs and snippets — use it whenever you need information you do not have: ' +
    'documentation, error messages, versions, APIs. action="read" fetches one URL as ' +
    'clean readable text. Never use curl or a browser window for this.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['search', 'read'],
        description: 'search: query the web. read: fetch one URL as readable text.',
      },
      query: { type: 'string', description: 'search only: what to look for.' },
      url: { type: 'string', description: 'read only: an http:// or https:// URL.' },
    },
    required: ['action'],
  },

  validate(raw) {
    const r = raw as Partial<WebArgs>
    if (r?.action !== 'search' && r?.action !== 'read') {
      return { ok: false, error: 'action must be "search" or "read"' }
    }
    if (r.action === 'search') {
      if (typeof r.query !== 'string' || r.query.trim() === '') {
        return { ok: false, error: 'search needs a query' }
      }
      if (r.query.length > MAX_QUERY_CHARS) {
        return { ok: false, error: `the query is ${r.query.length} characters; the limit is ${MAX_QUERY_CHARS}` }
      }
      return { ok: true, args: { action: 'search', query: r.query.trim() } }
    }
    if (typeof r.url !== 'string' || r.url.trim() === '') {
      return { ok: false, error: 'read needs a url' }
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
          'Local files are read_file\'s job.',
      }
    }
    // Credentials inside a URL would ride into the permission key, the approval dialog
    // and the logs — and an origin rule built from such a target can never match it
    // (the origin has no userinfo). Refused outright rather than silently stripped.
    if (parsed.username !== '' || parsed.password !== '') {
      return { ok: false, error: 'a URL carrying credentials (user:pass@) is not accepted' }
    }
    return { ok: true, args: { action: 'read', url: parsed.href } }
  },

  permissionKey(args): PermissionKey {
    return args.action === 'search'
      ? { tool: 'web', target: WEB_SEARCH_TARGET }
      : { tool: 'web', target: args.url! }
  },

  approvalPreview(args): ApprovalPreview {
    if (args.action === 'search') {
      return { summary: `search: ${args.query}`, detail: `Search the web for:\n${args.query}` }
    }
    return {
      summary: `read ${args.url}`,
      detail: `Fetch and read as text:\n${args.url}\n\nNo browser window opens; ` +
        'a page that needs JavaScript is rendered headlessly.',
    }
  },

  async execute(args, ctx): Promise<ToolResult> {
    if (args.action === 'search') {
      try {
        const { hits, engine } = await webSearch(args.query!, ctx.signal)
        return paged(ctx, renderHits(hits, engine))
      } catch (e) {
        return { ok: false, content: `web search failed: ${(e as Error).message}` }
      }
    }

    const url = args.url!
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
