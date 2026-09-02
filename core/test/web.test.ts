import { describe, expect, test } from 'vitest'
import { PermissionEngine } from '../src/permissions/engine.js'
import type { PermissionKey } from '../src/tools/types.js'
import { webFetchTool, webSearchTool } from '../src/tools/web.js'
import {
  extractReadable, isPrivateHost, redirectRefusal, redirectRefusalResolved,
} from '../src/web/read.js'
import { parseBingResults, parseDdgResults, renderHits, unwrapDdgHref } from '../src/web/search.js'

// ---------------------------------------------------------------------------------------
// Parsers on canned fixtures. No test in this file touches the network: the endpoints'
// layouts are captured here as the contract, and a live layout change shows up as a live
// failure, not a red suite on an offline machine.
// ---------------------------------------------------------------------------------------

const DDG_PAGE = `
<html><body>
  <div class="result results_links results_links_deep web-result result--ad">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fads.example%2F">Buy things</a>
    <a class="result__snippet" href="#">sponsored</a>
  </div>
  <div class="result results_links results_links_deep web-result">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fen%2Fabout&amp;rut=abc">About Node.js</a>
    <a class="result__snippet" href="#">Node.js is a JavaScript runtime built on V8.</a>
  </div>
  <div class="result results_links results_links_deep web-result">
    <a rel="nofollow" class="result__a" href="https://example.com/direct">A direct link</a>
  </div>
</body></html>`

const BING_PAGE = `
<html><body><ol id="b_results">
  <li class="b_algo">
    <h2><a href="https://nodejs.org/en">Node.js — Run JavaScript Everywhere</a></h2>
    <div class="b_caption"><p>Node.js® is a free, open-source, cross-platform runtime.</p></div>
  </li>
  <li class="b_algo"><h2><a href="">broken, skipped</a></h2></li>
  <li class="b_algo">
    <h2><a href="https://en.wikipedia.org/wiki/Node.js">Node.js - Wikipedia</a></h2>
    <p>Node.js is a cross-platform JavaScript runtime environment.</p>
  </li>
</ol></body></html>`

describe('search result parsing', () => {
  test('DDG: unwraps redirect hrefs, skips ads, keeps direct links', () => {
    const hits = parseDdgResults(DDG_PAGE)
    expect(hits).toHaveLength(2)
    expect(hits[0]).toEqual({
      title: 'About Node.js',
      url: 'https://nodejs.org/en/about',
      snippet: 'Node.js is a JavaScript runtime built on V8.',
    })
    expect(hits[1]!.url).toBe('https://example.com/direct')
  })

  test('Bing: b_algo items with either caption shape, empty hrefs skipped', () => {
    const hits = parseBingResults(BING_PAGE)
    expect(hits).toHaveLength(2)
    expect(hits[0]!.url).toBe('https://nodejs.org/en')
    expect(hits[0]!.snippet).toMatch(/open-source/)
    expect(hits[1]!.title).toBe('Node.js - Wikipedia')
  })

  test('a captcha page parses as zero results, never as a throw', () => {
    expect(parseDdgResults('<html><body>Unfortunately, bots are not allowed</body></html>')).toEqual([])
    expect(parseBingResults('<html><body></body></html>')).toEqual([])
  })

  test('unwrapDdgHref decodes the uddg param and passes real URLs through', () => {
    expect(unwrapDdgHref('//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.dev%2Fx%3Fy%3D1'))
      .toBe('https://a.dev/x?y=1')
    expect(unwrapDdgHref('https://plain.example/page')).toBe('https://plain.example/page')
  })

  test('renderHits is numbered and names the engine', () => {
    const text = renderHits(parseDdgResults(DDG_PAGE), 'duckduckgo')
    expect(text).toMatch(/^1\. About Node\.js/m)
    expect(text).toMatch(/2 results via duckduckgo/)
  })
})

// ---------------------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------------------

const ARTICLE = `
<html><head><title>How the thing works — Docs</title></head><body>
  <nav><a href="/">Home</a><a href="/docs">Docs</a></nav>
  <article>
    <h1>How the thing works</h1>
    ${'<p>The thing works by doing the work, one unit at a time, until none remains.</p>'.repeat(12)}
  </article>
  <footer>© nobody</footer>
</body></html>`

describe('extractReadable', () => {
  test('an article page yields its text and title, and is not a JS shell', () => {
    const r = extractReadable(ARTICLE, 'https://docs.example/thing')
    expect(r.title).toMatch(/How the thing works/)
    expect(r.text).toMatch(/one unit at a time/)
    expect(r.text).not.toMatch(/<p>/)
    expect(r.jsShell).toBe(false)
  })

  test('a large document with no readable text is flagged as a JS shell', () => {
    const shell = `<html><body><div id="root"></div><script>${'x'.repeat(6_000)}</script></body></html>`
    const r = extractReadable(shell, 'https://spa.example')
    expect(r.jsShell).toBe(true)
  })

  test('a small plain page is short but NOT a shell — a 404 is legitimately terse', () => {
    const r = extractReadable('<html><body>Not found</body></html>', 'https://x.example/404')
    expect(r.jsShell).toBe(false)
    expect(r.text).toBe('Not found')
  })
})

// ---------------------------------------------------------------------------------------
// Redirect policy — pure, so the network never has to be involved to prove it
// ---------------------------------------------------------------------------------------

describe('redirect gating', () => {
  test('isPrivateHost knows loopback, RFC1918, link-local and the localhost family', () => {
    for (const h of ['localhost', 'api.localhost', '127.0.0.1', '127.8.9.1', '10.0.0.5',
      '172.16.0.1', '172.31.255.1', '192.168.50.71', '169.254.1.1', '0.0.0.0', '::1']) {
      expect(isPrivateHost(h), h).toBe(true)
    }
    for (const h of ['nodejs.org', '8.8.8.8', '172.32.0.1', '172.15.0.1', '193.168.1.1']) {
      expect(isPrivateHost(h), h).toBe(false)
    }
  })

  test('a public page may not redirect into a private address — the llama server lives there', () => {
    const publicStart = new URL('https://evil.example/page')
    expect(redirectRefusal(publicStart, new URL('http://127.0.0.1:8080/completion'))).toMatch(/private address/)
    expect(redirectRefusal(publicStart, new URL('http://localhost:8917/'))).toMatch(/private address/)
    expect(redirectRefusal(publicStart, new URL('http://192.168.50.71/x'))).toMatch(/private address/)
  })

  test('ordinary redirects stay ordinary', () => {
    const publicStart = new URL('https://example.com/a')
    expect(redirectRefusal(publicStart, new URL('https://www.example.com/a'))).toBeNull()
    expect(redirectRefusal(publicStart, new URL('https://other.example/b'))).toBeNull()
    // A private START may bounce within private space: a dev server redirecting itself.
    expect(redirectRefusal(new URL('http://localhost:5173/'), new URL('http://localhost:5173/app'))).toBeNull()
    expect(redirectRefusal(new URL('http://localhost:5173/'), new URL('http://127.0.0.1:5173/app'))).toBeNull()
  })

  test('non-http(s) redirect targets are refused outright', () => {
    expect(redirectRefusal(new URL('https://a.dev/'), new URL('file:///C:/x'))).toMatch(/only http/)
  })

  test('the IPv6 spellings of loopback are private too', () => {
    // WHATWG serialises `http://[::ffff:127.0.0.1]/` to the hostname `::ffff:7f00:1`,
    // which is 127.0.0.1 and which the dotted-quad matcher never saw.
    for (const h of ['[::1]', '::ffff:7f00:1', '::ffff:127.0.0.1', '[::]', 'fd00::1',
      'fdff:ffff::1', 'fe80::1', 'fe80::1%eth0']) {
      expect(isPrivateHost(h), h).toBe(true)
    }
    for (const h of ['2606:4700::1', '::ffff:8.8.8.8', '::ffff:808:808', '[2001:4860:4860::8888]']) {
      expect(isPrivateHost(h), h).toBe(false)
    }
    expect(isPrivateHost(new URL('http://[::ffff:127.0.0.1]:8080/props').hostname)).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------
// The same gate once the name is resolved. The resolver is a parameter, so none of this
// asks the network — or a DNS server — anything.
// ---------------------------------------------------------------------------------------

const resolvesTo = (map: Record<string, string[]>) =>
  async (hostname: string): Promise<string[]> => {
    const answer = map[hostname]
    if (answer === undefined) throw new Error(`ENOTFOUND ${hostname}`)
    return answer
  }

describe('resolved redirect gating', () => {
  const publicStart = new URL('https://evil.example/page')

  test('a public name that resolves to loopback is refused, and the refusal says so', async () => {
    // lvh.me and 127.0.0.1.nip.io are real public domains whose A record is 127.0.0.1.
    const refusal = await redirectRefusalResolved(
      publicStart,
      new URL('http://lvh.me:8080/props'),
      resolvesTo({ 'lvh.me': ['127.0.0.1'] }),
    )
    expect(refusal).toMatch(/private address/)
    expect(refusal).toContain('lvh.me')
    expect(refusal).toContain('127.0.0.1')
  })

  test('one private answer among several is enough to refuse', async () => {
    const refusal = await redirectRefusalResolved(
      publicStart,
      new URL('http://dual.example/x'),
      resolvesTo({ 'dual.example': ['93.184.216.34', '::1'] }),
    )
    expect(refusal).toMatch(/private address/)
  })

  test('an ordinary public hop still goes through', async () => {
    expect(await redirectRefusalResolved(
      publicStart,
      new URL('https://docs.example/a'),
      resolvesTo({ 'docs.example': ['93.184.216.34'] }),
    )).toBeNull()
  })

  test('a name that will not resolve is left to fail at the fetch, not accused here', async () => {
    expect(await redirectRefusalResolved(
      publicStart,
      new URL('https://gone.example/a'),
      resolvesTo({}),
    )).toBeNull()
  })

  test('the resolver is spared when the spelling already settles it', async () => {
    const asked: string[] = []
    const resolver = async (hostname: string): Promise<string[]> => {
      asked.push(hostname)
      return ['93.184.216.34']
    }
    // Same origin: still inside what was approved.
    expect(await redirectRefusalResolved(
      publicStart, new URL('https://evil.example/other'), resolver,
    )).toBeNull()
    // A private start may bounce within private space — a dev server redirecting itself.
    expect(await redirectRefusalResolved(
      new URL('http://localhost:5173/'), new URL('http://localhost:5173/app'), resolver,
    )).toBeNull()
    // An address literal was judged exactly by the lexical pass, either way.
    expect(await redirectRefusalResolved(
      publicStart, new URL('http://127.0.0.1:8080/completion'), resolver,
    )).toMatch(/private address/)
    expect(await redirectRefusalResolved(
      publicStart, new URL('http://93.184.216.34/x'), resolver,
    )).toBeNull()
    expect(asked).toEqual([])
  })

  test('the lexical refusals keep their shape and cost no lookup', async () => {
    const resolver = async (): Promise<string[]> => {
      throw new Error('the resolver must not be asked')
    }
    expect(await redirectRefusalResolved(
      publicStart, new URL('http://localhost:8917/'), resolver,
    )).toMatch(/a public page redirected into a private address/)
    expect(await redirectRefusalResolved(
      new URL('https://a.dev/'), new URL('file:///C:/x'), resolver,
    )).toMatch(/only http/)
  })
})

// ---------------------------------------------------------------------------------------
// The tool's contract surface
// ---------------------------------------------------------------------------------------

describe('WebSearch and WebFetch validate + permission keys', () => {
  test('refuses junk and non-http schemes, accepts the two real shapes', () => {
    expect(webSearchTool.validate({}).ok).toBe(false)
    expect(webSearchTool.validate({ query: '  ' }).ok).toBe(false)
    expect(webSearchTool.validate({ query: 'x'.repeat(500) }).ok).toBe(false)
    expect(webFetchTool.validate({ url: 'notaurl' }).ok).toBe(false)
    expect(webFetchTool.validate({ url: 'file:///C:/secrets.txt' }).ok).toBe(false)
    // Credentials in a URL poison the permission key and can never match an origin rule.
    expect(webFetchTool.validate({ url: 'https://user:pass@host.example/x' }).ok).toBe(false)
    expect(webSearchTool.validate({ query: 'node lts version' }).ok).toBe(true)
    expect(webFetchTool.validate({ url: 'https://nodejs.org/en' }).ok).toBe(true)
  })

  test('search carries the fixed target; fetch carries the URL', () => {
    expect(webSearchTool.permissionKey!({ query: 'q' }, {} as never))
      .toEqual({ tool: 'WebSearch', target: 'search' })
    expect(webFetchTool.permissionKey!({ url: 'https://a.dev/x' }, {} as never))
      .toEqual({ tool: 'WebFetch', target: 'https://a.dev/x' })
  })
})

// ---------------------------------------------------------------------------------------
// The engine: search free, reads gated, deny still king
// ---------------------------------------------------------------------------------------

const root = 'C:\\ws'
const engineIn = (mode: 'normal' | 'plan' | 'auto-edit' | 'autopilot') =>
  new PermissionEngine({ layers: [], mode, workspaceRoot: root })

const SEARCH: PermissionKey = { tool: 'WebSearch', target: 'search' }
const READ: PermissionKey = { tool: 'WebFetch', target: 'https://stackoverflow.com/q/1' }

describe('web permissions', () => {
  test('search is free in every working mode; reads ask like the browser', () => {
    for (const mode of ['normal', 'auto-edit', 'autopilot'] as const) {
      expect(engineIn(mode).decide(SEARCH).verdict).toBe('allow')
    }
    expect(engineIn('normal').decide(READ).verdict).toBe('ask')
    expect(engineIn('auto-edit').decide(READ).verdict).toBe('ask')
    expect(engineIn('autopilot').decide(READ).verdict).toBe('allow')
  })

  test('plan mode denies the whole tool — network is not plan-safe', () => {
    expect(engineIn('plan').decide(SEARCH).verdict).toBe('deny')
    expect(engineIn('plan').decide(READ).verdict).toBe('deny')
  })

  test('an explicit deny rule still kills search — the kill switch stands', () => {
    const engine = new PermissionEngine({
      layers: [{ scope: 'project', path: 'p', permissions: { allow: [], ask: [], deny: ['WebSearch', 'WebFetch'] } }],
      mode: 'autopilot',
      workspaceRoot: root,
    })
    expect(engine.decide(SEARCH).verdict).toBe('deny')
    expect(engine.decide(READ).verdict).toBe('deny')
  })

  test('a rule written before the rename still works: web(search) and web(origin)', () => {
    const engine = new PermissionEngine({
      layers: [{ scope: 'project', path: 'p', permissions: { allow: [], ask: [], deny: ['web(search)', 'web(https://stackoverflow.com:*)'] } }],
      mode: 'autopilot',
      workspaceRoot: root,
    })
    expect(engine.decide(SEARCH).verdict).toBe('deny')
    expect(engine.decide(READ).verdict).toBe('deny')
  })

  test('an origin allow rule lets fetches through without asking', () => {
    const engine = new PermissionEngine({
      layers: [{
        scope: 'project', path: 'p',
        permissions: { allow: ['WebFetch(https://stackoverflow.com:*)'], ask: [], deny: [] },
      }],
      mode: 'normal',
      workspaceRoot: root,
    })
    expect(engine.decide(READ).verdict).toBe('allow')
    expect(engine.decide({ tool: 'WebFetch', target: 'https://elsewhere.dev/x' }).verdict).toBe('ask')
  })
})
