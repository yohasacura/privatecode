import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { BrowserManager } from '../../src/browser/manager.js'
import { findBrowser } from '../../src/browser/launcher.js'
import type { Page } from '../../src/browser/page.js'

/**
 * The browser layer against a real browser and a real page.
 *
 * Integration, not unit: it starts Edge (or Chrome), which takes a second and needs one to
 * be installed. The page it drives is served by this file, so the test is entirely offline —
 * which is the same property the tool itself has to have.
 */

const PAGE = `<!doctype html>
<html><head><title>Fixture</title></head>
<body>
  <h1>Hello page</h1>
  <p>Some ordinary text.</p>
  <input id="name" placeholder="your name">
  <button id="go" onclick="document.getElementById('out').textContent = 'clicked ' + document.getElementById('name').value">Go</button>
  <div id="out">nothing yet</div>
  <a href="/second">second page</a>
  <script>
    console.log('page script ran');
    console.error('a deliberate error');
    fetch('/missing').catch(() => {});
  </script>
</body></html>`

const SECOND = '<!doctype html><html><head><title>Second</title></head><body><h2>Second page</h2></body></html>'

let server: Server
let origin = ''
let manager: BrowserManager
let page: Page

const haveBrowser = findBrowser() !== null

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/second') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(SECOND)
      return
    }
    if (req.url === '/missing') {
      res.writeHead(404).end('no')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  origin = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`

  if (!haveBrowser) return
  manager = new BrowserManager({ headless: true })
  page = await manager.open()
}, 60_000)

afterAll(async () => {
  await manager?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe.skipIf(!haveBrowser)('a real browser', () => {
  test('opens a page and reads it as text with refs', async () => {
    const nav = await page.navigate(`${origin}/`)
    expect(nav.timedOut).toBe(false)

    const snap = await page.snapshot()
    expect(snap.title).toBe('Fixture')
    expect(snap.url).toBe(`${origin}/`)
    expect(snap.text).toContain('Hello page')
    expect(snap.text).toContain('Some ordinary text.')
    // Everything interactive is addressable without the model writing a selector.
    expect(snap.text).toMatch(/input .*\[ref_\d+\]/)
    expect(snap.text).toMatch(/button "Go" \[ref_\d+\]/)
    expect(snap.refCount).toBeGreaterThanOrEqual(3)
  })

  test('fills a field and clicks a button, and the page responds', async () => {
    await page.navigate(`${origin}/`)
    const snap = await page.snapshot()
    const inputRef = Number(/input [^\n]*\[ref_(\d+)\]/.exec(snap.text)![1])
    const buttonRef = Number(/button "Go" \[ref_(\d+)\]/.exec(snap.text)![1])

    await page.fill(inputRef, 'Yohas')
    await page.click(buttonRef)

    expect(await page.evaluate('document.getElementById("out").textContent'))
      .toBe('clicked Yohas')
  })

  test('collects console output, including an uncaught error', async () => {
    await page.navigate(`${origin}/`)
    const lines = page.console().map((c) => `${c.level}: ${c.text}`)
    expect(lines.some((l) => l.includes('page script ran'))).toBe(true)
    expect(lines.some((l) => l.includes('a deliberate error'))).toBe(true)
  })

  test('records network requests, failures included', async () => {
    await page.navigate(`${origin}/`)
    // The fetch is fired by the page script; give it a moment to land.
    await new Promise((r) => setTimeout(r, 300))
    const requests = page.network()
    expect(requests.some((r) => r.url.endsWith('/') && r.status === 200)).toBe(true)
    expect(requests.some((r) => r.url.endsWith('/missing') && r.status === 404)).toBe(true)
  })

  test('a stale ref says what to do instead of throwing something opaque', async () => {
    await page.navigate(`${origin}/`)
    await page.snapshot()
    await page.navigate(`${origin}/second`)
    await expect(page.click(0)).rejects.toThrow(/Read the page again/)
  })

  test('goes back promptly, and the URL follows', async () => {
    await page.navigate(`${origin}/`)
    await page.navigate(`${origin}/second`)
    const started = Date.now()
    expect(await page.back()).toBe(true)
    expect(page.url()).toBe(`${origin}/`)
    // A page restored from the back-forward cache fires no load event. Waiting only for one
    // burned the full navigation timeout on every back — 30.5 s, in a test that still passed
    // because the result was right. The assertion is on the clock, not just the URL.
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test('a page that throws reports the message, not a protocol dump', async () => {
    await page.navigate(`${origin}/`)
    await expect(page.evaluate('window.nothingHere.atAll')).rejects.toThrow(/TypeError/)
  })

  test('takes a screenshot a person could actually look at', async () => {
    await page.navigate(`${origin}/`)
    const png = await page.screenshot()
    // PNG magic number: proof it is an image, not an error page rendered as text.
    expect(png.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    expect(png.length).toBeGreaterThan(1000)
  })

  test('relaunches after the browser goes away', async () => {
    await manager.close()
    expect(manager.isRunning()).toBe(false)
    page = await manager.open()
    await page.navigate(`${origin}/`)
    expect((await page.snapshot()).title).toBe('Fixture')
  })
})
