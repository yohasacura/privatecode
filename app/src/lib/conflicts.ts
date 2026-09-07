/**
 * A conflicted file, read the way git wrote it and written the way the person resolved it.
 *
 * git leaves `<<<<<<< ours`, `=======`, `>>>>>>> theirs` around each disagreement (and,
 * with `merge.conflictStyle=diff3`, a `||||||| base` section between ours and the
 * separator). The merge editor shows the two sides of every block with a checkbox each,
 * the way Visual Studio's does; `resolveText` rebuilds the file from those choices. Pure,
 * so both directions are tested without a repository.
 */

export type ConflictChoice = 'ours' | 'theirs' | 'both' | 'both-reversed' | 'none'

export interface ConflictBlock {
  kind: 'conflict'
  index: number
  ours: string[]
  theirs: string[]
  base: string[] | null
  oursLabel: string
  theirsLabel: string
}

export interface PlainBlock {
  kind: 'text'
  lines: string[]
}

export type ConflictSegment = ConflictBlock | PlainBlock

export interface ParsedConflicts {
  segments: ConflictSegment[]
  conflicts: ConflictBlock[]
  /** The line ending the file uses, kept on the way back out. */
  eol: '\n' | '\r\n'
  /** Whether the file ended with a newline — reproduced faithfully. */
  trailingNewline: boolean
}

const OURS = /^<{7}(?: (.*))?$/
const BASE = /^\|{7}(?: (.*))?$/
const SEP = /^={7}$/
const THEIRS = /^>{7}(?: (.*))?$/

export function parseConflicts(text: string): ParsedConflicts {
  const eol: '\n' | '\r\n' = text.includes('\r\n') ? '\r\n' : '\n'
  const trailingNewline = text.endsWith('\n')
  const body = trailingNewline ? text.slice(0, -eol.length) : text
  const lines = body === '' ? [] : body.split(/\r?\n/)
  const segments: ConflictSegment[] = []
  const conflicts: ConflictBlock[] = []
  let plain: string[] = []
  let i = 0
  const flush = (): void => { if (plain.length > 0) { segments.push({ kind: 'text', lines: plain }); plain = [] } }

  while (i < lines.length) {
    const line = lines[i]!
    const open = OURS.exec(line)
    if (open === null) { plain.push(line); i += 1; continue }
    // A block: ours until `|||||||` or `=======`, then (base until `=======`,) theirs until `>>>>>>>`.
    const ours: string[] = []
    let base: string[] | null = null
    const theirs: string[] = []
    let j = i + 1
    let state: 'ours' | 'base' | 'theirs' = 'ours'
    let closed: RegExpExecArray | null = null
    for (; j < lines.length; j += 1) {
      const l = lines[j]!
      if (state === 'ours' && BASE.test(l)) { base = []; state = 'base'; continue }
      if ((state === 'ours' || state === 'base') && SEP.test(l)) { state = 'theirs'; continue }
      if (state === 'theirs') {
        const close = THEIRS.exec(l)
        if (close !== null) { closed = close; break }
      }
      if (state === 'ours') ours.push(l)
      else if (state === 'base') base!.push(l)
      else theirs.push(l)
    }
    if (closed === null) {
      // Markers that never close are content, not a conflict — leave them as they are.
      plain.push(line)
      i += 1
      continue
    }
    flush()
    const block: ConflictBlock = {
      kind: 'conflict', index: conflicts.length, ours, theirs, base,
      oursLabel: open[1] ?? 'ours', theirsLabel: closed[1] ?? 'theirs',
    }
    segments.push(block)
    conflicts.push(block)
    i = j + 1
  }
  flush()
  return { segments, conflicts, eol, trailingNewline }
}

/** The file with every block replaced by its choice; `custom` overrides a block's text. */
export function resolveText(
  parsed: ParsedConflicts,
  choices: ReadonlyMap<number, ConflictChoice>,
  custom: ReadonlyMap<number, string[]> = new Map(),
): string {
  const out: string[] = []
  for (const seg of parsed.segments) {
    if (seg.kind === 'text') { out.push(...seg.lines); continue }
    const own = custom.get(seg.index)
    if (own !== undefined) { out.push(...own); continue }
    switch (choices.get(seg.index) ?? 'none') {
      case 'ours': out.push(...seg.ours); break
      case 'theirs': out.push(...seg.theirs); break
      case 'both': out.push(...seg.ours, ...seg.theirs); break
      case 'both-reversed': out.push(...seg.theirs, ...seg.ours); break
      case 'none': break
      default: break
    }
  }
  const text = out.join(parsed.eol)
  return parsed.trailingNewline && text !== '' ? text + parsed.eol : text
}

/** Whether every block has an answer — the gate on Accept Merge. */
export function allResolved(parsed: ParsedConflicts, choices: ReadonlyMap<number, ConflictChoice>, custom: ReadonlyMap<number, string[]> = new Map()): boolean {
  return parsed.conflicts.every((c) => custom.has(c.index) || (choices.get(c.index) ?? 'none') !== 'none')
}

/** True when `text` still carries a marker line — the one thing a resolution must not. */
export function hasMarkers(text: string): boolean {
  return /^(<{7}|={7}|>{7}|\|{7})( |$)/m.test(text)
}
