import type { ChatItem } from './state'

/**
 * The model's work between two pieces of prose, folded into one unit (docs/UI-REDESIGN-2026-09.md §5).
 *
 * A run of tool calls, the reasoning beside them, the approvals they asked for and the
 * checks that ran on them is one act — "read four files, edited two, build passed" — and
 * it is shown as one row with that sentence, the calls beneath it a click away. While the
 * run is still going the group is live and open; once it ends it folds unless something
 * in it failed, because a failure is the thing to look at.
 *
 * Pure over the items, so the folding rule is tested without a DOM.
 */

const ACTIVITY = new Set<ChatItem['kind']>(['tool', 'thinking', 'approval-record', 'question-record', 'verify-record'])

export interface GroupSummary {
  reads: number
  edits: number
  commands: number
  other: number
  approvals: number
  checks: number
  /** Checks that did not pass, counted apart from tools that failed. */
  checksFailed: number
  failed: number
  /** The last action, for the live header: "Reading Snapshot.cs…". */
  latest: string | null
}

export type TranscriptUnit =
  | { kind: 'single'; item: ChatItem }
  | { kind: 'group'; id: number; items: ChatItem[]; summary: GroupSummary; live: boolean }

const READ_TOOLS = new Set(['read_file', 'list_dir', 'find_files', 'search_code', 'symbol_outline', 'csharp_nav', 'git_status', 'sql_query', 'web_fetch'])
const EDIT_TOOLS = new Set(['edit_file', 'write_file', 'delete_file', 'move_file', 'apply_patch'])
const COMMAND_TOOLS = new Set(['run_command', 'run_background', 'terminal'])

function verb(name: string): string {
  if (READ_TOOLS.has(name)) return name === 'search_code' ? 'Searching' : name === 'list_dir' || name === 'find_files' ? 'Looking through' : 'Reading'
  if (EDIT_TOOLS.has(name)) return 'Editing'
  if (COMMAND_TOOLS.has(name)) return 'Running'
  return 'Using'
}

function target(args: string): string {
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>
    const p = parsed['path'] ?? parsed['pattern'] ?? parsed['symbol'] ?? parsed['commands'] ?? parsed['cmd'] ?? parsed['to']
    if (Array.isArray(p)) return String(p[0] ?? '')
    if (typeof p === 'string') return p.split(/[\\/]/).pop() ?? p
  } catch { /* still being written */ }
  return ''
}

export function summarise(items: readonly ChatItem[]): GroupSummary {
  const s: GroupSummary = { reads: 0, edits: 0, commands: 0, other: 0, approvals: 0, checks: 0, checksFailed: 0, failed: 0, latest: null }
  for (const it of items) {
    switch (it.kind) {
      case 'tool': {
        if (READ_TOOLS.has(it.name)) s.reads++
        else if (EDIT_TOOLS.has(it.name)) s.edits++
        else if (COMMAND_TOOLS.has(it.name)) s.commands++
        else s.other++
        if (it.result !== undefined && !it.result.ok) s.failed++
        const t = target(it.args)
        s.latest = `${verb(it.name)}${t !== '' ? ` ${t}` : ''}${it.result === undefined ? '…' : ''}`
        break
      }
      case 'verify-record':
        s.checks++
        if (!it.ok) s.checksFailed++
        break
      case 'approval-record':
        s.approvals++
        break
      default:
        break
    }
  }
  return s
}

/** "Read 4 files · edited 2 · 1 command · build passed" — the finished header. */
export function summaryText(s: GroupSummary): string {
  const parts: string[] = []
  if (s.reads > 0) parts.push(`read ${s.reads} ${s.reads === 1 ? 'file' : 'files'}`)
  if (s.edits > 0) parts.push(`edited ${s.edits}`)
  if (s.commands > 0) parts.push(`${s.commands} ${s.commands === 1 ? 'command' : 'commands'}`)
  if (s.other > 0) parts.push(`${s.other} other ${s.other === 1 ? 'call' : 'calls'}`)
  if (s.checks > 0) {
    parts.push(s.checksFailed > 0
      ? `${s.checksFailed} of ${s.checks} ${s.checks === 1 ? 'check' : 'checks'} failed`
      : `${s.checks === 1 ? 'check' : `${s.checks} checks`} passed`)
  }
  if (s.failed > 0) parts.push(`${s.failed} ${s.failed === 1 ? 'call' : 'calls'} failed`)
  const text = parts.join(' · ')
  return text === '' ? 'Worked' : text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * Folds `items` into units. Two or more consecutive activity items form a group; a lone
 * one stays a row of its own (a group of one says less than the row). The last group is
 * live while the turn runs and no prose has followed it.
 */
export function groupItems(items: readonly ChatItem[], turnRunning: boolean): TranscriptUnit[] {
  const units: TranscriptUnit[] = []
  let run: ChatItem[] = []
  const flush = (): void => {
    if (run.length === 0) return
    if (run.length === 1) units.push({ kind: 'single', item: run[0]! })
    else units.push({ kind: 'group', id: run[0]!.id, items: run, summary: summarise(run), live: false })
    run = []
  }
  for (const item of items) {
    if (ACTIVITY.has(item.kind)) run.push(item)
    else { flush(); units.push({ kind: 'single', item }) }
  }
  flush()
  const last = units[units.length - 1]
  if (turnRunning && last !== undefined && last.kind === 'group') last.live = true
  return units
}
