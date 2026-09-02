import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

/**
 * The design system is one vocabulary, and this is what keeps it one.
 *
 * Three features in a row were written against tokens that did not exist — `--line`,
 * `--danger`, `--warn` — in eleven places. CSS does not complain about that: an unresolvable
 * `var()` makes the WHOLE declaration invalid, so `border: 1px solid var(--line)` is not a
 * default-coloured border, it is no border at all. The History tab, the parked-decisions
 * card, the MCP list and the rewind confirmation all silently lost their edges, and the one
 * destructive button in the app lost its red. Nothing failed, nothing logged, and the panels
 * simply looked unfinished — which is exactly how it was reported.
 *
 * A stylesheet has no compiler, so it gets one here. Both halves of the same failure are
 * covered: a token that is used but never declared, and a class that a component asks for
 * but the stylesheet never defines.
 */

const SRC = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
/** The tokens (styles/tokens.css) are declared first, then the stylesheet that uses them. */
const tokensCss = readFileSync(join(SRC, 'styles', 'tokens.css'), 'utf8')
/** Everything that is not a token, in the order main.tsx loads it. */
const STYLE_FILES = ['base.css', 'shell.css', 'composer.css', 'transcript.css']
const appCss = STYLE_FILES.map((f) => readFileSync(join(SRC, 'styles', f), 'utf8')).join('\n')
const css = `${tokensCss}\n${appCss}`

/** Every `--token: value` declaration. */
function declaredTokens(text: string): Set<string> {
  return new Set([...text.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!))
}

/**
 * Every `var(--token)` used WITHOUT a fallback. A `var(--x, something)` is a deliberate
 * optional lookup and is left alone — it degrades to the fallback rather than deleting the
 * declaration, which is the whole difference that matters here.
 */
function usedTokens(text: string): { token: string; line: number }[] {
  const out: { token: string; line: number }[] = []
  const lines = text.split('\n')
  for (const [i, line] of lines.entries()) {
    for (const m of line.matchAll(/var\(\s*(--[a-z0-9-]+)\s*([,)])/g)) {
      if (m[2] === ')') out.push({ token: m[1]!, line: i + 1 })
    }
  }
  return out
}

/** Every `.class` that appears anywhere in a selector. Deliberately generous: this is a
 * "does the stylesheet know this name at all" check, not a specificity model. */
function definedClasses(text: string): Set<string> {
  // Strip declaration blocks so that values like `url(.foo)` or comments cannot contribute.
  const selectorsOnly = text.replace(/\{[^{}]*\}/g, '{}').replace(/\/\*[\s\S]*?\*\//g, '')
  return new Set([...selectorsOnly.matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]!))
}

function tsxFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...tsxFiles(path))
    else if (name.endsWith('.tsx')) out.push(path)
  }
  return out
}

/**
 * Class names from static `class="a b c"` attributes only.
 *
 * Template-literal forms (`class={`tab ${active}`}`) are skipped on purpose: their fragments
 * are assembled at runtime and a scanner that guessed at them would either miss real cases
 * or invent false ones. Both classes this test was written for — `panel-empty` and
 * `card-approval` — were static, which is the common case.
 */
function staticClasses(source: string): string[] {
  const out: string[] = []
  for (const m of source.matchAll(/\bclass="([^"]*)"/g)) {
    for (const token of m[1]!.split(/\s+/)) {
      if (/^[a-z][a-z0-9-]*$/.test(token)) out.push(token)
    }
  }
  return out
}

describe('CSS custom properties', () => {
  test('every token used without a fallback is declared', () => {
    const declared = declaredTokens(css)
    const undeclared = usedTokens(css)
      .filter((u) => !declared.has(u.token))
      .map((u) => `styles:${u.line} uses ${u.token}, which is never declared`)
    expect(undeclared).toEqual([])
  })

  test('the scanner would have caught the bug it was written for', () => {
    // A guard against the guard: a check that silently matches nothing is worse than no
    // check, because it reads as proof. This is the exact shape of the eleven real uses.
    const declared = declaredTokens(':root { --border: #2b2b32; }')
    const used = usedTokens('.ckpt-confirm { border: 1px solid var(--danger); }')
    expect(used).toEqual([{ token: '--danger', line: 1 }])
    expect(declared.has('--danger')).toBe(false)
    // ...and that a fallback is correctly treated as safe.
    expect(usedTokens('.x { color: var(--warn, var(--accent)); }')).toEqual([
      { token: '--accent', line: 1 },
    ])
  })
})

describe('colours', () => {
  test('the stylesheets name no colour that is not a token', () => {
    // A colour written where it is used is a colour the other theme never gets. The
    // tokens file is the one place a hex or an rgb() may appear.
    const withoutComments = appCss.replace(/\/\*[\s\S]*?\*\//g, '')
    const raw = withoutComments
      .split('\n')
      .map((line, i) => ({ line: i + 1, text: line }))
      .filter(({ text }) => /#[0-9a-f]{3,8}\b|rgba?\(/i.test(text))
      .map(({ line, text }) => `styles:${line}: ${text.trim()}`)
    expect(raw).toEqual([])
  })
})

describe('class names', () => {
  test('every static class a component asks for exists in the stylesheet or is a Tailwind utility', async () => {
    // Two vocabularies now: the stylesheet's own classes, and Tailwind's utilities, which
    // exist only if the compiler emits them — a typo like `text-dimm` emits nothing and is
    // otherwise invisible. So the names the stylesheet does not define are handed to the
    // compiler, over the same token file the app builds with, and each must come back.
    const defined = definedClasses(css)
    const candidates = new Map<string, string[]>()
    for (const file of tsxFiles(SRC)) {
      const short = file.slice(SRC.length)
      for (const cls of staticClasses(readFileSync(file, 'utf8'))) {
        if (!defined.has(cls)) candidates.set(cls, [...(candidates.get(cls) ?? []), short])
      }
    }
    const missing: string[] = []
    if (candidates.size > 0) {
      const { compile } = await import('@tailwindcss/node')
      const compiler = await compile(
        '@import "tailwindcss/theme.css"; @import "tailwindcss/utilities.css";\n' +
          tokensCss.replace(/@import[^;]+;/g, '').replace(/@layer theme, base, components, utilities;/, ''),
        { base: join(SRC, 'styles'), onDependency: () => {} },
      )
      const out = compiler.build([...candidates.keys()])
      for (const [cls, files] of candidates) {
        const escaped = cls.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`)
        if (!out.includes(`.${escaped}`)) missing.push(`.${cls} (${[...new Set(files)].join(', ')})`)
      }
    }
    expect(missing).toEqual([])
  })
})
