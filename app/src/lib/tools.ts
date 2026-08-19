/**
 * One place that knows how each of the agent's tools should be PRESENTED: the verb, the
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
  /** `move_file` only: the SOURCE path. A restore of a move must put both sides back —
   * restoring only the destination deletes the file outright (it did not exist there at
   * the baseline) while the source is never recreated. */
  fromPath?: string
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

/**
 * The screenshot a `browser` call saved, or `null`.
 *
 * Anchored to the exact shape the tool writes, and that strictness is the point: the
 * tool's own prose mentions the path too ("Screenshot saved to …"), and so does the
 * model's answer. Matching loosely would turn any message that merely NAMES a screenshot
 * into an image, including one the model wrote about a file that no longer exists.
 */
export function screenshotPathOf(name: string, display: string | undefined): string | null {
  if (name !== 'browser' || display === undefined) return null
  return /^\.privatecode\/state\/browser\/shot-\d+\.png$/.test(display) ? display : null
}

/** `mcp__sqlite__query` → `sqlite / query`. Which server answered is the part a person
 * reading the transcript needs; the `mcp__` prefix exists for the rule language, not them. */
function presentMcp(name: string, args: Record<string, unknown>): ToolPresentation {
  const rest = name.slice('mcp__'.length)
  const cut = rest.indexOf('__')
  const server = cut === -1 ? rest : rest.slice(0, cut)
  const tool = cut === -1 ? '' : rest.slice(cut + 2)
  // No single argument is "the target" for an arbitrary server's tool, so the first string
  // one is shown as a hint and the card's body carries the rest.
  const firstString = Object.values(args).find((v) => typeof v === 'string' && v !== '')
  return {
    kind: 'other',
    verb: server,
    target: typeof firstString === 'string' ? `${tool}: ${firstString}` : tool,
    path: null,
  }
}

export function presentTool(name: string, argsJson: string): ToolPresentation {
  const args = parseArgs(argsJson)
  const kind = KINDS[name] ?? 'other'
  const verb = VERBS[name] ?? name

  if (name.startsWith('mcp__')) return presentMcp(name, args)

  if (name === 'browser') {
    const action = str(args, 'action') ?? 'read'
    // Deliberately NOT `text`: a fill can carry something the user pasted into a login form,
    // and this string goes in a header, in a title attribute, and into the session file. The
    // ref says where without saying what — the approval card already showed the value when
    // it mattered.
    const detail = str(args, 'url') ?? str(args, 'expression') ??
      (typeof args['ref'] === 'number' ? `ref_${args['ref']}` : '')
    return { kind: 'other', verb: `Browser ${action}`, target: detail, path: null }
  }

  if (name === 'move_file') {
    const from = str(args, 'from')
    const to = str(args, 'to')
    return {
      kind, verb, target: from && to ? `${from} → ${to}` : '', path: to,
      ...(from !== null ? { fromPath: from } : {}),
    }
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
  if (name === 'find_files') {
    // `glob` is the tool's only argument and a required one (find-files.ts), so nothing in
    // the generic chain at the bottom of this function ever matched it: every Find row in the
    // transcript rendered as a bare verb with nothing after it — no glob in the header, none
    // in the row's title attribute, and `!result.preview.includes(p.target)` is trivially
    // false for the empty string, so the collapsed preview line was suppressed as well.
    return { kind, verb, target: str(args, 'glob') ?? '', path: null }
  }
  // The two tools whose `path` names a DIRECTORY — always for `list_dir`, and for
  // `search_code` whichever of the two the model chose (its schema documents the argument as
  // "file or directory"). Returning it as `path` made the transcript render its "Open file"
  // button, which calls `fs.read`, which answers `… is a directory; use fs.tree`: a permanent
  // tab in the strip whose only content is that error. Neither offers a path rather than
  // guessing which kind this one is.
  if (name === 'list_dir') {
    return { kind, verb, target: str(args, 'path') ?? '', path: null }
  }
  if (name === 'search_code') {
    // The regex is what the row is about; `path` only scopes the search, and the generic
    // `path ?? pattern` below showed the scope INSTEAD — a search narrowed to a subtree
    // displayed the subtree and never said what was looked for. Both, in that order.
    const pattern = str(args, 'pattern')
    const scope = str(args, 'path')
    const parts = [pattern, scope === null ? null : `in ${scope}`].filter((p) => p !== null)
    return { kind, verb, target: parts.join(' '), path: null }
  }

  const command = str(args, 'command')
  if (command !== null) return { kind, verb, target: command, path: null }

  const path = str(args, 'path')
  const pattern = str(args, 'pattern') ?? str(args, 'query') ?? str(args, 'question')
  const target = path ?? pattern ?? ''
  return { kind, verb, target, path }
}
