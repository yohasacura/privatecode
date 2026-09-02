/**
 * Claude Code's tool names and PrivateCode's, both directions (docs/PLUGINS-2026-09.md §4).
 *
 * Everything a plugin author writes about tools uses Claude Code's names: a hook matcher
 * (`"matcher": "Edit|Write"`), an agent's `tools:` line, a skill's `allowed-tools`. Each is
 * translated here, once, so the rest of the code keeps talking about `edit_file`.
 */

/** Claude Code name → the PrivateCode tools it stands for. An empty list is "no equivalent". */
export const CLAUDE_TO_PRIVATE: Readonly<Record<string, readonly string[]>> = {
  Bash: ['run_command', 'background_task'],
  Edit: ['edit_file'],
  MultiEdit: ['edit_file'],
  Write: ['write_file'],
  Read: ['read_file'],
  Glob: ['find_files'],
  Grep: ['search_code'],
  LS: ['list_dir'],
  WebFetch: ['web'],
  WebSearch: ['web'],
  Task: ['delegate'],
  Agent: ['delegate'],
  TodoWrite: ['todo_write'],
  AskUserQuestion: ['ask_user'],
  Skill: ['use_skill'],
  NotebookEdit: [],
  NotebookRead: [],
}

/** PrivateCode name → the Claude Code name a hook or a matcher would use for it. */
export const PRIVATE_TO_CLAUDE: Readonly<Record<string, string>> = {
  run_command: 'Bash',
  background_task: 'Bash',
  edit_file: 'Edit',
  write_file: 'Write',
  move_file: 'Write',
  delete_file: 'Write',
  read_file: 'Read',
  find_files: 'Glob',
  search_code: 'Grep',
  list_dir: 'LS',
  web: 'WebFetch',
  delegate: 'Task',
  todo_write: 'TodoWrite',
  ask_user: 'AskUserQuestion',
  use_skill: 'Skill',
}

const NAME_WITH_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)(?:\((.*)\))?$/

export interface ToolNameTranslation {
  /** PrivateCode names, possibly several (Bash is two tools here) or none. */
  tools: string[]
  /** The `(pattern)` part of `Bash(git *)`, which PrivateCode's allow lists do not read. */
  pattern?: string
  /** Set when the Claude Code name has no equivalent, or was not a name at all. */
  problem?: string
}

/** One Claude Code tool reference — `Edit`, `Bash(git *)`, `mcp__github__create_issue`. */
export function toPrivateTools(claudeName: string): ToolNameTranslation {
  const raw = claudeName.trim()
  if (raw === '') return { tools: [], problem: 'an empty tool name' }
  if (raw.startsWith('mcp__')) return { tools: [raw] }
  if (raw === '*') return { tools: ['*'] }
  const m = NAME_WITH_PATTERN.exec(raw)
  if (m === null) return { tools: [], problem: `"${raw}" is not a tool name` }
  const name = m[1]!
  const pattern = m[2]
  const mapped = CLAUDE_TO_PRIVATE[name]
  if (mapped === undefined) {
    // Already one of ours? A plugin written with PrivateCode in mind may say so.
    if (PRIVATE_TO_CLAUDE[name] !== undefined || /^[a-z][a-z0-9_]*$/.test(name)) {
      return { tools: [name], ...(pattern !== undefined ? { pattern } : {}) }
    }
    return { tools: [], problem: `"${name}" is not a tool PrivateCode has` }
  }
  if (mapped.length === 0) return { tools: [], problem: `"${name}" has no equivalent in PrivateCode` }
  return { tools: [...mapped], ...(pattern !== undefined ? { pattern } : {}) }
}

/** A comma-separated or array-ish `tools:` line, translated. Problems are collected, not thrown. */
export function toPrivateToolList(list: string | readonly string[], where: string, problems: string[]): string[] {
  const names = typeof list === 'string'
    ? list.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter((s) => s !== '')
    : [...list]
  const out = new Set<string>()
  for (const name of names) {
    const t = toPrivateTools(name)
    if (t.problem !== undefined) { problems.push(`${where}: ${t.problem}; ignored`); continue }
    if (t.pattern !== undefined) problems.push(`${where}: the pattern in "${name}" is not applied; ${t.tools.join(', ')} is allowed as a whole`)
    for (const n of t.tools) out.add(n)
  }
  return [...out]
}

/** The Claude Code name a hook sees for one of ours. Unknown names pass through unchanged. */
export function toClaudeTool(privateName: string): string {
  return PRIVATE_TO_CLAUDE[privateName] ?? privateName
}

/**
 * Whether a Claude Code matcher (`*`, `Edit|Write`, a regex) names this PrivateCode tool.
 * Matched against the Claude Code name AND ours, so a matcher written for either works.
 */
export function matcherCovers(matcher: string | undefined, privateName: string): boolean {
  const m = (matcher ?? '').trim()
  if (m === '' || m === '*') return true
  const candidates = [privateName, toClaudeTool(privateName)]
  const alternatives = m.split('|').map((s) => s.trim()).filter((s) => s !== '')
  if (alternatives.every((a) => /^[A-Za-z0-9_*]+$/.test(a))) {
    return alternatives.some((a) => a === '*' || candidates.includes(a))
  }
  try {
    const re = new RegExp(m)
    return candidates.some((c) => re.test(c))
  } catch {
    return alternatives.some((a) => candidates.includes(a))
  }
}
