import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { SubAgentRole } from '../agent/subagent.js'
import type { AgentMode } from '../permissions/engine.js'
import { parseFrontmatter } from '../skills/skills.js'
import { BOM } from '../tools/line-endings.js'
import { BUILT_IN_TOOL_NAMES, CLAUDE_CODE_OLD_NAMES, MCP_TOOL_PREFIX } from '../tools/built-in-names.js'

/**
 * A `tools:` line — `Read, Grep, Bash(git *)` or a YAML list — as tool names. The tools
 * carry Claude Code's names, so a name is taken as written; `(pattern)` narrowing is not
 * something an allow list here can express and is noted; a name this build has no tool
 * for is noted and dropped.
 */
export function readToolList(list: string, where: string, problems: string[]): string[] {
  const names = list.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter((s) => s !== '')
  const out = new Set<string>()
  for (const raw of names) {
    if (raw === '*') { out.add('*'); continue }
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\((.*)\))?$/.exec(raw)
    if (m === null) { problems.push(`${where}: "${raw}" is not a tool name; ignored`); continue }
    const name = CLAUDE_CODE_OLD_NAMES[m[1]!] ?? m[1]!
    if (m[2] !== undefined) problems.push(`${where}: the pattern in "${raw}" is not applied; ${name} is allowed as a whole`)
    if (!BUILT_IN_TOOL_NAMES.has(name) && !name.startsWith(MCP_TOOL_PREFIX)) {
      problems.push(`${where}: "${m[1]}" is not a tool PrivateCode has; ignored`)
      continue
    }
    out.add(name)
  }
  return [...out]
}

/**
 * `agents/<name>.md` — a Claude Code subagent, read as a `Agent` role
 * (docs/PLUGINS-2026-09.md §4).
 *
 * The file is frontmatter and a body: `description` is what the caller sees when it picks a
 * worker, the body is the brief the worker is handed. `tools` narrows what it may touch,
 * `permissionMode` sets how much it is trusted, `maxTurns` bounds it. The rest of what
 * Claude Code reads — `model`, `color`, `memory`, `hooks`, `skills`, `background`,
 * `isolation` — is read and reported as not acted on, never silently dropped.
 */

const VALID_SEGMENT = /^[a-z0-9][a-z0-9-]*$/
const MAX_PURPOSE_CHARS = 240
const MAX_BRIEF_CHARS = 12_000
const DEFAULT_MAX_STEPS = 12
const MAX_MAX_STEPS = 40

const IGNORED_FIELDS = ['model', 'color', 'memory', 'hooks', 'skills', 'background', 'isolation', 'mcpServers']

function modeFor(permissionMode: string | undefined, where: string, problems: string[]): AgentMode | undefined {
  switch ((permissionMode ?? '').trim()) {
    case '': case 'default': case 'inherit': return undefined
    case 'plan': return 'plan'
    case 'acceptEdits': return 'auto-edit'
    case 'bypassPermissions': case 'auto': case 'dontAsk': return 'autopilot'
    default:
      problems.push(`${where}: permissionMode "${permissionMode}" is not one Claude Code defines; the caller's mode is used`)
      return undefined
  }
}

/**
 * Reads one agent file. `prefix` namespaces the role (`plugin:agent`), as Claude Code does
 * for a plugin's agents.
 */
export function parseAgentMarkdown(text: string, fileName: string, prefix: string | null, where: string, problems: string[]): SubAgentRole | null {
  const normalized = (text.startsWith(BOM) ? text.slice(1) : text).replace(/\r\n/g, '\n')
  const parsed = parseFrontmatter(normalized)
  const fields = parsed?.fields ?? {}
  const body = (parsed?.body ?? normalized).trim()
  const declared = (fields['name'] ?? '').trim()
  const base = declared !== '' ? declared : fileName
  if (!VALID_SEGMENT.test(base)) {
    problems.push(`${where}: agent name "${base}" must be lowercase letters, digits and dashes; ignored`)
    return null
  }
  const name = prefix !== null ? `${prefix}:${base}` : base
  let purpose = (fields['description'] ?? '').replace(/\s+/g, ' ').trim()
  if (purpose === '') {
    problems.push(`${where}: no "description" in the frontmatter; the first line of the body stands in`)
    purpose = body.split('\n').find((l) => l.trim() !== '')?.replace(/^#+\s*/, '').trim() ?? `the ${base} agent`
  }
  if (purpose.length > MAX_PURPOSE_CHARS) purpose = `${purpose.slice(0, MAX_PURPOSE_CHARS - 1)}…`
  let brief = body
  if (brief === '') {
    problems.push(`${where}: the file has no body, so the agent's brief is its description`)
    brief = purpose
  }
  if (brief.length > MAX_BRIEF_CHARS) {
    problems.push(`${where}: the brief is ${brief.length} characters; the first ${MAX_BRIEF_CHARS} are used`)
    brief = brief.slice(0, MAX_BRIEF_CHARS)
  }

  const role: SubAgentRole = { name, purpose, brief, maxSteps: DEFAULT_MAX_STEPS }
  const tools = fields['tools']
  if (tools !== undefined && tools.trim() !== '') {
    const mapped = readToolList(tools, `${where}: tools`, problems)
    if (mapped.includes('*')) { /* everything the caller has */ } else if (mapped.length > 0) role.tools = mapped
    else problems.push(`${where}: none of the tools listed exist here, so the agent gets what the caller has`)
  }
  const disallowed = fields['disallowedTools']
  if (disallowed !== undefined && disallowed.trim() !== '') {
    const mapped = readToolList(disallowed, `${where}: disallowedTools`, problems)
    if (mapped.length > 0) role.disallowedTools = mapped
  }
  const mode = modeFor(fields['permissionMode'], where, problems)
  if (mode !== undefined) role.mode = mode
  const maxTurns = fields['maxTurns']
  if (maxTurns !== undefined && maxTurns.trim() !== '') {
    const n = Number(maxTurns)
    if (Number.isInteger(n) && n > 0) role.maxSteps = Math.min(n, MAX_MAX_STEPS)
    else problems.push(`${where}: maxTurns "${maxTurns}" is not a positive integer; ${DEFAULT_MAX_STEPS} is used`)
  }
  const ignored = IGNORED_FIELDS.filter((f) => fields[f] !== undefined && fields[f] !== '')
  if (ignored.length > 0) problems.push(`${where}: ${ignored.join(', ')} ${ignored.length === 1 ? 'is' : 'are'} not acted on by PrivateCode`)
  return role
}

/** Every `*.md` in a folder, as roles. A missing folder is nothing; anything else is a problem. */
export function readAgentsDir(dir: string, prefix: string | null, label: string, problems: string[]): SubAgentRole[] {
  let entries: string[]
  try {
    entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name).sort()
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') problems.push(`Could not read ${dir}: ${(e as Error).message}`)
    return []
  }
  const roles: SubAgentRole[] = []
  for (const entry of entries) {
    const path = join(dir, entry)
    let text: string
    try { text = readFileSync(path, 'utf8') } catch (e) { problems.push(`Could not read ${path}: ${(e as Error).message}`); continue }
    const role = parseAgentMarkdown(text, entry.slice(0, -3).toLowerCase(), prefix, `${label}/${entry}`, problems)
    if (role !== null) roles.push(role)
  }
  return roles
}
