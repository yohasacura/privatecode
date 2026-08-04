import { CdpConnection } from './cdp.js'
import { launchBrowser, type LaunchedBrowser } from './launcher.js'
import { Page } from './page.js'

/**
 * Owns the browser process for as long as the workspace is open.
 *
 * Lazy on purpose: constructing this costs nothing, and a session that never asks for a page
 * never starts a browser. That matters because starting one is visible — a window appears —
 * and a tool that opens a browser window on startup, for every session, in case it might be
 * wanted, would be the kind of thing people disable and never turn back on.
 *
 * Lives on the TOOLSET, not the session. A session switch must not close a page the user is
 * looking at, and must not pay the relaunch cost.
 */

export interface BrowserOptions {
  /** Run without a visible window. Default false: watching the agent work is the point. */
  headless?: boolean
  /** Override the browser executable. Default: the first Edge or Chrome that is installed. */
  exePath?: string
}

export class BrowserManager {
  private readonly opts: BrowserOptions
  private browser: LaunchedBrowser | null = null
  private conn: CdpConnection | null = null
  private page: Page | null = null
  private starting: Promise<Page> | null = null
  private dead = false

  constructor(opts: BrowserOptions = {}) {
    this.opts = opts
  }

  isRunning(): boolean {
    return this.page !== null && !this.dead
  }

  /** The page's URL, or `null` when nothing is open. Read by the permission key. */
  currentUrl(): string | null {
    return this.isRunning() ? this.page!.url() : null
  }

  /**
   * The open page, starting the browser if it is not running.
   *
   * Concurrent callers share one launch: `starting` is the in-flight promise, so two tool
   * calls arriving together cannot race two browsers into existence. (The agent runs one
   * tool per step, so this is defence rather than a live path — but a second window nobody
   * asked for is exactly the kind of thing that happens once and is never diagnosed.)
   */
  async open(): Promise<Page> {
    if (this.page !== null && !this.dead) return this.page
    if (this.starting !== null) return this.starting
    this.starting = this.start().finally(() => { this.starting = null })
    return this.starting
  }

  private async start(): Promise<Page> {
    await this.close() // a dead browser's process and socket are still ours to clean up
    this.dead = false
    const browser = await launchBrowser({
      ...(this.opts.exePath !== undefined ? { exePath: this.opts.exePath } : {}),
      headless: this.opts.headless ?? false,
    })
    this.browser = browser
    // The user closing the window is a normal way to end a browser session, not an error.
    // Marking it dead here is what lets the next call relaunch instead of failing forever
    // against a socket to a process that is gone.
    void browser.exited.then(() => { this.dead = true })

    try {
      this.conn = await CdpConnection.connect(browser.wsUrl)
      void this.conn.closed.then(() => { this.dead = true })
      this.page = await Page.attach(this.conn)
      return this.page
    } catch (e) {
      await this.close()
      throw e
    }
  }

  /**
   * Never throws, and never hangs: teardown runs on paths that are already failing, and on
   * app shutdown, where a stuck close is indistinguishable from a crash.
   *
   * `Browser.close` first, kill second. Asking the browser to close makes it shut its own
   * renderer and GPU children down; killing the parent process leaves that to the OS, which
   * on Windows means a few seconds of orphans holding the profile directory — and the next
   * launch then fails with "another copy is already running with the same profile".
   */
  async close(): Promise<void> {
    const browser = this.browser
    const conn = this.conn
    this.page = null
    this.conn = null
    this.browser = null
    this.dead = false
    if (!browser) {
      conn?.close()
      return
    }
    try {
      await conn?.send('Browser.close', {}, undefined, 3_000)
      await Promise.race([browser.exited, new Promise((r) => setTimeout(r, 3_000))])
    } catch { /* the socket may already be gone; the kill below is the backstop */ }
    conn?.close()
    try { await browser.kill() } catch { /* already gone */ }
  }
}
