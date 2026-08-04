import type { CdpConnection } from './cdp.js'

/**
 * One attached browser tab, and everything this project does to it.
 *
 * Text-first on purpose. The model this tool is built for has no vision tower (see
 * `docs/DESIGN.md` §6), so a screenshot is something a *person* looks at, not something the
 * agent can reason about. `snapshot()` — a flattened, ref-annotated rendering of what is on
 * the page — is how the agent actually perceives a browser, and it is the operation
 * everything else is designed around.
 */

/** Console and network history kept per page. Enough to explain a failure, bounded so a
 * chatty app cannot grow the host's memory without limit. */
const RING_CAPACITY = 200

const NAVIGATION_TIMEOUT_MS = 30_000
/** Going back is a local operation; if it has not happened in this long it is not going to. */
const HISTORY_TIMEOUT_MS = 10_000
/** After the load event, how long to let late XHR/render work settle before snapshotting. */
const SETTLE_MS = 250

export interface PageSnapshot {
  url: string
  title: string
  /** Indented text with `[ref_N]` markers on everything interactive. */
  text: string
  refCount: number
}

export interface ConsoleEntry {
  level: string
  text: string
  atMs: number
}

export interface NetEntry {
  method: string
  url: string
  status?: number
  failed?: string
}

interface EvalResult {
  result?: { type: string; value?: unknown; description?: string }
  exceptionDetails?: { text?: string; exception?: { description?: string } }
}

/**
 * The one piece of page-side code in this project.
 *
 * Walks the visible DOM and emits two kinds of line: a text line for an element's own text,
 * and a `tag "label" [ref_N]` line for anything a person could interact with. The refs are
 * stashed on `window.__pc_refs` so a later `click`/`fill` can address an element by index
 * without the agent ever having to write a CSS selector — a selector it would have to guess
 * from text it was shown, which is the single most common way browser automation goes wrong.
 *
 * Refs die on navigation, and that is correct: the array lives in the page's execution
 * context, which is replaced. `snapshot()` is how you get new ones.
 */
const SNAPSHOT_JS = String.raw`(() => {
  const refs = []; window.__pc_refs = refs;
  const INTERACTIVE = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary', 'option']);
  const isInteractive = (el) => {
    if (INTERACTIVE.has(el.tagName.toLowerCase())) return true;
    if (el.isContentEditable) return true;
    if (el.hasAttribute('onclick')) return true;
    const role = el.getAttribute('role');
    return role !== null && role !== 'presentation' && role !== 'none';
  };
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
  const labelOf = (el) => {
    const raw = el.getAttribute('aria-label') || el.getAttribute('placeholder') ||
      (el.tagName.toLowerCase() === 'input' ? (el.value || el.getAttribute('name') || el.type) : '') ||
      (el.innerText || '') || el.getAttribute('title') || el.getAttribute('alt') || '';
    return String(raw).replace(/\s+/g, ' ').trim().slice(0, 120);
  };
  const out = [];
  const pad = (d) => '  '.repeat(d < 12 ? d : 12);
  const walk = (node, depth) => {
    if (depth > 40 || out.length > 4000) return;
    for (const el of node.children) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'svg') continue;
      if (!isVisible(el)) continue;
      if (isInteractive(el)) {
        refs.push(el);
        out.push(pad(depth) + tag + ' "' + labelOf(el) + '" [ref_' + (refs.length - 1) + ']');
      } else {
        const own = Array.prototype.filter.call(el.childNodes, (n) => n.nodeType === 3)
          .map((n) => n.textContent.replace(/\s+/g, ' ').trim())
          .filter((t) => t.length > 0).join(' ').slice(0, 400);
        if (own) out.push(pad(depth) + own);
      }
      walk(el, depth + 1);
    }
  };
  if (document.body) walk(document.body, 0);
  return JSON.stringify({
    url: location.href,
    title: document.title,
    text: out.join('\n'),
    refCount: refs.length,
  });
})()`

/** The keys worth naming. Anything else is typed as text via `fill`. */
const KEY_CODES: Record<string, { code: string; key: string; vk: number }> = {
  enter: { code: 'Enter', key: 'Enter', vk: 13 },
  tab: { code: 'Tab', key: 'Tab', vk: 9 },
  escape: { code: 'Escape', key: 'Escape', vk: 27 },
  backspace: { code: 'Backspace', key: 'Backspace', vk: 8 },
  delete: { code: 'Delete', key: 'Delete', vk: 46 },
  arrowup: { code: 'ArrowUp', key: 'ArrowUp', vk: 38 },
  arrowdown: { code: 'ArrowDown', key: 'ArrowDown', vk: 40 },
  arrowleft: { code: 'ArrowLeft', key: 'ArrowLeft', vk: 37 },
  arrowright: { code: 'ArrowRight', key: 'ArrowRight', vk: 39 },
  pageup: { code: 'PageUp', key: 'PageUp', vk: 33 },
  pagedown: { code: 'PageDown', key: 'PageDown', vk: 34 },
  home: { code: 'Home', key: 'Home', vk: 36 },
  end: { code: 'End', key: 'End', vk: 35 },
}

export function knownKeys(): string[] {
  return Object.keys(KEY_CODES)
}

/** A bounded FIFO. Small enough to write here rather than reach for a dependency. */
class Ring<T> {
  private items: T[] = []
  constructor(private readonly capacity: number) {}
  push(item: T): void {
    this.items.push(item)
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity)
  }
  last(n: number): T[] {
    return n >= this.items.length ? [...this.items] : this.items.slice(-n)
  }
  all(): T[] {
    return [...this.items]
  }
  clear(): void {
    this.items = []
  }
}

export class Page {
  private readonly conn: CdpConnection
  private readonly sessionId: string
  private readonly consoleRing = new Ring<ConsoleEntry>(RING_CAPACITY)
  private readonly netRing = new Ring<NetEntry>(RING_CAPACITY)
  private readonly inFlight = new Map<string, NetEntry>()
  private currentUrl = 'about:blank'
  private lastRefCount = 0

  private constructor(conn: CdpConnection, sessionId: string) {
    this.conn = conn
    this.sessionId = sessionId
  }

  static async attach(conn: CdpConnection): Promise<Page> {
    const { targetId } = await conn.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await conn.send<{ sessionId: string }>('Target.attachToTarget',
      { targetId, flatten: true })
    const page = new Page(conn, sessionId)
    await page.enableDomains()
    page.subscribe()
    return page
  }

  url(): string {
    return this.currentUrl
  }

  async navigate(url: string, opts: { timeoutMs?: number } = {}): Promise<{ timedOut: boolean }> {
    const timeoutMs = opts.timeoutMs ?? NAVIGATION_TIMEOUT_MS
    // Cleared before the navigation, not after: the console errors and failed requests that
    // matter are the ones this page produces, and carrying the previous page's over is how
    // an agent ends up debugging a problem that is no longer on screen.
    this.consoleRing.clear()
    this.netRing.clear()
    this.inFlight.clear()

    const loaded = this.once('Page.loadEventFired', timeoutMs)
    const result = await this.send<{ errorText?: string }>('Page.navigate', { url })
    if (result.errorText) throw new Error(`could not open ${url}: ${result.errorText}`)
    const fired = await loaded
    // A page whose load event never fires (a long-polling connection, a stalled asset) is
    // still usable — everything already rendered is there. Reported, never thrown.
    if (fired) await new Promise((r) => setTimeout(r, SETTLE_MS))
    this.currentUrl = url
    return { timedOut: !fired }
  }

  async snapshot(): Promise<PageSnapshot> {
    const raw = await this.evaluateRaw(SNAPSHOT_JS)
    const parsed = JSON.parse(String(raw)) as PageSnapshot
    this.currentUrl = parsed.url
    this.lastRefCount = parsed.refCount
    return parsed
  }

  /**
   * A real mouse click at the element's centre, not `el.click()`.
   *
   * `el.click()` dispatches a synthetic event that skips hover, focus and pointer handling;
   * plenty of real UI (menus that open on pointerdown, buttons that need focus first) does
   * not respond to it. Dispatching input at coordinates is what a person's click looks like.
   */
  async click(ref: number): Promise<void> {
    const box = await this.refBox(ref)
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    const common = { x, y, button: 'left' as const, clickCount: 1, buttons: 1 }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...common, buttons: 0 })
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...common })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common })
  }

  /** Focus the element, replace whatever is in it, and type `text`. */
  async fill(ref: number, text: string): Promise<void> {
    await this.callOnRef(ref, `function () {
      this.scrollIntoView({ block: 'center' });
      this.focus();
      if (typeof this.select === 'function') this.select();
      else if (this.isContentEditable) document.execCommand('selectAll', false, undefined);
      return true;
    }`)
    await this.send('Input.insertText', { text })
  }

  async press(key: string): Promise<void> {
    const spec = KEY_CODES[key.trim().toLowerCase()]
    if (!spec) {
      throw new Error(`unknown key "${key}". Known keys: ${knownKeys().join(', ')}. ` +
        'To enter ordinary characters, use the fill action.')
    }
    const base = { code: spec.code, key: spec.key, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk }
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }

  /** Evaluate an expression and render its value as text the model can read. */
  async evaluate(expression: string): Promise<string> {
    const value = await this.evaluateRaw(expression)
    if (value === undefined) return 'undefined'
    if (typeof value === 'string') return value
    try {
      return JSON.stringify(value, null, 2) ?? String(value)
    } catch {
      return String(value)
    }
  }

  console(limit = RING_CAPACITY): ConsoleEntry[] {
    return this.consoleRing.last(limit)
  }

  consoleAll(): ConsoleEntry[] {
    return this.consoleRing.all()
  }

  network(limit = RING_CAPACITY): NetEntry[] {
    return this.netRing.last(limit)
  }

  networkAll(): NetEntry[] {
    return this.netRing.all()
  }

  async screenshot(): Promise<Buffer> {
    const { data } = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'png' })
    return Buffer.from(data, 'base64')
  }

  async back(): Promise<boolean> {
    const history = await this.send<{ currentIndex: number; entries: { id: number }[] }>(
      'Page.getNavigationHistory')
    if (history.currentIndex <= 0) return false
    const previous = history.entries[history.currentIndex - 1]
    if (!previous) return false
    // `Page.loadEventFired` alone is the wrong signal here and measurably so: a page restored
    // from the back-forward cache never fires a load event, so waiting for one cost the full
    // 30 s navigation timeout on every single `back` -- the integration test caught it as a
    // 30.5 s assertion that still passed. `Page.frameNavigated` fires either way, so racing
    // the two gets the fast path when the page really did reload and the correct one when it
    // came back from cache.
    const arrived = this.onceAny(['Page.loadEventFired', 'Page.frameNavigated'], HISTORY_TIMEOUT_MS)
    await this.send('Page.navigateToHistoryEntry', { entryId: previous.id })
    if (await arrived) await new Promise((r) => setTimeout(r, SETTLE_MS))
    await this.snapshot() // refreshes currentUrl and the ref table
    return true
  }

  // ---------------------------------------------------------------------------------------

  private send<T = any>(method: string, params: object = {}): Promise<T> {
    return this.conn.send<T>(method, params, this.sessionId)
  }

  private async enableDomains(): Promise<void> {
    // Page and Runtime are what everything else needs; Log and Network are what make a
    // failure explainable rather than just visible.
    for (const domain of ['Page', 'Runtime', 'Log', 'Network']) {
      await this.send(`${domain}.enable`)
    }
  }

  private subscribe(): void {
    const mine = (sessionId?: string): boolean => sessionId === this.sessionId

    this.conn.on('Runtime.consoleAPICalled', (p, s) => {
      if (!mine(s)) return
      const text = (p.args ?? [])
        .map((a: any) => a.value ?? a.description ?? a.unserializableValue ?? a.type)
        .join(' ')
      this.consoleRing.push({ level: String(p.type ?? 'log'), text, atMs: Date.now() })
    })

    this.conn.on('Log.entryAdded', (p, s) => {
      if (!mine(s)) return
      const entry = p.entry ?? {}
      const where = entry.url ? ` (${entry.url})` : ''
      this.consoleRing.push({
        level: String(entry.level ?? 'info'),
        text: `${entry.text ?? ''}${where}`,
        atMs: Date.now(),
      })
    })

    this.conn.on('Runtime.exceptionThrown', (p, s) => {
      if (!mine(s)) return
      const d = p.exceptionDetails ?? {}
      this.consoleRing.push({
        level: 'error',
        text: d.exception?.description ?? d.text ?? 'uncaught exception',
        atMs: Date.now(),
      })
    })

    this.conn.on('Network.requestWillBeSent', (p, s) => {
      if (!mine(s) || typeof p.requestId !== 'string') return
      this.inFlight.set(p.requestId, { method: p.request?.method ?? 'GET', url: p.request?.url ?? '' })
    })

    this.conn.on('Network.responseReceived', (p, s) => {
      if (!mine(s)) return
      const entry = this.inFlight.get(p.requestId)
      if (!entry) return
      this.inFlight.delete(p.requestId)
      entry.status = p.response?.status
      this.netRing.push(entry)
    })

    this.conn.on('Network.loadingFailed', (p, s) => {
      if (!mine(s)) return
      const entry = this.inFlight.get(p.requestId) ?? { method: '?', url: '' }
      this.inFlight.delete(p.requestId)
      entry.failed = String(p.errorText ?? 'failed')
      this.netRing.push(entry)
    })

    this.conn.on('Page.frameNavigated', (p, s) => {
      if (!mine(s) || p.frame?.parentId) return // main frame only
      if (typeof p.frame?.url === 'string') this.currentUrl = p.frame.url
      this.lastRefCount = 0 // the refs lived in the old execution context
    })
  }

  /** One-shot event wait. Resolves `true` on the event, `false` on the timeout. */
  private once(event: string, timeoutMs: number): Promise<boolean> {
    return this.onceAny([event], timeoutMs)
  }

  /** The same, resolving on whichever of several events arrives first. */
  private onceAny(events: string[], timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const offs: (() => void)[] = []
      const done = (value: boolean): void => {
        clearTimeout(timer)
        for (const off of offs) off()
        resolve(value)
      }
      const timer = setTimeout(() => done(false), timeoutMs)
      for (const event of events) {
        offs.push(this.conn.on(event, (_p, sessionId) => {
          if (sessionId === this.sessionId) done(true)
        }))
      }
    })
  }

  private async evaluateRaw(expression: string): Promise<unknown> {
    const res = await this.send<EvalResult>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      // A page that opened an alert() would otherwise leave every later evaluate hanging.
      userGesture: true,
    })
    if (res.exceptionDetails) {
      const message = res.exceptionDetails.exception?.description ??
        res.exceptionDetails.text ?? 'the page threw'
      throw new Error(message.split('\n')[0] ?? message)
    }
    return res.result?.value
  }

  /** Calls a function with `this` bound to `window.__pc_refs[ref]`. */
  private async callOnRef(ref: number, functionSource: string): Promise<unknown> {
    const guard = `(() => {
      const el = (window.__pc_refs || [])[${ref}];
      if (!el || !el.isConnected) return { __pcMissing: true };
      return { __pcValue: (${functionSource}).call(el) };
    })()`
    const value = await this.evaluateRaw(guard) as { __pcMissing?: boolean; __pcValue?: unknown }
    if (value?.__pcMissing) throw new Error(this.staleRefMessage(ref))
    return value?.__pcValue
  }

  private async refBox(ref: number): Promise<{ x: number; y: number; width: number; height: number }> {
    const box = await this.callOnRef(ref, `function () {
      this.scrollIntoView({ block: 'center', inline: 'center' });
      const r = this.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }`) as { x: number; y: number; width: number; height: number }
    if (!box || (box.width === 0 && box.height === 0)) {
      throw new Error(`ref_${ref} is on the page but has no visible box, so it cannot be clicked.`)
    }
    return box
  }

  private staleRefMessage(ref: number): string {
    return this.lastRefCount === 0
      ? `ref_${ref} no longer exists — the page navigated since the last read. Read the page again to get fresh refs.`
      : `ref_${ref} no longer exists on this page (the last read produced ${this.lastRefCount} refs, ` +
        'ref_0 upward). Read the page again to get fresh refs.'
  }
}
