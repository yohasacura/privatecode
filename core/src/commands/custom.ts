import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { BOM } from '../tools/line-endings.js'
import { PRIVATE_DIR } from '../private-dir.js'

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
 * engine, on one keystroke.
 */

export const COMMANDS_DIR = `${PRIVATE_DIR}/commands`

/** ~2k tokens, permanent in the transcript, spent per invocation. A template should be
 * instructions, not a pasted document. */
const MAX_TEMPLATE_CHARS = 8_000
const MAX_COMMANDS = 100

/** The REPL's own commands. A file named after one of these would be unreachable, so it
 * is reported rather than silently shadowed. */
const RESERVED = new Set(['help', 'mode', 'new', 'sessions', 'resume', 'todos', 'compact', 'exit', 'memory'])

/** Where the caller's arguments are substituted. Absent, they are appended on a new line
 * instead, so a template that forgets the placeholder still receives them. */
const ARGS_TOKEN = '$ARGUMENTS'

/** Lowercase letters, digits and dashes: the set that survives a filename, a shell, and
 * being typed quickly. */
const VALID_NAME = /^[a-z0-9][a-z0-9-]*$/

export interface CustomCommand {
  name: string
  path: string
  /** First `# heading` of the file, or its first non-empty line, trimmed for a menu. */
  description: string
  template: string
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

/**
 * Reads every `<name>.md` under `.privatecode/commands/`. Never throws: a missing
 * directory is the normal state, and every other failure becomes a problem string.
 *
 * Re-read on every call rather than cached. These files are edited by hand while the app
 * is open, and a cache would mean "why isn't my change taking effect" — the cost is one
 * small directory read per invocation.
 */
export function listCommands(workspaceRoot: string): LoadedCommands {
  const dir = join(workspaceRoot, COMMANDS_DIR)
  const problems: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      problems.push(`Could not read ${COMMANDS_DIR}: ${(e as Error).message}`)
    }
    return { commands: [], problems }
  }

  const commands: CustomCommand[] = []
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.md')) continue
    if (commands.length >= MAX_COMMANDS) {
      problems.push(`More than ${MAX_COMMANDS} command files in ${COMMANDS_DIR}; the rest were ignored.`)
      break
    }
    const name = entry.slice(0, -3).toLowerCase()
    const path = join(dir, entry)

    if (!VALID_NAME.test(name)) {
      problems.push(`Ignored ${entry}: a command name may only use lowercase letters, digits and dashes.`)
      continue
    }
    if (RESERVED.has(name)) {
      problems.push(`Ignored ${entry}: /${name} is a built-in command, so this file could never be reached.`)
      continue
    }

    let template: string
    try {
      if (statSync(path).isDirectory()) continue
      template = readFileSync(path, 'utf8')
    } catch (e) {
      problems.push(`Could not read ${entry}: ${(e as Error).message}`)
      continue
    }

    const normalized = (template.startsWith(BOM) ? template.slice(1) : template)
      .replace(/\r\n/g, '\n').trim()
    if (normalized === '') {
      problems.push(`Ignored ${entry}: the file is empty.`)
      continue
    }
    if (normalized.length > MAX_TEMPLATE_CHARS) {
      problems.push(`Ignored ${entry}: ${normalized.length} characters, over the ` +
        `${MAX_TEMPLATE_CHARS} limit for a command template.`)
      continue
    }

    commands.push({ name, path, description: describe(normalized), template: normalized })
  }
  return { commands, problems }
}

export interface Expansion {
  name: string
  text: string
}

/**
 * Turns `/name the rest of the line` into the command's text, or returns `null` when the
 * line is not a custom command at all — which is the signal to treat it as ordinary input.
 *
 * A `/name` that matches no file returns `null` too, deliberately: silently sending the
 * literal text is better than refusing, because most lines starting with `/` are a path.
 */
export function expandCommand(workspaceRoot: string, line: string): Expansion | null {
  const match = /^\/([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/i.exec(line.trim())
  if (!match) return null
  const name = (match[1] as string).toLowerCase()
  const args = (match[2] ?? '').trim()

  const found = listCommands(workspaceRoot).commands.find((c) => c.name === name)
  if (!found) return null

  const text = found.template.includes(ARGS_TOKEN)
    ? found.template.split(ARGS_TOKEN).join(args)
    : args === '' ? found.template : `${found.template}\n\n${args}`
  return { name, text }
}
