import { Lexer, type Token, type Tokens } from 'marked'
import type { ComponentChildren, VNode } from 'preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { memo } from 'preact/compat'
import { highlight } from './highlight'

/**
 * Markdown -> Preact VNodes, with NO HTML pass-through anywhere.
 *
 * The security posture (plan 4, Global Constraint 6) is that model-controlled strings
 * never reach an HTML sink: this renderer keeps that guarantee while still giving the
 * chat real formatting. `marked` is used ONLY as a tokenizer (`Lexer`); every token is
 * mapped to JSX below, where all strings become text nodes that Preact escapes. Raw
 * `html` tokens are rendered as literal text, links render their text + the URL as plain
 * text (never an href built from model output), and images render as their alt text.
 */

/** Unescape the HTML entities marked bakes into token.text for inline content. */
function unescapeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function renderInline(tokens: Token[] | undefined, keyBase: string): ComponentChildren[] {
  if (!tokens) return []
  return tokens.map((t, i) => {
    const key = `${keyBase}-${i}`
    switch (t.type) {
      case 'strong':
        return <strong key={key}>{renderInline((t as Tokens.Strong).tokens, key)}</strong>
      case 'em':
        return <em key={key}>{renderInline((t as Tokens.Em).tokens, key)}</em>
      case 'del':
        return <del key={key}>{renderInline((t as Tokens.Del).tokens, key)}</del>
      case 'codespan':
        return <code key={key}>{unescapeEntities((t as Tokens.Codespan).text)}</code>
      case 'link': {
        const link = t as Tokens.Link
        const label = renderInline(link.tokens, key)
        // Text + visible URL, deliberately not an <a href>: a model-authored href is a
        // navigation/exfiltration surface this WebView must not offer.
        return (
          <span key={key}>
            {label}
            {link.href && <span class="md-href"> ({link.href})</span>}
          </span>
        )
      }
      case 'image':
        return <span key={key}>[{(t as Tokens.Image).text || 'image'}]</span>
      case 'br':
        return <br key={key} />
      case 'escape':
        return (t as Tokens.Escape).text
      case 'html':
        // Literal text, never markup.
        return (t as Tokens.HTML).raw
      case 'text': {
        const text = t as Tokens.Text
        return text.tokens ? renderInline(text.tokens, key) : unescapeEntities(text.raw)
      }
      default:
        return 'raw' in t ? (t as { raw: string }).raw : null
    }
  })
}

function renderBlock(t: Token, key: string): ComponentChildren {
  switch (t.type) {
    case 'paragraph':
      return <p key={key}>{renderInline((t as Tokens.Paragraph).tokens, key)}</p>
    case 'heading': {
      const h = t as Tokens.Heading
      const inner = renderInline(h.tokens, key)
      switch (Math.min(h.depth, 4)) {
        case 1: return <h1 key={key}>{inner}</h1>
        case 2: return <h2 key={key}>{inner}</h2>
        case 3: return <h3 key={key}>{inner}</h3>
        default: return <h4 key={key}>{inner}</h4>
      }
    }
    case 'code': {
      const c = t as Tokens.Code
      if ((c.lang ?? '').trim().toLowerCase() === 'mermaid') return <MermaidBlock key={key} code={c.text} />
      return <CodeBlock key={key} code={c.text} lang={c.lang ?? ''} />
    }
    case 'blockquote':
      return <blockquote key={key}>{renderTokens((t as Tokens.Blockquote).tokens, key)}</blockquote>
    case 'list': {
      const list = t as Tokens.List
      const items = list.items.map((item, i) => (
        <li key={`${key}-li${i}`} class={item.task ? 'md-task' : undefined}>
          {/* The GFM tokenizer strips `[x]`/`[ ]` from the text and records it as
              item.task/item.checked — dropped here, a model-written checklist (the shape
              models emit for every plan) rendered as indistinguishable plain bullets, its
              done/not-done state invisible. */}
          {item.task && <span class="md-check" aria-hidden="true">{item.checked ? '☑' : '☐'} </span>}
          {renderTokens(item.tokens, `${key}-li${i}`)}
        </li>
      ))
      return list.ordered
        ? <ol key={key} start={typeof list.start === 'number' ? list.start : undefined}>{items}</ol>
        : <ul key={key}>{items}</ul>
    }
    case 'table': {
      const table = t as Tokens.Table
      return (
        <table key={key}>
          <thead>
            <tr>
              {table.header.map((cell, i) => (
                <th key={`${key}-h${i}`}>{renderInline(cell.tokens, `${key}-h${i}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, r) => (
              <tr key={`${key}-r${r}`}>
                {row.map((cell, c) => (
                  <td key={`${key}-r${r}c${c}`}>{renderInline(cell.tokens, `${key}-r${r}c${c}`)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )
    }
    case 'hr':
      return <hr key={key} />
    case 'space':
      return null
    case 'html':
      // Block-level HTML from the model renders as visible literal text in a code block --
      // honest about what arrived, executable never.
      return <pre key={key}><code>{(t as Tokens.HTML).raw}</code></pre>
    case 'text': {
      const text = t as Tokens.Text
      return <p key={key}>{text.tokens ? renderInline(text.tokens, key) : unescapeEntities(text.raw)}</p>
    }
    default:
      return 'raw' in t ? <p key={key}>{(t as { raw: string }).raw}</p> : null
  }
}

/**
 * A fenced block: language label, copy button, and `highlight()`'s VNodes. The copy button
 * exists because the single most common thing anyone does with a code block a model wrote
 * is take it — and hand-selecting text inside a scrolling transcript is miserable.
 */
/**
 * A ```mermaid block, rendered as a diagram (the `mermaid` skill writes them).
 *
 * The one place model-authored text reaches an HTML sink, and it is bounded on both
 * sides: mermaid runs with `securityLevel: 'strict'` (labels are escaped, no HTML labels,
 * no click handlers), the SVG it returns is what goes in, and a source that does not parse
 * shows as the code block it was, with the parser's message under it. The library is
 * loaded on first use only — it is large, and most transcripts never contain a diagram.
 * Rendering waits for the text to stop changing so a diagram still streaming in does not
 * flash a parse error per token.
 */
function MermaidBlock({ code }: { code: string }): VNode {
  const host = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)
  useEffect(() => {
    const mine = ++seq.current
    setError(null)
    const timer = setTimeout(() => {
      void import('mermaid').then(async ({ default: mermaid }) => {
        const dark = document.documentElement.dataset['theme'] === 'dark' ||
          (document.documentElement.dataset['theme'] === undefined && window.matchMedia?.('(prefers-color-scheme: dark)').matches)
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'neutral', htmlLabels: false, flowchart: { htmlLabels: false } })
        const { svg } = await mermaid.render(`pc-mermaid-${mine}-${Date.now()}`, code)
        if (mine !== seq.current || host.current === null) return
        host.current.innerHTML = svg
      }).catch((e: unknown) => {
        if (mine !== seq.current) return
        setError(e instanceof Error ? e.message.split('\n')[0] ?? 'could not render' : String(e))
      })
    }, 300)
    return () => { clearTimeout(timer) }
  }, [code])
  return (
    <div class="md-code" data-mermaid="">
      <div class="md-code-bar"><span class="md-lang">mermaid</span></div>
      {error === null
        ? <div ref={host} class="overflow-x-auto p-3" />
        : (
          <>
            <pre><code>{code}</code></pre>
            <div class="px-3 pb-2 text-[11.5px] text-red" data-mermaid-error="">{error}</div>
          </>
        )}
    </div>
  )
}

function CodeBlock({ code, lang }: { code: string; lang: string }): VNode {
  const [copied, setCopied] = useState(false)
  // Re-tokenising a finished block on every render of an unrelated streaming message was
  // one of the allocation sources behind the renderer running out of memory.
  const parts = useMemo(() => highlight(code, lang), [code, lang])

  function copy(): void {
    // Best-effort: no clipboard permission (or an old WebView) simply leaves the button
    // un-ticked rather than throwing into the render tree.
    void navigator.clipboard?.writeText(code).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 1200) },
      () => { /* nothing sensible to show; the text is still selectable */ },
    )
  }

  return (
    <div class="md-code">
      <div class="md-code-bar">
        <span class="md-lang">{lang}</span>
        <button class="md-copy" onClick={copy} title="Copy this block">
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <pre><code>{parts}</code></pre>
    </div>
  )
}

function renderTokens(tokens: Token[], keyBase: string): ComponentChildren[] {
  return tokens.map((t, i) => renderBlock(t, `${keyBase}-${i}`))
}

/**
 * The one public entry: markdown text in, a styled VNode out. Safe for any input.
 *
 * Memoised on `text`. The message currently streaming genuinely has to be re-lexed as it
 * grows, but every message ABOVE it does not, and re-lexing all of them on every token is
 * how a long conversation used to exhaust the renderer's memory.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }): VNode {
  let tokens: Token[]
  try {
    tokens = new Lexer({ gfm: true, breaks: false }).lex(text)
  } catch {
    // A tokenizer failure must never lose the reply -- fall back to plain text.
    return <div class="md"><p>{text}</p></div>
  }
  return <div class="md">{renderTokens(tokens, 'md')}</div>
})
