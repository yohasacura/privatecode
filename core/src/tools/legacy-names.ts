/**
 * The tools' current names for calls written under their old ones.
 *
 * The tools were renamed twice — to Claude Code's names on 2026-09-03 (`read_file` → `Read`,
 * `run_command` → `Bash`, …) and the rest on 2026-09-07 (`list_dir` → `LS`,
 * `delete_file` → `DeleteFile`, …) — and every session recorded before either day names
 * them the old way, in its transcript, for the model to read. A model reads its own
 * transcript as an example of what works here, so a session opened after the update kept
 * producing `run_command` and `background_task` calls; the registry answered
 * `Unknown tool`, the model wrote the same call again, and the window showed a tool that was
 * never run. Seen live 2026-09-08: asked to delete files, the model called what the window
 * labelled `TaskOutput` in a loop and never once reached Bash.
 *
 * Two places take the translation. `Transcript.fromJSONL` rewrites a stored transcript's
 * calls as it loads them, so the model's example is the current vocabulary; and the loop
 * translates a call the model still writes the old way before looking it up, so the tool
 * runs and its result says which name it has now. The file on disk is never rewritten: it
 * is the audit trail, and the doctor reads old names off it by design (`RETIRED_TOOL_NAMES`).
 *
 * The argument shapes survived both renames unchanged — checked against v0.4.7 — with one
 * exception: `background_task` was one tool with an `action` (`start` / `poll` / `stop`)
 * and became three (`Bash` with `run_in_background`, `TaskOutput`, `TaskStop`), which is
 * what `splitBackgroundTask` undoes.
 */
import { LEGACY_TOOL_NAMES } from '../permissions/rules.js'
import type { ChatMessage, ToolCall } from '../llama/types.js'
import { CLAUDE_CODE_OLD_NAMES } from './built-in-names.js'

export interface CurrentCall {
  name: string
  args: string
  /** The name the call came in under, when it was an old one; null when nothing changed. */
  renamed: string | null
}

const OLD_BACKGROUND_TASK = 'background_task'

/** The call as this build's tools take it. Unknown names pass through untouched. */
export function currentToolCall(name: string, args: string): CurrentCall {
  if (name === OLD_BACKGROUND_TASK) return splitBackgroundTask(args)
  const current = LEGACY_TOOL_NAMES[name] ?? CLAUDE_CODE_OLD_NAMES[name]
  if (current === undefined || current === name) return { name, args, renamed: null }
  return { name: current, args, renamed: name }
}

function splitBackgroundTask(args: string): CurrentCall {
  let parsed: Record<string, unknown>
  try {
    const raw: unknown = args.trim() === '' ? {} : JSON.parse(args)
    parsed = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  } catch {
    // Not JSON: hand it to the reader unchanged, whose validation will say so.
    return { name: 'TaskOutput', args, renamed: OLD_BACKGROUND_TASK }
  }
  const { action, command, id, wait_seconds, ready_when } = parsed
  if (action === 'start') {
    const call: Record<string, unknown> = { command, run_in_background: true }
    if (ready_when !== undefined) call['ready_when'] = ready_when
    return { name: 'Bash', args: JSON.stringify(call), renamed: OLD_BACKGROUND_TASK }
  }
  if (action === 'stop') return { name: 'TaskStop', args: JSON.stringify({ id }), renamed: OLD_BACKGROUND_TASK }
  const poll: Record<string, unknown> = { id }
  if (wait_seconds !== undefined) poll['wait_seconds'] = wait_seconds
  return { name: 'TaskOutput', args: JSON.stringify(poll), renamed: OLD_BACKGROUND_TASK }
}

/**
 * A stored message with its tool names brought up to date; the same object when nothing
 * needed it.
 *
 * `renamed` carries the calls already translated, by call id, from one message to the next:
 * a tool reply names its tool but not the action, and a `background_task` reply is `Bash`'s
 * or `TaskOutput`'s depending on what the call before it asked for. One map per transcript.
 */
export function modernizeMessage(m: ChatMessage, renamed: Map<string, string> = new Map()): ChatMessage {
  if (m.role === 'assistant' && m.tool_calls !== undefined && m.tool_calls.length > 0) {
    let changed = false
    const calls: ToolCall[] = m.tool_calls.map((c) => {
      const current = currentToolCall(c.function.name, c.function.arguments)
      if (current.renamed === null) return c
      changed = true
      renamed.set(c.id, current.name)
      return { ...c, function: { name: current.name, arguments: current.args } }
    })
    return changed ? { ...m, tool_calls: calls } : m
  }
  if (m.role === 'tool' && m.name !== undefined) {
    const byCall = m.tool_call_id !== undefined ? renamed.get(m.tool_call_id) : undefined
    const name = byCall ?? currentToolCall(m.name, '{}').name
    if (name !== m.name) return { ...m, name }
  }
  return m
}
