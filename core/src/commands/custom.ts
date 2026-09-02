import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { BOM } from '../tools/line-endings.js'
import { PRIVATE_DIR } from '../private-dir.js'
import { parseFrontmatter } from '../skills/skills.js'

/**
 * User-written slash commands: a markdown file is a prompt template, and `/name arguments`
 * expands it into an ordinary user message.
 *
 * The point is not to save typing — it is that a good instruction for this model is long
 * and specific (which files to look at, what to check, what "done" means), and retyping it
 * every time is how it gets shortened into a worse one.
 *
 * A command is DATA, never behaviour: expansion produces text that goes through the same
 * turn as anything the user types. There is no shell interpolation and no file inclusion
 * inside a template — that would execute something from a file, outside the permission
 * engine, on one keystroke. Claude Code's `` !`cmd` `` form is therefore neutralised, not
 * run: the command stays in the text, marked as not executed.
 *
 * The layout is Claude Code's (docs/PLUGINS-2026-09.md §4): `commands/<name>.md`, a
 * subfolder namespacing its files (`review/security.md` → `/review:security`), optional
 * frontmatter with `description` and `argument-hint`, `$ARGUMENTS` and `$1`…`$9`. A plugin's
 * commands arrive as extra sources with the plugin's name as prefix (`/plugin:name`), and a
 * skill is a command too — `/name` expands to its SKILL.md — exactly as in Claude Code.
 */

const COMMANDS_DIR = `${PRIVATE_DIR}/commands`

/** ~2k tokens, permanent in the transcript, spent per invocation. A template should be
 * instructions, not a pasted document. */
const MAX_TEMPLATE_CHARS = 8_000
const MAX_COMMANDS = 200
const MAX_DEPTH = 3

/** The REPL's own commands. A file named after one of these would be unreachable, so it
 * is reported rather than silently shadowed. */
const RESERVED = new Set(['help', 'mode', 'new', 'sessions', 'resume', 'todos', 'compact', 'exit', 'memory', 'skills', 'plugin', 'plugins', 'reload-plugins'])

/** Where the caller's arguments are substituted. Absent, they are appended on a new line
 * instead, so a template that forgets the placeholder still receives them. */
const ARGS_TOKEN = '$ARGUMENTS'
const POSITIONAL = /\$([1-9])\b/g

/** Lowercase letters, digits and dashes: the set that survives a filename, a shell, and
 * being typed quickly. One segment of a name; segments are joined with `:`. */
const VALID_SEGMENT = /^[a-z0-9][a-z0-9-]*$/

export interface CommandSource {
  dir: string
  /** `plugin` for `/plugin:name`; absent for a folder whose files are commands as named. */
  prefix?: string
  /** `commands`: markdown files, subfolders namespacing. `skills`: folders holding SKILL.md. */
  kind: 'commands' | 'skills'
  /** For problem messages: `.claude/commands`, `commit-commands@claude-code-plugins`. */
  label: string
  /** Only these folder names (a manifest that points at one skill). */
  only?: string[]
  /** The name to give the single folder `only` names (a single-skill plugin is named after the plugin). */
  rename?: string
}

export interface CustomCommand {
  name: string
  path: string
  /** Frontmatter `description`, else the first `# heading` of the file, else its first line. */
  description: string
  template: string
  argumentHint?: string
  /** Where it came from, for the picker and for problem messages. */
  source: string
}

export interface LoadedCommands {
  commands: CustomCommand[]
  problems: string[]
}

function describe(template: string): string {
  for (const raw of template.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    return (line.startsWith('#') ? line.replace(/^#+\s*/, '') : line).slice(0, 100)
  }
  return ''
}

/** Claude Code runs `` !`cmd` `` before sending; PrivateCode leaves it in the text and says so. */
function neutraliseShell(template: string): string {
  return template.replace(/!`([^`\n]*)`/g, '`$1` (not run: PrivateCode does not execute commands from a template)')
}

interface FileRead { template: string; description: string; argumentHint?: string; userInvocable: boolean }

function readTemplate(path: string, label: string, problems: string[]): FileRead | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (e) {
    problems.push(`Could not read ${label}: ${(e as Error).message}`)
    return null
  }
  const normalized = (raw.startsWith(BOM) ? raw.slice(1) : raw).replace(/\r\n/g, '\n')
  const parsed = parseFrontmatter(normalized)
  const fields = parsed?.fields ?? {}
  const body = neutraliseShell((parsed?.body ?? normalized).trim())
  if (body === '') {
    problems.push(`Ignored ${label}: the file is empty.`)
    return null
  }
  if (body.length > MAX_TEMPLATE_CHARS) {
    problems.push(`Ignored ${label}: ${body.length} characters, over the ${MAX_TEMPLATE_CHARS} limit for a command template.`)
    return null
  }
  const description = (fields['description'] ?? '').replace(/\s+/g, ' ').trim()
  const hint = (fields['argument-hint'] ?? fields['argumentHint'] ?? '').trim()
  return {
    template: body,
    description: description !== '' ? description.slice(0, 160) : describe(body),
    ...(hint !== '' ? { argumentHint: hint } : {}),
    userInvocable: (fields['user-invocable'] ?? '').trim().toLowerCase() !== 'false',
  }
}

function readCommandsDir(source: CommandSource, dir: string, segments: string[], out: CustomCommand[], problems: string[]): void {
  let entries: string[]
  try {
    entries = readdirSync(dir).sort()
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') problems.push(`Could not read ${source.label}: ${(e as Error).message}`)
    return
  }
  for (const entry of entries) {
    if (out.length >= MAX_COMMANDS) {
      problems.push(`More than ${MAX_COMMANDS} commands; the rest of ${source.label} was ignored.`)
      return
    }
    const path = join(dir, entry)
    let isDir: boolean
    try { isDir = statSync(path).isDirectory() } catch { continue }
    if (isDir) {
      const seg = entry.toLowerCase()
      if (segments.length + 1 >= MAX_DEPTH || !VALID_SEGMENT.test(seg)) continue
      readCommandsDir(source, path, [...segments, seg], out, problems)
      continue
    }
    if (!entry.endsWith('.md')) continue
    const base = entry.slice(0, -3).toLowerCase()
    const label = `${source.label}/${[...segments, entry].join('/')}`
    if (!VALID_SEGMENT.test(base)) {
      problems.push(`Ignored ${label}: a command name may only use lowercase letters, digits and dashes.`)
      continue
    }
    const local = [...segments, base].join(':')
    if (source.prefix === undefined && RESERVED.has(local)) {
      problems.push(`Ignored ${label}: /${local} is a built-in command, so this file could never be reached.`)
      continue
    }
    const read = readTemplate(path, label, problems)
    if (read === null) continue
    const name = source.prefix !== undefined ? `${source.prefix}:${local}` : local
    out.push({ name, path, description: read.description, template: read.template, ...(read.argumentHint !== undefined ? { argumentHint: read.argumentHint } : {}), source: source.label })
  }
}

function readSkillsDir(source: CommandSource, out: CustomCommand[], problems: string[]): void {
  let entries: string[]
  try {
    entries = readdirSync(source.dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') problems.push(`Could not read ${source.label}: ${(e as Error).message}`)
    return
  }
  for (const folder of entries) {
    if (source.only !== undefined && !source.only.includes(folder)) continue
    const path = join(source.dir, folder, 'SKILL.md')
    if (!existsSync(path)) continue
    const base = (source.rename ?? folder).toLowerCase()
    if (!VALID_SEGMENT.test(base)) continue // the skills loader reports the bad name
    if (out.length >= MAX_COMMANDS) return
    const read = readTemplate(path, `${source.label}/${folder}/SKILL.md`, problems)
    if (read === null || !read.userInvocable) continue
    const name = source.prefix !== undefined ? `${source.prefix}:${base}` : base
    out.push({ name, path, description: read.description, template: read.template, ...(read.argumentHint !== undefined ? { argumentHint: read.argumentHint } : {}), source: source.label })
  }
}

/**
 * Every command from `.privatecode/commands/` and the extra sources. Never throws: a missing
 * directory is the normal state, and every other failure becomes a problem string.
 *
 * Re-read on every call rather than cached. These files are edited by hand while the app
 * is open, and a cache would mean "why isn't my change taking effect" — the cost is one
 * small directory read per invocation.
 *
 * Precedence: the extra sources in the order given, then PrivateCode's own folder, later
 * winning by name — so `.privatecode/commands/` beats `.claude/commands/`, and a skill and
 * a command of one name in one plugin resolve to the command. A clash is reported.
 */
export function listCommands(workspaceRoot: string, extra: readonly CommandSource[] = []): LoadedCommands {
  const problems: string[] = []
  const sources: CommandSource[] = [
    ...extra.filter((s) => s.kind === 'skills'),
    ...extra.filter((s) => s.kind === 'commands'),
    { dir: join(workspaceRoot, COMMANDS_DIR), kind: 'commands', label: COMMANDS_DIR },
  ]
  const byName = new Map<string, CustomCommand>()
  for (const source of sources) {
    const found: CustomCommand[] = []
    if (source.kind === 'skills') readSkillsDir(source, found, problems)
    else readCommandsDir(source, source.dir, [], found, problems)
    for (const c of found) {
      const shadowed = byName.get(c.name)
      if (shadowed !== undefined && shadowed.source !== c.source) {
        problems.push(`/${c.name} is defined in ${shadowed.source} and in ${c.source}; the one in ${c.source} is used.`)
      }
      byName.set(c.name, c)
    }
  }
  return { commands: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), problems }
}

export interface Expansion {
  name: string
  text: string
}

/** `$ARGUMENTS`, `$1`…`$9`; a template with neither gets the arguments appended. */
export function substituteArguments(template: string, args: string): string {
  const words = args === '' ? [] : args.split(/\s+/)
  const hasPositional = POSITIONAL.test(template)
  POSITIONAL.lastIndex = 0
  let text = template
  if (hasPositional) text = text.replace(POSITIONAL, (_m, n: string) => words[Number(n) - 1] ?? '')
  if (text.includes(ARGS_TOKEN)) return text.split(ARGS_TOKEN).join(args)
  if (hasPositional || args === '') return text
  return `${text}\n\n${args}`
}

/**
 * Turns `/name the rest of the line` into the command's text, or returns `null` when the
 * line is not a custom command at all — which is the signal to treat it as ordinary input.
 *
 * A `/name` that matches no file returns `null` too, deliberately: silently sending the
 * literal text is better than refusing, because most lines starting with `/` are a path.
 */
export function expandCommand(workspaceRoot: string, line: string, extra: readonly CommandSource[] = []): Expansion | null {
  const match = /^\/([a-z0-9][a-z0-9:-]*)(?:\s+([\s\S]*))?$/i.exec(line.trim())
  if (!match) return null
  const name = (match[1] as string).toLowerCase()
  const args = (match[2] ?? '').trim()

  const found = listCommands(workspaceRoot, extra).commands.find((c) => c.name === name)
  if (!found) return null
  return { name, text: substituteArguments(found.template, args) }
}
