import type { ComponentChildren, VNode } from 'preact'
import { useMemo } from 'preact/hooks'

/**
 * File paths written inside ordinary prose, found and made clickable.
 *
 * The plan is the model's own sentences — "rewrite the invoice insert in
 * core/src/db/invoice.ts", "add the case to tests/invoice.test.ts" — and read as flat grey
 * text the paths in it are the hardest part to find, which is exactly backwards: the path is
 * the part you want to open.
 *
 * The whole difficulty is deciding what IS a path. A rule as loose as "has a dot" or "has a
 * slash" turns `Node.js`, `and/or`, `read/write`, `v0.1.0` and `Ctrl+E` into fake links, and
 * a card full of fake links is worse than one with none. So the test is deliberately narrow
 * and stated in one place:
 *
 *   - a known source/config extension on the last segment (`x.ts`, `package.json`), or
 *   - a trailing slash with at least two segments (`core/src/`), or
 *   - at least two separators (`core/src/session`).
 *
 * Everything else stays text. The cost of that choice is a path the card leaves plain; the
 * cost of the loose rule is a card nobody trusts.
 */

/** The last segment's extension has to be one of these for a no-directory token to count. */
const KNOWN_EXTENSIONS: ReadonlySet<string> = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'json', 'jsonc', 'json5',
  'md', 'mdx', 'txt', 'rst',
  'css', 'scss', 'sass', 'less', 'html', 'htm', 'xml', 'svg', 'vue', 'svelte', 'astro',
  'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'lock', 'log', 'csv', 'tsv',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd',
  'py', 'pyi', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'php', 'pl', 'lua', 'r',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'cs', 'sql', 'graphql', 'gql', 'proto',
  'gitignore', 'gitattributes', 'editorconfig', 'npmrc', 'nvmrc', 'dockerignore',
  'eslintrc', 'prettierrc', 'babelrc',
])

/** Extensionless names that are still files, and common enough to be worth naming. */
const KNOWN_NAMES: ReadonlySet<string> = new Set(['dockerfile', 'makefile'])

/**
 * Libraries whose NAME ends in a file extension. `Node.js` passes every structural test a
 * filename passes, and the model writes it in plans constantly; the only thing that
 * separates it from `app.js` is knowing what it is.
 */
const NOT_FILES: ReadonlySet<string> = new Set([
  'node.js', 'next.js', 'nuxt.js', 'vue.js', 'react.js', 'three.js', 'd3.js', 'chart.js',
  'express.js', 'ember.js', 'backbone.js', 'discord.js', 'socket.js',
])

/**
 * A run of path-ish characters, optionally backticked, optionally with a `:line` or
 * `:line:col` suffix. A drive letter is spelled out because `:` is otherwise not part of a
 * token — without it `D:\proj\a.ts` would be found as the single letter `D`.
 */
const CANDIDATE = /`[^`\n]+`|(?:[A-Za-z]:[\\/])?[A-Za-z0-9_~.@+/][A-Za-z0-9_~.@+\-/\\]*(?::\d+(?::\d+)?)?/g

/** What may sit immediately before a candidate. Anything else means the match is the tail
 * of something longer — the `example.com/a.md` inside a URL, an email's domain — and a tail
 * is never a path. */
const OPENS = new Set([' ', '\t', '\n', '(', '[', '{', '<', '"', "'", ',', ';', '“', '‘'])

export interface FileRef {
  /** As written, minus the wrapping backticks and any sentence punctuation after it. */
  label: string
  /** Separators normalised to `/`, line suffix removed: what the file tab is opened with. */
  path: string
  /** From a `path:42` suffix. Kept in the label; there is nowhere to jump to yet. */
  line: number | null
}

export type RefPiece =
  | { kind: 'text'; text: string }
  | { kind: 'ref'; ref: FileRef }

/** The path inside one candidate token, or `null` if the token is just a word. */
export function parseFileRef(raw: string): FileRef | null {
  let s = raw.trim()
  if (s.startsWith('`') && s.endsWith('`') && s.length > 2) s = s.slice(1, -1).trim()
  // A path at the end of a sentence carries the sentence's punctuation. Stripped AFTER the
  // backticks so that `x.ts`. loses both.
  s = s.replace(/[.,;:!?)\]}'"]+$/, '')
  if (s === '') return null

  let line: number | null = null
  let body = s
  const withLine = /^(.+?):(\d+)(?::\d+)?$/.exec(s)
  if (withLine) {
    body = withLine[1]!
    line = Number(withLine[2])
  }

  // `./x` and `x` are the same file to everything downstream, and the tree hands out the
  // second form — so the leading `./` goes here rather than at every call site.
  const path = body.replace(/\\/g, '/').replace(/^\.\//, '')
  if (path.includes('://')) return null
  if (!/^(?:[A-Za-z]:\/)?\/?[A-Za-z0-9_~@+.\-]+(?:\/[A-Za-z0-9_~@+.\-]+)*\/?$/.test(path)) return null

  const segments = path.replace(/\/+$/, '').split('/').filter((seg) => seg !== '')
  const last = segments[segments.length - 1]
  if (last === undefined) return null
  const separators = segments.length - 1
  const ext = /\.([A-Za-z0-9]+)$/.exec(last)?.[1]?.toLowerCase() ?? null

  const named = KNOWN_NAMES.has(last.toLowerCase())
  const extended = ext !== null && KNOWN_EXTENSIONS.has(ext)
  const branded = separators === 0 && NOT_FILES.has(last.toLowerCase())
  const directory = path.endsWith('/') && segments.length >= 2

  if (branded) return null
  if (!extended && !named && !directory && separators < 2) return null

  return { label: s, path, line }
}

/**
 * `text` split into the parts that are paths and the parts that are not. Concatenating the
 * pieces gives the original back, except for backticks around a path — those are markup for
 * "this is a path", and the chip says it better.
 */
export function splitFileRefs(text: string): RefPiece[] {
  const pieces: RefPiece[] = []
  let cursor = 0
  const push = (upTo: number): void => {
    if (upTo > cursor) pieces.push({ kind: 'text', text: text.slice(cursor, upTo) })
  }

  CANDIDATE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CANDIDATE.exec(text)) !== null) {
    const before = m.index === 0 ? ' ' : text[m.index - 1]!
    if (!OPENS.has(before)) continue
    const ref = parseFileRef(m[0])
    if (ref === null) continue
    push(m.index)
    pieces.push({ kind: 'ref', ref })
    // Backticks are consumed with the token — the chip replaces them. Otherwise the label
    // is a prefix of the match and anything after it (the `.` that ended the sentence, a
    // closing bracket) is still the sentence's and has to be given back as text.
    const backticked = m[0].startsWith('`')
    cursor = backticked ? m.index + m[0].length : m.index + ref.label.length
  }
  push(text.length)
  return pieces
}

/**
 * Prose with its paths lifted out. Without `onOpenFile` the paths are still marked but inert
 * — which is what the collapsed plan header needs, since it is itself a `<button>` and a
 * button inside a button is not a thing a document may contain.
 */
export function FileRefText(
  { text, onOpenFile }: { text: string; onOpenFile?: (path: string) => void },
): VNode {
  const pieces = useMemo(() => splitFileRefs(text), [text])
  const out: ComponentChildren[] = pieces.map((piece, i) => {
    if (piece.kind === 'text') return piece.text
    if (onOpenFile === undefined) {
      return <span key={i} class="file-ref">{piece.ref.label}</span>
    }
    return (
      <button
        key={i}
        type="button"
        class="file-ref"
        title={`Open ${piece.ref.path}`}
        onClick={(e) => { e.stopPropagation(); onOpenFile(piece.ref.path) }}
      >
        {piece.ref.label}
      </button>
    )
  })
  return <>{out}</>
}
