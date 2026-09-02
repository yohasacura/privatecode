import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { browserTool, type BrowserArgs } from '../src/tools/browser.js'
import { Workspace } from '../src/workspace.js'
import type { ToolContext } from '../src/tools/types.js'

/**
 * The tool's own logic: validation, the permission key, and what it hands back. The browser
 * itself is stubbed — driving a real one is `test/integration/browser.test.ts`'s job, and
 * repeating it here would make this file take thirty seconds to say nothing new.
 */

let root: string

beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'pc-browser-tool-')) })
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

interface StubOptions {
  url?: string | null
  running?: boolean
  text?: string
  onClose?: () => void
}

function ctxWith(stub: StubOptions = {}, workspace?: Workspace): ToolContext {
  const page = {
    url: () => stub.url ?? 'http://localhost:5173/',
    navigate: async () => ({ timedOut: false }),
    snapshot: async () => ({
      url: stub.url ?? 'http://localhost:5173/',
      title: 'Fixture',
      text: stub.text ?? 'button "Go" [ref_0]',
      refCount: 1,
    }),
    click: async () => {},
    fill: async () => {},
    press: async () => {},
    evaluate: async () => '42',
    console: () => [],
    consoleAll: () => [
      { level: 'log', text: 'hello', atMs: 1 },
      { level: 'error', text: 'boom', atMs: 2 },
    ],
    network: () => [],
    networkAll: () => [{ method: 'GET', url: 'http://localhost:5173/api', status: 500 }],
    screenshot: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]),
    back: async () => true,
  }
  const browser = {
    isRunning: () => stub.running ?? true,
    currentUrl: () => (stub.url === null ? null : stub.url ?? 'http://localhost:5173/'),
    open: async () => page as any,
    close: async () => { stub.onClose?.() },
  }
  return { workspace: workspace ?? new Workspace(root), browser: browser as any }
}

const valid = (raw: unknown): BrowserArgs => {
  const v = browserTool.validate(raw)
  if (!v.ok) throw new Error(v.error)
  return v.args
}

describe('validate', () => {
  test('rejects an unknown action', () => {
    const v = browserTool.validate({ action: 'teleport' })
    expect(v.ok).toBe(false)
  })

  test('normalises a URL and keeps the scheme', () => {
    expect(valid({ action: 'open', url: 'http://localhost:5173' }).url).toBe('http://localhost:5173/')
  })

  test('refuses a javascript: URL, and says why it is not a navigation', () => {
    // The one that matters: it runs script in whatever page is open while the approval
    // dialog would render it in the "opening a URL" shape.
    const v = browserTool.validate({ action: 'open', url: 'javascript:fetch("/steal")' })
    expect(v.ok).toBe(false)
    expect((v as { error: string }).error).toMatch(/runs script in whatever page is open/)
  })

  test('refuses file: and points at the tool that is jailed', () => {
    const v = browserTool.validate({ action: 'open', url: 'file:///C:/Windows/win.ini' })
    expect(v.ok).toBe(false)
    expect((v as { error: string }).error).toMatch(/Read/)
  })

  test('a URL with no scheme is a clear error, not a crash', () => {
    const v = browserTool.validate({ action: 'open', url: 'localhost:5173' })
    expect(v.ok).toBe(false)
  })

  test('click and fill need a ref; press needs a known key', () => {
    expect(browserTool.validate({ action: 'click' }).ok).toBe(false)
    expect(browserTool.validate({ action: 'click', ref: -1 }).ok).toBe(false)
    expect(browserTool.validate({ action: 'fill', ref: 0 }).ok).toBe(false)
    expect(browserTool.validate({ action: 'press' }).ok).toBe(false)
    expect(valid({ action: 'press', key: 'Enter' }).key).toBe('Enter')
  })

  test('fill accepts an empty string, which is how a field is cleared', () => {
    expect(valid({ action: 'fill', ref: 0, text: '' }).text).toBe('')
  })
})

describe('the permission key is the origin', () => {
  const keyFor = (raw: unknown, stub: StubOptions = {}) =>
    browserTool.permissionKey!(valid(raw), ctxWith(stub))

  test('open is keyed on the URL being requested', () => {
    expect(keyFor({ action: 'open', url: 'https://example.dev/app' }))
      .toEqual({ tool: 'browser', target: 'https://example.dev/app' })
  })

  test('every other action is keyed on the page already open', () => {
    // Which the user approved when it was opened, so the same rule covers acting on it.
    for (const action of ['read', 'console', 'network', 'screenshot', 'back'] as const) {
      expect(keyFor({ action })).toEqual({ tool: 'browser', target: 'http://localhost:5173/' })
    }
    expect(keyFor({ action: 'click', ref: 0 }))
      .toEqual({ tool: 'browser', target: 'http://localhost:5173/' })
    expect(keyFor({ action: 'eval', expression: '1+1' }))
      .toEqual({ tool: 'browser', target: 'http://localhost:5173/' })
  })

  test('close is a control operation and carries no target', () => {
    // Same shape as background_task's stop: the approval happened when it started.
    expect(keyFor({ action: 'close' })).toEqual({ tool: 'browser' })
  })

  test('with no page open there is no origin to name, and the key stays bare', () => {
    expect(keyFor({ action: 'read' }, { url: null })).toEqual({ tool: 'browser' })
  })
})

describe('approvalPreview', () => {
  test('warns about the first launch only while nothing is running', () => {
    const args = valid({ action: 'open', url: 'http://localhost:5173/' })
    expect(browserTool.approvalPreview!(args, ctxWith({ running: false })).detail)
      .toMatch(/starts Microsoft Edge/)
    expect(browserTool.approvalPreview!(args, ctxWith({ running: true })).detail)
      .not.toMatch(/starts Microsoft Edge/)
  })

  test('names the page an action will act on', () => {
    const preview = browserTool.approvalPreview!(valid({ action: 'click', ref: 3 }), ctxWith())
    expect(preview.detail).toContain('Click ref_3')
    expect(preview.detail).toContain('http://localhost:5173/')
  })

  test('shows the whole expression for eval, which is the thing being approved', () => {
    const preview = browserTool.approvalPreview!(
      valid({ action: 'eval', expression: 'localStorage.clear()' }), ctxWith())
    expect(preview.detail).toContain('localStorage.clear()')
  })
})

describe('execute', () => {
  test('refuses an action that needs a page when nothing is open', async () => {
    const result = await browserTool.execute(valid({ action: 'read' }), ctxWith({ running: false }))
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/action="open"/)
  })

  test('open returns the page as text and flags console errors', async () => {
    const result = await browserTool.execute(
      valid({ action: 'open', url: 'http://localhost:5173/' }), ctxWith())
    expect(result.ok).toBe(true)
    expect(result.content).toContain('button "Go" [ref_0]')
  })

  test('a click reports what the page became, not just that it clicked', async () => {
    // Otherwise the model spends a whole extra step asking what changed.
    const result = await browserTool.execute(valid({ action: 'click', ref: 0 }), ctxWith())
    expect(result.content).toContain('Clicked ref_0')
    expect(result.content).toContain('button "Go" [ref_0]')
  })

  test('page text over the cap is paged, not elided', async () => {
    const huge = Array.from({ length: 3000 }, (_, i) => `line ${i} of a very long page`).join('\n')
    const result = await browserTool.execute(valid({ action: 'read' }), ctxWith({ text: huge }))
    expect(result.content).toMatch(/Read\(path="\.privatecode\/state\/logs\//)
    expect(result.content!.length).toBeLessThan(huge.length)
    // The person watching gets all of it.
    expect(result.display!.length).toBeGreaterThan(huge.length - 100)
  })

  test('console gives the model a bounded copy and the user every line', async () => {
    const result = await browserTool.execute(valid({ action: 'console' }), ctxWith())
    expect(result.content).toContain('[error] boom')
    expect(result.display).toContain('[log] hello')
  })

  test('network renders status, method and failure reason', async () => {
    const result = await browserTool.execute(valid({ action: 'network' }), ctxWith())
    expect(result.content).toContain('500 GET http://localhost:5173/api')
  })

  test('a screenshot lands on disk and says the model cannot read it', async () => {
    const result = await browserTool.execute(valid({ action: 'screenshot' }), ctxWith())
    expect(result.ok).toBe(true)
    expect(result.content).toMatch(/You cannot read images/)
    // Timestamped, not counted: a module-level counter restarts at 0 in every process, so
    // the first screenshot of each session overwrote the previous session's shot-001.png.
    const relative = /(\.privatecode\/state\/browser\/shot-[\d-]+\.png)/.exec(result.content!)![1]!
    expect(readFileSync(join(root, relative)).subarray(0, 4))
      .toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  })

  test('and its path is one the workspace can actually resolve, with folders attached', async () => {
    // The path used to be assembled from constants, so in a multi-folder workspace — where
    // the first segment must name a mount — it was not a path anything could resolve. The
    // decisive victim was the UI: the transcript matches this string and calls fs.read on
    // it, and the host's resolve threw, so the inline image (the only reason the PNG is
    // written at all) rendered as an error.
    const app = join(root, 'app')
    const engine = join(root, 'engine')
    mkdirSync(app, { recursive: true })
    mkdirSync(engine, { recursive: true })
    const multi = new Workspace([
      { name: 'app', root: app, access: 'write', primary: true },
      { name: 'engine', root: engine, access: 'write', primary: false },
    ])
    const result = await browserTool.execute(valid({ action: 'screenshot' }), ctxWith({}, multi))
    const relative = /(app\/[^\s]+\.png)/.exec(result.content!)![1]!
    // The model's own tools would accept it...
    expect(() => multi.resolve(relative)).not.toThrow()
    // ...and it is the file that was written.
    expect(readFileSync(multi.resolve(relative)).subarray(0, 4))
      .toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  })

  test('close shuts the browser down and does not need a page first', async () => {
    let closed = false
    const result = await browserTool.execute(
      valid({ action: 'close' }), ctxWith({ running: false, onClose: () => { closed = true } }))
    expect(result.ok).toBe(true)
    expect(closed).toBe(true)
  })

  test('a page-side failure comes back as a tool message, never as a throw', async () => {
    const ctx = ctxWith()
    ;(ctx.browser as any).open = async () => ({
      url: () => 'http://x/',
      snapshot: async () => { throw new Error('Target closed') },
    })
    const result = await browserTool.execute(valid({ action: 'read' }), ctx)
    expect(result.ok).toBe(false)
    expect(result.content).toContain('Target closed')
  })

  test('with no browser in the context the tool says so instead of crashing', async () => {
    const result = await browserTool.execute(valid({ action: 'read' }), { workspace: new Workspace(root) })
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/not available/)
  })
})

describe('the tool is not plan-safe', () => {
  test('readOnly is false, which is the only thing plan mode consults', () => {
    // Opening a page starts a process and reaches the network. `registry.readOnlyNames()`
    // is the sole basis for plan mode's tool list, so this flag IS the guarantee.
    expect(browserTool.readOnly).toBe(false)
  })
})
