import { Lexer, type Token, type Tokens } from 'marked'
import type { ComponentChildren, VNode } from 'preact'
import { useState } from 'preact/hooks'
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
      return <CodeBlock key={key} code={c.text} lang={c.lang ?? ''} />
    }
    case 'blockquote':
      return <blockquote key={key}>{renderTokens((t as Tokens.Blockquote).tokens, key)}</blockquote>
    case 'list': {
      const list = t as Tokens.List
      const items = list.items.map((item, i) => (
        <li key={`${key}-li${i}`}>{renderTokens(item.tokens, `${key}-li${i}`)}</li>
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
function CodeBlock({ code, lang }: { code: string; lang: string }): VNode {
  const [copied, setCopied] = useState(false)

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
      <pre><code>{highlight(code, lang)}</code></pre>
    </div>
  )
}

function renderTokens(tokens: Token[], keyBase: string): ComponentChildren[] {
  return tokens.map((t, i) => renderBlock(t, `${keyBase}-${i}`))
}

/** The one public entry: markdown text in, a styled VNode out. Safe for any input. */
export function Markdown({ text }: { text: string }): VNode {
  let tokens: Token[]
  try {
    tokens = new Lexer({ gfm: true, breaks: false }).lex(text)
  } catch {
    // A tokenizer failure must never lose the reply -- fall back to plain text.
    return <div class="md"><p>{text}</p></div>
  }
  return <div class="md">{renderTokens(tokens, 'md')}</div>
}
