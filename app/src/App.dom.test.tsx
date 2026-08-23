// @vitest-environment happy-dom
import { render } from 'preact'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

/**
 * The four behaviours the audit fixed and no test could reach.
 *
 * They are all about which listener OWNS the Escape key, and about a component reading a
 * value from the host instead of from a stale copy of its own — questions that only exist
 * in a document, with real event propagation and real components mounted. The rest of this
 * suite runs in `node` because it tests pure functions; this file opts into a DOM and pays
 * for it (see vitest.config.ts).
 *
 * The client is faked at the module boundary rather than the socket: what these tests need
 * from the host is that it answers, not how it is reached. Every method resolves with the
 * emptiest shape the panels accept, so mounting App exercises the real component tree.
 */

const calls: { method: string; params: unknown }[] = []
/** What `config.get` answers next. The reopen test changes it mid-run, which is exactly
 * what Settings does when it applies a new server URL without telling App. */
let savedServerUrl = 'http://127.0.0.1:8080'
/** What `config.get` answers for the recent list. Empty means the app lands on the WELCOME
 * screen instead of auto-connecting — the state in which the update notice did not exist. */
let savedRecents: string[] = ['D:\\proj']
/** What the update check "finds", if anything. */
let updateToOffer: import('./lib/update').UpdateAvailable | null = null

/** What `/props` had said by the time the session was built. `null` is a session built while
 * the model server was down — the state the context-readout test below is about. */
let initContextLength: number | null = 262144

function fakeResult(method: string): unknown {
  switch (method) {
    case 'config.get': return { serverUrl: savedServerUrl, recentWorkspaces: savedRecents }
    case 'init': return {
      sessionId: 's1', mode: 'normal', contextLength: initContextLength, title: '',
      // The real shape: the server's own count (null until a step runs in this process) and
      // the transcript's estimate, which is always available.
      contextUsed: { promptTokens: null, approxTokens: 4200 },
      items: [], problems: [], workspaceName: 'proj', folderCount: 1,
    }
    case 'sessions.list': return { sessions: [], problems: [] }
    case 'decisions.list': return { decisions: [] }
    case 'workspace.get': return { name: 'proj', folders: [], problems: [] }
    case 'workspace.set': return {}
    case 'git.status': return { repos: [], unversioned: [] }
    // One file, so there is something to open as a tab — which is the state every
    // Escape question below is asked in.
    case 'fs.tree': return { entries: [{ name: 'a.ts', dir: false }] }
    case 'fs.read': return { lines: ['export const a = 1'], truncated: false }
    case 'jobs.list': return { jobs: [] }
    case 'status': return { serverUp: true, model: 'qwen', contextLength: 262144 }
    case 'commands.list': return { commands: [] }
    default: return {}
  }
}

// Stubbed because the real one waits twenty seconds and then talks to GitHub. What is under
// test here is WHERE the notice renders, not when it is found.
vi.mock('./lib/update', async () => {
  const actual = await vi.importActual<typeof import('./lib/update')>('./lib/update')
  return {
    ...actual,
    scheduleUpdateCheck: (onAvailable: (u: import('./lib/update').UpdateAvailable) => void) => {
      if (updateToOffer !== null) onAvailable(updateToOffer)
      return () => {}
    },
  }
})

vi.mock('./lib/client', async () => {
  const actual = await vi.importActual<typeof import('./lib/client')>('./lib/client')
  return {
    ...actual,
    wsUrlFromSearch: () => undefined,
    sidecarStderr: async () => [],
    restartSidecar: async () => {},
    createClient: () => ({
      call: (method: string, params: unknown) => {
        calls.push({ method, params })
        return Promise.resolve(fakeResult(method))
      },
      on: () => () => {},
      onStateChange: () => () => {},
      state: () => 'open',
      close: () => {},
    }),
  }
})

// Imported AFTER the mock is declared, so App's own `import { createClient }` resolves to it.
const { default: App } = await import('./App')

let host: HTMLDivElement
/** Stands in for the composer's own window-level Escape-to-abort listener: it is registered
 * the same way (window, BUBBLE phase), so if a capture-phase owner up the chain fails to
 * stop the key, this fires — which in the real window means a running turn is killed. */
let abortsSeen: number

beforeEach(async () => {
  calls.length = 0
  savedServerUrl = 'http://127.0.0.1:8080'
  savedRecents = ['D:\\proj']
  updateToOffer = null
  initContextLength = 262144
  abortsSeen = 0
  host = document.createElement('div')
  document.body.appendChild(host)
  render(<App />, host)
  await settle()
  window.addEventListener('keydown', countAbort)
})

afterEach(() => {
  window.removeEventListener('keydown', countAbort)
  render(null, host)
  host.remove()
})

function countAbort(e: KeyboardEvent): void {
  if (e.key === 'Escape') abortsSeen++
}

/**
 * Let every queued effect and promise run.
 *
 * Real timer ticks, not just microtasks: Preact defers `useEffect` to after paint —
 * `requestAnimationFrame`, which happy-dom services from a timer — so a bare
 * `await Promise.resolve()` chain returns before a single effect has run, and the boot
 * path (config.get -> init -> config.set -> decisions.list) is several effects deep.
 */
async function settle(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise((r) => setTimeout(r, 20))
  }
}

function pressEscape(target: EventTarget = window): void {
  target.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, cancelable: true,
  }))
}

/** Opens a file tab the way the transcript does, through the tree row's own click. */
async function openFileTab(): Promise<void> {
  const row = [...document.querySelectorAll('.tree-row')]
    .find((r) => r.querySelector('.tree-name')?.textContent === 'a.ts')
  expect(row, 'the fake fs.tree entry should render a row').toBeTruthy()
  ;(row as HTMLElement).click()
  await settle()
  expect(document.querySelector('.chat-face-hidden')).not.toBeNull()
}

test('the window reaches a workspace with the chat mounted', () => {
  // The harness itself, asserted once: everything below rests on App having got past boot.
  expect(calls.some((c) => c.method === 'init')).toBe(true)
  expect(document.querySelector('.chat-face')).not.toBeNull()
})

test('Escape returns to the chat, and does not travel on to abort the turn', async () => {
  await openFileTab()
  pressEscape()
  await settle()

  expect(document.querySelector('.chat-face-hidden')).toBeNull()
  // Stopped in capture by App's own handler: the composer's listener never sees it.
  expect(abortsSeen).toBe(0)
})

test('a command picker left open in the HIDDEN chat does not eat the Escape', async () => {
  await openFileTab()
  // The state the fix is about: a picker opened by a stray `/` before the file tab was
  // fronted. The chat face is display:none, not unmounted, so a bare `.command-picker`
  // selector still matched it — Escape then did nothing visible AND reached the abort.
  const chat = document.querySelector('.chat-face')!
  const stale = document.createElement('div')
  stale.className = 'command-picker'
  chat.appendChild(stale)

  pressEscape()
  await settle()

  expect(document.querySelector('.chat-face-hidden')).toBeNull()
  expect(abortsSeen).toBe(0)
})

test('Escape in the workspace rename box cancels the box and keeps the file tab fronted', async () => {
  await openFileTab()
  const title = document.querySelector<HTMLElement>('.workspace-title')
  expect(title, 'the workspace tab should offer its name for renaming').toBeTruthy()
  title!.click()
  await settle()

  const input = document.querySelector<HTMLInputElement>('.workspace-name-input')
  expect(input).not.toBeNull()
  pressEscape(input!)
  await settle()

  // The box closed itself — which it can only do if the key reached it.
  expect(document.querySelector('.workspace-name-input')).toBeNull()
  // ...and the window did NOT jump back to the chat behind it.
  expect(document.querySelector('.chat-face-hidden')).not.toBeNull()
})

test('Escape in the Switch-workspace dialog closes it without aborting the turn', async () => {
  const swap = document.querySelector<HTMLElement>('[title^="Switch workspace"]')
  expect(swap, 'the workspace header should carry the switch button').toBeTruthy()
  swap!.click()
  await settle()
  expect(document.querySelector('.modal-overlay')).not.toBeNull()

  pressEscape()
  await settle()

  expect(document.querySelector('.modal-overlay')).toBeNull()
  expect(abortsSeen).toBe(0)
})

test('Ctrl+K over the Switch-workspace dialog does not open the palette under it', async () => {
  // Both surfaces are .modal-overlay at the same z-index and the palette renders FIRST, so
  // the switcher paints over a live palette whose autofocused input owns every keystroke;
  // Enter then fires whatever it had highlighted. Escape cannot untangle it either -- the
  // palette declines Escape while a .modal is up, so Escape closes the switcher and leaves
  // the palette behind. App documented this exact failure for Settings and guarded only that.
  const swap = document.querySelector<HTMLElement>('[title^="Switch workspace"]')!
  swap.click()
  await settle()
  const before = document.querySelectorAll('.modal-overlay').length
  expect(before).toBe(1)

  window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'k', ctrlKey: true, bubbles: true, cancelable: true,
  }))
  await settle()

  expect(document.querySelectorAll('.modal-overlay').length).toBe(before)
  expect(document.querySelector('.palette')).toBeNull()

  pressEscape()
  await settle()
  expect(document.querySelector('.modal-overlay')).toBeNull()
})

test('a reopen after a folder edit uses the server URL the HOST has, not the one from launch', async () => {
  // Settings applies a new URL with its own init + config.set and never tells App. Before
  // the fix, the next folder edit re-opened with App's launch-time copy and persisted it
  // back over the user's choice.
  savedServerUrl = 'http://127.0.0.1:9099'

  const title = document.querySelector<HTMLElement>('.workspace-title')!
  title.click()
  await settle()
  const input = document.querySelector<HTMLInputElement>('.workspace-name-input')!
  input.value = 'renamed'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await settle()

  const inits = calls.filter((c) => c.method === 'init')
  expect(inits.length).toBeGreaterThan(1)
  const last = inits[inits.length - 1]!
  expect((last.params as { serverUrl: string }).serverUrl).toBe('http://127.0.0.1:9099')
})

/**
 * The context readout, when the session was built before the model server was up.
 *
 * There are two copies of the window size: the session's, captured once when it is built,
 * and the one the status bar polls every ten seconds. The bar used only the first, so
 * starting the app with the server down left it null forever — nothing re-seeds it — and the
 * whole readout, bar and figures alike, never rendered. It did not come back when the server
 * did. Reported as "the context bar has disappeared and I cannot tell how full it is".
 */
test('the context readout appears once the server answers, even if it was down at first', async () => {
  render(null, host)
  // A session built while /props had nothing to say.
  initContextLength = null
  render(<App />, host)
  await settle()

  // The poll answers with a real window, and `contextUsed.approxTokens` was there all along,
  // so there is a true reading to show.
  const readout = host.querySelector('.status-context')
  expect(readout).not.toBeNull()
  expect(readout?.textContent).toContain('262.1k')
  expect(host.querySelector('.ctx-fill')).not.toBeNull()
})

test('and when the two copies disagree, the FRESHER one wins', async () => {
  // This test used to assert the opposite, on the reasoning that the session's copy was the
  // number compaction was calibrated against. An audit refuted that: when the server comes
  // back with a different -c, the host re-calibrates the live core session
  // (`refreshServerProps` -> `setContextLength`) and the app's frozen copy is the ONLY thing
  // still holding the dead number — nothing in the app rewrites it, there is no protocol
  // event for a window change. Preferring it meant dividing by a window that no longer
  // exists: "150.0k/131.1k", pinned red, while the engine sat at 57%.
  render(null, host)
  initContextLength = 131_072
  render(<App />, host)
  await settle()

  const readout = host.querySelector('.status-context')
  expect(readout?.textContent).toContain('262.1k')
  expect(readout?.textContent).not.toContain('131.1k')
})

test('the update notice is shown before any folder is open, not only inside a workspace', async () => {
  // It used to be a child of the chat pane, which does not exist until a workspace is
  // open: launch the app, do not pick a folder, and nothing ever mentioned the update.
  // Found by running the real 0.1.0 -> 0.1.1 release and looking for a banner that was not
  // there. Before starting work is the moment when taking an update costs nothing.
  render(null, host)
  savedRecents = []
  updateToOffer = {
    currentVersion: '0.1.0',
    newVersion: '0.1.1',
    downloadBytes: 4_567_499,
    notesUrl: 'https://example.invalid/releases/latest',
  }
  render(<App />, host)
  await settle()

  // The welcome screen, genuinely: no workspace body anywhere in the document.
  expect(host.querySelector('.body')).toBeNull()
  expect(host.querySelector('.welcome-card')).not.toBeNull()

  const strip = host.querySelector('.update-strip')
  expect(strip).not.toBeNull()
  expect(strip?.textContent).toContain('0.1.1')
  // The size of the UPDATE, not of the release -- the number that decides whether a person
  // says yes.
  expect(strip?.textContent).toContain('4.4 MB')
})

test('and it stays put once a workspace is open', async () => {
  // The move must not cost the case that already worked.
  render(null, host)
  updateToOffer = {
    currentVersion: '0.1.0',
    newVersion: '0.1.1',
    downloadBytes: 4_567_499,
    notesUrl: 'https://example.invalid/releases/latest',
  }
  render(<App />, host)
  await settle()

  expect(host.querySelector('.body')).not.toBeNull()
  expect(host.querySelector('.update-strip')).not.toBeNull()
})
