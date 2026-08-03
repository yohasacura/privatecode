/**
 * One place that knows how each of the agent's 14 tools should be PRESENTED: the verb, the
 * thing it acted on, and which family it belongs to (which in turn decides whether the
 * transcript renders a diff, a command console, or a plain collapsible result).
 *
 * The transcript, the Changes tab and the Terminal tab all need this mapping; deriving it
 * three times is how three panels end up disagreeing about what `move_file`'s target is.
 */

export type ToolKind =
  /** Produces a diff we render inline. */
  | 'diff'
  /** Changes the tree without a diff (move/delete). */
  | 'fileop'
  /** Reads something; result is text worth collapsing. */
  | 'read'
  /** Runs a process; result is console output. */
  | 'command'
  /** Talks to the user or to the plan rather than to the workspace. */
  | 'meta'
  | 'other'

export interface ToolPresentation {
  kind: ToolKind
  /** Imperative, capitalised: `Edit`, `Search`, `Run`. */
  verb: string
  /** What it acted on, already formatted for display (a path, a pattern, a command). */
  target: string
  /** The workspace-relative path this call concerns, when there is exactly one -- used to
   * make a card clickable and to key the Changes list. `null` for tools with no single
   * path (a command, a search across the tree, a move with two). */
  path: string | null
}

/** The write family, as the permission engine and the Changes tab both understand it. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'edit_file', 'write_file', 'move_file', 'delete_file',
])

const VERBS: Record<string, string> = {
  read_file: 'Read',
  list_dir: 'List',
  find_files: 'Find',
  search_code: 'Search',
  symbol_outline: 'Outline',
  edit_file: 'Edit',
  write_file: 'Write',
  move_file: 'Move',
  delete_file: 'Delete',
  run_command: 'Run',
  background_task: 'Background',
  git_status: 'Git',
  todo_write: 'Plan',
  ask_user: 'Ask',
}

const KINDS: Record<string, ToolKind> = {
  read_file: 'read',
  list_dir: 'read',
  find_files: 'read',
  search_code: 'read',
  symbol_outline: 'read',
  git_status: 'read',
  edit_file: 'diff',
  write_file: 'diff',
  move_file: 'fileop',
  delete_file: 'fileop',
  run_command: 'command',
  background_task: 'command',
  todo_write: 'meta',
  ask_user: 'meta',
}

function parseArgs(argsJson: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(argsJson)
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
  } catch {
    // A tool call whose arguments failed to parse is still worth announcing by name; the
    // model producing malformed JSON is exactly when the user most wants to see the row.
    return {}
  }
}

function str(o: Record<string, unknown>, key: string): string | null {
  const v = o[key]
  return typeof v === 'string' && v !== '' ? v : null
}

export function presentTool(name: string, argsJson: string): ToolPresentation {
  const args = parseArgs(argsJson)
  const kind = KINDS[name] ?? 'other'
  const verb = VERBS[name] ?? name

  if (name === 'move_file') {
    const from = str(args, 'from')
    const to = str(args, 'to')
    return { kind, verb, target: from && to ? `${from} → ${to}` : '', path: to }
  }
  if (name === 'background_task') {
    const action = str(args, 'action') ?? 'poll'
    const detail = str(args, 'command') ?? str(args, 'id') ?? ''
    return { kind, verb: `Background ${action}`, target: detail, path: null }
  }
  if (name === 'git_status') {
    return { kind, verb, target: str(args, 'base') ?? 'status', path: null }
  }
  if (name === 'todo_write') {
    return { kind, verb, target: 'updated the task list', path: null }
  }

  const command = str(args, 'command')
  if (command !== null) return { kind, verb, target: command, path: null }

  const path = str(args, 'path')
  const pattern = str(args, 'pattern') ?? str(args, 'query') ?? str(args, 'question')
  const target = path ?? pattern ?? ''
  return { kind, verb, target, path }
}
