import { useMemo, useState } from 'preact/hooks'
import type { VNode } from 'preact'

/**
 * Renders the diff text `Edit` produces (`core/src/tools/edit-file.ts`'s `renderDiff`)
 * as a real, gutter-numbered, coloured diff instead of a wall of `pre`.
 *
 * The format it emits is:
 *
 *     --- src/app.ts
 *     +++ src/app.ts
 *     @@ line 42 @@
 *     -old line
 *     -another old line
 *     +new line
 *
 * — all removals, then all additions, from one starting line. That is enough to number both
 * sides correctly, which is what makes a diff readable at a glance. Anything that is NOT in
 * that shape (a `Write` confirmation, a `delete_file` note, a tool error) still renders
 * here, just without gutters: this component never assumes it was handed a diff.
 */

export interface DiffStat { added: number; removed: number }

/**
 * Which lines are the `--- path` / `+++ path` FILE HEADER, told apart from content by
 * structure rather than by prefix.
 *
 * Three shapes reach this module and only two of them have headers: the tools' own diffs
 * (`--- p` / `+++ p` at lines 0-1), raw `git diff` (the pair sits after `diff --git` /
 * `index` lines, i.e. NOT at a fixed index), and the approval card's search→replace
 * rendering (no headers at all). Prefix matching swallowed real changes — a deleted
 * `-- SQL comment` renders as `--- SQL comment` — and a fixed index broke the git shape.
 * What separates a header from any of those collisions is the STRUCTURE: a `--- ` line,
 * immediately followed by a `+++ ` line, immediately followed by an `@@` hunk marker — or
 * by one of `renderDiff`'s parenthesised no-change notes, the one tool output whose header
 * has no hunk. Content cannot fake the third line: an added line starting `@@` or `(`
 * renders as `+@@` / `+(`, and a git context line carries its leading space.
 */
function headerLines(lines: string[]): Set<number> {
  const header = new Set<number>()
  for (let i = 0; i + 2 < lines.length; i++) {
    if (!lines[i]!.startsWith('--- ') || !lines[i + 1]!.startsWith('+++ ')) continue
    const third = lines[i + 2]!
    if (third.startsWith('@@') || third.startsWith('(')) {
      header.add(i)
      header.add(i + 1)
    }
  }
  return header
}

export function diffStat(content: string): DiffStat {
  let added = 0
  let removed = 0
  const lines = content.split('\n')
  const header = headerLines(lines)
  lines.forEach((line, i) => {
    if (header.has(i)) return
    if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
  })
  return { added, removed }
}

type Row =
  | { kind: 'add'; text: string; newNo: number }
  | { kind: 'del'; text: string; oldNo: number }
  | { kind: 'ctx'; text: string; oldNo: number; newNo: number }
  | { kind: 'meta'; text: string }
  /** A structurally-identified file-header line (`headerLines`) — never rendered. Its own
   * kind, because text-matching meta rows against `---`/`+++` is exactly the prefix
   * confusion this file exists to avoid. */
  | { kind: 'header'; text: string }

/** Splits the tool's output into numbered rows. `@@ line N @@` seeds both counters; without
 * such a header the gutters are simply absent (rows come back as `meta`/`add`/`del` with
 * no numbers to show). */
function toRows(content: string): { rows: Row[]; numbered: boolean } {
  const lines = content.split('\n')
  const header = headerLines(lines)
  let oldNo = 0
  let newNo = 0
  let numbered = false
  const rows: Row[] = []

  for (const [i, line] of lines.entries()) {
    const hunk = /^@@ line (\d+) @@/.exec(line)
    if (hunk) {
      // Consumed, not rendered: it only says where the change starts, which the line
      // gutters below then say on every single row.
      oldNo = Number(hunk[1])
      newNo = Number(hunk[1])
      numbered = true
      continue
    }
    // Structural, not prefix-anywhere and not positional — see `headerLines`.
    if (header.has(i)) {
      rows.push({ kind: 'header', text: line })
      continue
    }
    if (line.startsWith('-')) {
      rows.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++ })
      continue
    }
    if (line.startsWith('+')) {
      rows.push({ kind: 'add', text: line.slice(1), newNo: newNo++ })
      continue
    }
    if (numbered && line !== '' && !line.startsWith('...') && !line.startsWith('(')) {
      rows.push({ kind: 'ctx', text: line, oldNo: oldNo++, newNo: newNo++ })
      continue
    }
    rows.push({ kind: 'meta', text: line })
  }
  return { rows, numbered }
}

/** Rows shown before the "show the rest" control appears. */
const COLLAPSE_AFTER = 28

export function DiffView({ content, dense = false }: { content: string; dense?: boolean }): VNode {
  const [expanded, setExpanded] = useState(false)
  // A diff's text never changes once its tool call completed, so parsing it more than once
  // is pure waste -- and it used to be re-parsed on every streamed token of every later
  // message, which is a large part of what exhausted the renderer's memory.
  const { rows, numbered } = useMemo(() => toRows(content), [content])
  // Header lines carry no information the card's own title doesn't already show.
  const body = rows.filter((r) => r.kind !== 'header')
  const overflows = body.length > COLLAPSE_AFTER
  const shown = overflows && !expanded ? body.slice(0, COLLAPSE_AFTER) : body

  return (
    <div class={`diff ${dense ? 'diff-dense' : ''}`}>
      {shown.map((row, i) => (
        <div key={i} class={`diff-row diff-${row.kind}`}>
          {numbered && (
            <>
              <span class="diff-no">{row.kind === 'del' || row.kind === 'ctx' ? row.oldNo : ''}</span>
              <span class="diff-no">{row.kind === 'add' || row.kind === 'ctx' ? row.newNo : ''}</span>
            </>
          )}
          <span class="diff-sign">{row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '}</span>
          <span class="diff-text">{row.text}</span>
        </div>
      ))}
      {overflows && (
        <button class="diff-more" onClick={() => setExpanded((e) => !e)}>
          {expanded ? 'show less' : `show ${body.length - COLLAPSE_AFTER} more lines`}
        </button>
      )}
    </div>
  )
}

/** The `+12 −3` pair, rendered the same way everywhere it appears. */
export function DiffStatBadge({ stat }: { stat: DiffStat }): VNode | null {
  if (stat.added === 0 && stat.removed === 0) return null
  return (
    <span class="diff-stat">
      {stat.added > 0 && <span class="diff-stat-add">+{stat.added}</span>}
      {stat.removed > 0 && <span class="diff-stat-del">−{stat.removed}</span>}
    </span>
  )
}
