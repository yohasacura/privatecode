import { execa } from 'execa'
import { existsSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Finding and starting the browser this project drives.
 *
 * The browser is one that is already installed. Edge ships with Windows and Chrome is on
 * most developer machines; bundling a third copy would have added hundreds of megabytes to
 * a tool whose whole proposition is that it runs from a folder, offline.
 */

/** Where the browser's own profile lives. Deliberately not in the workspace: see `profileDir`. */
export function profileDir(): string {
  const local = process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local')
  return join(local, 'PrivateCode', 'browser-profile')
}

function candidatePaths(): string[] {
  const local = process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local')
  const pf = process.env['PROGRAMFILES'] ?? 'C:\\Program Files'
  const pfx86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)'
  return [
    // Edge first: it ships with Windows, so it is the one that is always there.
    join(pfx86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(pfx86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ]
}

/**
 * The first installed Chromium-family browser, or `null`. A caller turns `null` into a
 * message naming what was looked for — never a stack trace, because "no browser installed"
 * is a configuration fact, not a crash.
 */
export function findBrowser(preferred?: string): string | null {
  if (preferred) return existsSync(preferred) ? preferred : null
  return candidatePaths().find((p) => existsSync(p)) ?? null
}

/** What `findBrowser` searched, for an error message that tells the user how to fix it. */
export function searchedPaths(): string[] {
  return candidatePaths()
}

export interface LaunchedBrowser {
  wsUrl: string
  exePath: string
  /** Resolves when the process is gone. Safe to call more than once. */
  kill(): Promise<void>
  /** Resolves if the browser exits on its own — the user closing the window. */
  exited: Promise<void>
}

export interface LaunchOptions {
  exePath?: string
  headless?: boolean
  userDataDir?: string
  /** How long to wait for the browser to publish its debugging port. */
  timeoutMs?: number
}

const PORT_FILE = 'DevToolsActivePort'
const DEFAULT_LAUNCH_TIMEOUT_MS = 20_000

/** Chromium's profile-ownership files. `lockfile` is the one Windows uses. */
const LOCK_FILES = ['lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket']

/**
 * Removes profile locks left behind by a browser that died without cleaning up.
 *
 * A profile may only have one live browser. If a previous run was killed — app crash,
 * machine sleep, a `kill()` that did not take — the lock stays and every later launch hands
 * off to a browser that no longer exists and exits within ~150 ms, which surfaces as a
 * launch timeout with no explanation.
 *
 * Windows itself is the source of truth for whether the lock is stale, and it is exact: a
 * live browser holds `lockfile` open with an exclusive handle, so `rmSync` FAILS. A delete
 * that succeeds means nothing held it, which is precisely the definition of stale. So this
 * needs no process scanning, no PID bookkeeping, and cannot steal a profile from a browser
 * that is genuinely running — a failure here is left alone, and `readDebuggerUrl` then
 * reports it in terms the user can act on.
 */
function clearStaleLocks(userDataDir: string): void {
  for (const name of LOCK_FILES) {
    try { rmSync(join(userDataDir, name), { force: true }) } catch { /* held: a live browser owns it */ }
  }
}

/**
 * Starts the browser and returns the WebSocket URL of its debugging endpoint.
 *
 * `--remote-debugging-port=0` asks for an ephemeral port, which the browser then writes to
 * `<user-data-dir>/DevToolsActivePort`. A fixed port would be the obvious alternative and is
 * wrong twice over: it collides with a browser the user is already debugging, and it means
 * anything on the machine can find the port and drive the browser.
 *
 * The port file is DELETED before spawning. Without that, a file left by a previous run is
 * indistinguishable from this run's, and the connection succeeds against a browser that is
 * not the one just started — a failure that only shows up as commands going to the wrong
 * window.
 */
export async function launchBrowser(opts: LaunchOptions = {}): Promise<LaunchedBrowser> {
  const exePath = findBrowser(opts.exePath)
  if (exePath === null) {
    throw new Error(
      'No Chromium-family browser was found. PrivateCode drives Microsoft Edge or Google ' +
      `Chrome; it looked in:\n${candidatePaths().map((p) => `  ${p}`).join('\n')}\n` +
      'Set "browser": { "exePath": "..." } in .privatecode/settings.json to point at one.',
    )
  }

  const userDataDir = opts.userDataDir ?? profileDir()
  const portFile = join(userDataDir, PORT_FILE)
  try { rmSync(portFile, { force: true }) } catch { /* nothing there is the normal case */ }
  clearStaleLocks(userDataDir)

  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    ...(opts.headless ? ['--headless=new', '--disable-gpu'] : []),
    'about:blank',
  ]

  // No `ResultPromise` annotation: execa 9 parameterises the type by the exact options
  // object, and the generic-free form is not assignable to it under exactOptionalPropertyTypes.
  const child = execa(exePath, args, {
    detached: false,
    // Every stream ignored, and this is load-bearing rather than tidy: a browser spawns
    // renderer and GPU child processes that INHERIT the parent's stdio handles, so a piped
    // stderr stays open long after the browser process itself is gone. execa's promise
    // settles on "exited AND streams closed", so with a pipe here `await child` never
    // returns -- measured: the first integration run hung in teardown for four minutes with
    // the browser already dead. Nothing reads these streams anyway; CDP is the channel.
    stdio: 'ignore',
    windowsHide: false,
    reject: false,
    cleanup: true,
    // An execa *launch* option, not an argument to `kill()`. Passing it to `kill()` -- which
    // is what this code did first -- silently killed nothing at all in execa 9, where the
    // second parameter is an error, not options. The browser then stayed alive holding the
    // profile lock, and every later launch exited immediately because another copy already
    // owned the profile: one wrong argument position, two unrelated-looking symptoms.
    forceKillAfterDelay: 3_000,
  })

  // The process's own 'exit' event, not execa's promise, for the same reason: this fires
  // when the browser is gone, which is the fact every caller here actually wants.
  let exitedResolve!: () => void
  const exited = new Promise<void>((resolve) => { exitedResolve = resolve })
  child.on('exit', () => exitedResolve())
  child.on('error', () => exitedResolve())

  const kill = async (): Promise<void> => {
    try {
      child.kill()
    } catch { /* already gone */ }
    // Bounded: teardown must never be the thing that hangs a shutdown. If the browser is
    // somehow still alive after this, the OS will reap it when the app exits.
    await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 5_000))])
  }

  try {
    const wsUrl = await readDebuggerUrl(portFile, opts.timeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS, exited)
    return { wsUrl, exePath, kill, exited }
  } catch (e) {
    await kill()
    throw e
  }
}

/**
 * Polls for the port file the browser writes once its debugging endpoint is listening.
 *
 * Its first line is the port; its second is the browser-level target path. Both are used:
 * the path is what makes this the *browser* endpoint (`/devtools/browser/<uuid>`) rather
 * than a page one, and assembling it locally avoids a second HTTP round trip to
 * `/json/version` — which on a cold start is sometimes not answering yet even though the
 * port file already exists.
 */
async function readDebuggerUrl(portFile: string, timeoutMs: number, exited: Promise<void>): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let browserExited = false
  void exited.then(() => { browserExited = true })

  for (;;) {
    try {
      const raw = await readFile(portFile, 'utf8')
      const [port, path] = raw.split('\n')
      if (port && path) return `ws://127.0.0.1:${port.trim()}${path.trim()}`
    } catch { /* not written yet */ }

    if (browserExited) {
      throw new Error(
        'The browser exited before it published its debugging port. This usually means ' +
        'another copy is already running with the same profile directory — close it, or ' +
        'set a different "userDataDir".',
      )
    }
    if (Date.now() > deadline) {
      throw new Error(
        `The browser did not publish its debugging port within ${Math.round(timeoutMs / 1000)} s.`,
      )
    }
    await new Promise((r) => setTimeout(r, 50))
  }
}
