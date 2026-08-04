import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserManager } from '../browser/manager.js'
import type { ConsoleEntry, NetEntry, Page } from '../browser/page.js'
import { knownKeys } from '../browser/page.js'
import { ensurePrivateDir, PRIVATE_DIR } from '../private-dir.js'
import { countLines, headLines, overflowNotice, spillToLog } from './output-log.js'
import type { ApprovalPreview, PermissionKey, Tool, ToolContext, ToolResult } from './types.js'

/**
 * One tool, not nine.
 *
 * `background_task` is the house precedent: an `action` enum with control operations that
 * carry no permission spec. Nine separate browser tools would cost nine schema slots in
 * every request's constraint grammar, on a model whose context window is the scarcest
 * resource in the system — and the model would still have to learn that they are one
 * stateful thing, because they are.
 */

export type BrowserAction =
  | 'open' | 'read' | 'click' | 'fill' | 'press' | 'eval'
  | 'console' | 'network' | 'screenshot' | 'back' | 'close'

export interface BrowserArgs {
  action: BrowserAction
  url?: string
  ref?: number
  text?: string
  key?: string
  expression?: string
}

/** Page text over this goes to a log file the model can page, exactly like command output. */
const MAX_OUTPUT_CHARS = 8_000
const HEAD_LINES = 60
/** Console/network lines handed to the model in one call. `display` always carries them all. */
const MAX_ENTRIES = 50
/** Where screenshots land. Inside `.privatecode/`, which is write-denied to the model but
 * written here by the engine — the same arrangement session transcripts and logs use. */
const SHOT_DIR = 'browser'

const ACTIONS_NEEDING_PAGE: ReadonlySet<BrowserAction> =
  new Set(['read', 'click', 'fill', 'press', 'eval', 'console', 'network', 'screenshot', 'back'])

/**
 * Schemes the browser may be pointed at.
 *
 * `javascript:` is the one that matters: it is not a navigation at all, it runs script in
 * whatever page is currently open, while an approval dialog would show it in the "opening a
 * URL" shape. `file:` is refused because reading local files is what `read_file` is for, and
 * it is jailed to the workspace while a browser is not.
 */
const ALLOWED_SCHEMES = ['http:', 'https:', 'about:']

function describeEntries(entries: ConsoleEntry[] | NetEntry[], kind: 'console' | 'network'): string {
  if (entries.length === 0) return kind === 'console' ? '(no console output)' : '(no requests)'
  if (kind === 'console') {
    return (entries as ConsoleEntry[]).map((e) => `[${e.level}] ${e.text}`).join('\n')
  }
  return (entries as NetEntry[])
    .map((e) => `${e.status ?? (e.failed ? 'FAILED' : '...')} ${e.method} ${e.url}` +
      (e.failed ? ` — ${e.failed}` : ''))
    .join('\n')
}

/** Bounded copy for the model, untruncated copy for the person. */
async function paged(ctx: ToolContext, prefix: string, full: string): Promise<ToolResult> {
  if (full.length <= MAX_OUTPUT_CHARS) return { ok: true, content: full, display: full }
  const log = await spillToLog(ctx.workspace, prefix, full)
  const content = log === null
    ? `${headLines(full, HEAD_LINES)}\n... (output truncated; the log file could not be written)`
    : `${headLines(full, HEAD_LINES)}${overflowNotice(log, Math.min(HEAD_LINES, countLines(full)))}`
  return { ok: true, content, display: full }
}

let shotCounter = 0

export const browserTool: Tool<BrowserArgs> = {
  name: 'browser',
  // Opening a page starts a process and reaches the network, so this is never plan-safe --
  // and `readOnly` is the ONLY thing plan mode consults (see registry.readOnlyNames).
  readOnly: false,
  description:
    'Drive a real browser: open a page, read what is on it, click, type, run script, and ' +
    'read its console and network activity. Use it to check that a web page actually works ' +
    '— a dev server rendering, a form submitting, an error in the console. ' +
    'You cannot see images, so `read` (text with [ref_N] markers) is how you perceive a ' +
    'page; refs come from the most recent `read` and stop working once the page navigates.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['open', 'read', 'click', 'fill', 'press', 'eval', 'console', 'network',
               'screenshot', 'back', 'close'],
        description:
          'open: go to a URL. read: the page as text with [ref_N] markers. click/fill: act ' +
          'on a ref. press: a named key. eval: run a JS expression and return its value. ' +
          'console/network: what the page logged and requested. screenshot: save a PNG for ' +
          'the user. back: previous page. close: shut the browser down.',
      },
      url: { type: 'string', description: 'open only: an http:// or https:// URL.' },
      ref: { type: 'integer', description: 'click/fill only: a ref number from the last read.' },
      text: { type: 'string', description: 'fill only: the text to type into the element.' },
      key: { type: 'string', description: `press only: one of ${knownKeys().join(', ')}.` },
      expression: { type: 'string', description: 'eval only: a JavaScript expression.' },
    },
    required: ['action'],
  },

  validate(raw) {
    const r = raw as Partial<BrowserArgs>
    const action = r?.action
    if (typeof action !== 'string' || !ACTIONS.has(action as BrowserAction)) {
      return { ok: false, error: `action must be one of ${[...ACTIONS].join(', ')}` }
    }
    const args: BrowserArgs = { action: action as BrowserAction }

    if (action === 'open') {
      if (typeof r!.url !== 'string' || r!.url.trim() === '') {
        return { ok: false, error: 'open needs a url' }
      }
      const url = r!.url.trim()
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        return { ok: false, error: `"${url}" is not a URL. Include the scheme, e.g. http://localhost:5173` }
      }
      if (!ALLOWED_SCHEMES.includes(parsed.protocol)) {
        return {
          ok: false,
          error: `${parsed.protocol} URLs are not allowed here (only ${ALLOWED_SCHEMES.join(', ')}). ` +
            (parsed.protocol === 'file:'
              ? 'Use read_file for local files.'
              : 'A javascript: URL runs script in whatever page is open rather than navigating; ' +
                'use the eval action, which says what it is.'),
        }
      }
      args.url = parsed.href
    }

    if (action === 'click' || action === 'fill') {
      const ref = r!.ref
      if (!Number.isInteger(ref) || (ref as number) < 0) {
        return { ok: false, error: `${action} needs a ref number from the last read` }
      }
      args.ref = ref as number
    }
    if (action === 'fill') {
      if (typeof r!.text !== 'string') return { ok: false, error: 'fill needs text' }
      args.text = r!.text
    }
    if (action === 'press') {
      if (typeof r!.key !== 'string' || r!.key.trim() === '') {
        return { ok: false, error: `press needs a key, one of: ${knownKeys().join(', ')}` }
      }
      args.key = r!.key
    }
    if (action === 'eval') {
      if (typeof r!.expression !== 'string' || r!.expression.trim() === '') {
        return { ok: false, error: 'eval needs a JavaScript expression' }
      }
      args.expression = r!.expression
    }
    return { ok: true, args }
  },

  /**
   * The ORIGIN is the unit of approval, and this is the design decision worth stating.
   *
   * Asking per click would be unusable, and worse than unusable: it would train the user to
   * approve reflexively, which is a weaker gate than not asking at all. Asking per origin is
   * one decision a person can actually make — "may this agent drive my dev server at
   * localhost:5173" — and `suggestRules` offers exactly that as `browser(http://localhost:5173:*)`.
   *
   * `open` is keyed on the URL being requested; every other action is keyed on the page
   * already open, which the user approved when it was opened. `close` carries no key at all:
   * it is a control operation, like `background_task`'s stop, and there is nothing left to
   * gate about shutting down something that was already approved to start.
   */
  permissionKey(args, ctx?: ToolContext): PermissionKey {
    if (args.action === 'close') return { tool: 'browser' }
    const target = args.action === 'open' ? args.url : ctx?.browser?.currentUrl() ?? undefined
    return target ? { tool: 'browser', target } : { tool: 'browser' }
  },

  approvalPreview(args, ctx): ApprovalPreview {
    const running = ctx?.browser?.isRunning() ?? false
    const here = ctx?.browser?.currentUrl() ?? 'no page open'
    if (args.action === 'open') {
      const firstRun = running
        ? ''
        : '\n\nThis starts Microsoft Edge (or Chrome) with a profile PrivateCode keeps ' +
          'separate from your own.'
      return { summary: `open ${args.url}`, detail: `Open in the browser:\n${args.url}${firstRun}` }
    }
    const what: Record<string, string> = {
      read: 'Read the page as text',
      click: `Click ref_${args.ref}`,
      fill: `Type into ref_${args.ref}: ${JSON.stringify(args.text ?? '')}`,
      press: `Press ${args.key}`,
      eval: `Run JavaScript: ${args.expression}`,
      console: 'Read the console output',
      network: 'Read the network activity',
      screenshot: 'Save a screenshot',
      back: 'Go back one page',
      close: 'Close the browser',
    }
    const line = what[args.action] ?? args.action
    return { summary: `${args.action} (${here})`, detail: `${line}\n\nCurrent page: ${here}` }
  },

  async execute(args, ctx): Promise<ToolResult> {
    const manager = ctx.browser
    if (!manager) {
      return { ok: false, content: 'The browser is not available in this session.' }
    }

    if (args.action === 'close') {
      await manager.close()
      return { ok: true, content: 'Browser closed.' }
    }

    // Every remaining action needs a page. `open` launches one; the others refuse rather
    // than silently starting a browser and acting on about:blank, which would look like the
    // action worked.
    if (args.action !== 'open' && ACTIONS_NEEDING_PAGE.has(args.action) && !manager.isRunning()) {
      return {
        ok: false,
        content: 'No page is open. Use action="open" with a url first.',
      }
    }

    let page: Page
    try {
      page = await manager.open()
    } catch (e) {
      return { ok: false, content: `The browser could not be started: ${(e as Error).message}` }
    }

    try {
      return await run(args, page, ctx)
    } catch (e) {
      return { ok: false, content: `${args.action} failed: ${(e as Error).message}` }
    }
  },
}

const ACTIONS: ReadonlySet<BrowserAction> = new Set<BrowserAction>([
  'open', 'read', 'click', 'fill', 'press', 'eval', 'console', 'network', 'screenshot',
  'back', 'close',
])

async function run(args: BrowserArgs, page: Page, ctx: ToolContext): Promise<ToolResult> {
  switch (args.action) {
    case 'open': {
      const { timedOut } = await page.navigate(args.url!)
      const snap = await page.snapshot()
      const note = timedOut
        ? '(the page did not finish loading within 30 s; what rendered is below)\n'
        : ''
      const errors = page.console().filter((c) => c.level === 'error')
      const errorNote = errors.length > 0
        ? `\n\n${errors.length} console error(s) — use action="console" to read them.`
        : ''
      return paged(ctx, 'browser',
        `${note}${snap.url}\n${snap.title}\n\n${snap.text}${errorNote}`)
    }

    case 'read': {
      const snap = await page.snapshot()
      return paged(ctx, 'browser', `${snap.url}\n${snap.title}\n\n${snap.text}`)
    }

    case 'click': {
      await page.click(args.ref!)
      // The click's whole purpose is what it changed, and a model that has to spend another
      // step asking is a model that will spend it. The fresh snapshot also refreshes the
      // refs, which the click may well have invalidated.
      const snap = await page.snapshot()
      return paged(ctx, 'browser', `Clicked ref_${args.ref}.\n\n${snap.url}\n\n${snap.text}`)
    }

    case 'fill': {
      await page.fill(args.ref!, args.text!)
      return { ok: true, content: `Typed into ref_${args.ref}.` }
    }

    case 'press': {
      await page.press(args.key!)
      const snap = await page.snapshot()
      return paged(ctx, 'browser', `Pressed ${args.key}.\n\n${snap.url}\n\n${snap.text}`)
    }

    case 'eval': {
      const value = await page.evaluate(args.expression!)
      return paged(ctx, 'browser', value)
    }

    case 'console': {
      const all = page.consoleAll()
      const shown = all.slice(-MAX_ENTRIES)
      const more = all.length > shown.length ? `(${all.length - shown.length} earlier lines omitted)\n` : ''
      return {
        ok: true,
        content: `${more}${describeEntries(shown, 'console')}`,
        display: describeEntries(all, 'console'),
      }
    }

    case 'network': {
      const all = page.networkAll()
      const shown = all.slice(-MAX_ENTRIES)
      const more = all.length > shown.length ? `(${all.length - shown.length} earlier requests omitted)\n` : ''
      return {
        ok: true,
        content: `${more}${describeEntries(shown, 'network')}`,
        display: describeEntries(all, 'network'),
      }
    }

    case 'screenshot': {
      const png = await page.screenshot()
      const dir = ensurePrivateDir(ctx.workspace.root, SHOT_DIR)
      const name = `shot-${String(++shotCounter).padStart(3, '0')}.png`
      await writeFile(join(dir, name), png)
      const relative = `${PRIVATE_DIR}/${SHOT_DIR}/${name}`
      return {
        ok: true,
        // Stated flatly, because the alternative is the model spending a step trying to
        // read_file a PNG: this build has no vision tower (docs/DESIGN.md §6).
        content: `Screenshot saved to ${relative} for the user to look at. ` +
          'You cannot read images — use action="read" to see what is on the page.',
        display: relative,
      }
    }

    case 'back': {
      const moved = await page.back()
      if (!moved) return { ok: false, content: 'There is no previous page to go back to.' }
      const snap = await page.snapshot()
      return paged(ctx, 'browser', `${snap.url}\n${snap.title}\n\n${snap.text}`)
    }

    default:
      return { ok: false, content: `Unsupported action "${String(args.action)}".` }
  }
}
