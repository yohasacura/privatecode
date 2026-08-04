import { readFileSync } from 'node:fs'
import { globToRegExp } from '../permissions/rules.js'
import { localSettingsPath, projectSettingsPath, userSettingsPath } from '../permissions/settings.js'

/**
 * Formatter rules, read from the same three settings files the permission layers come from.
 *
 * ```json
 * { "format": [ { "match": "**\/*.ts", "command": "npx prettier --write $FILE" } ] }
 * ```
 *
 * The command comes from a file the MODEL cannot write — `.privatecode/` is denied to
 * every write tool as a built-in — which is exactly what makes running it after an edit
 * acceptable without a per-run approval. If that deny ever goes away, this becomes a way
 * for the model to run arbitrary commands with no gate, so the two are load-bearing
 * together.
 */

export interface FormatRule {
  /** Glob against the workspace-relative path, e.g. `**​/*.ts`. */
  match: string
  /** Shell command; `$FILE` is replaced with the workspace-relative path. */
  command: string
  test: RegExp
  source: string
}

export interface LoadedFormatRules {
  rules: FormatRule[]
  problems: string[]
}

function readRules(path: string, problems: string[]): FormatRule[] {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      problems.push(`Could not read ${path}: ${(e as Error).message}`)
    }
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // The permission loader already reports this file as unparseable; saying it twice in
    // two different voices is noise.
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const list = (parsed as Record<string, unknown>)['format']
  if (list === undefined) return []
  if (!Array.isArray(list)) {
    problems.push(`${path}: "format" must be an array of { match, command }; ignored.`)
    return []
  }

  const rules: FormatRule[] = []
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) {
      problems.push(`${path}: a "format" entry is not an object; ignored.`)
      continue
    }
    const { match, command } = entry as Record<string, unknown>
    if (typeof match !== 'string' || match.trim() === '') {
      problems.push(`${path}: a "format" entry has no "match" glob; ignored.`)
      continue
    }
    if (typeof command !== 'string' || command.trim() === '') {
      problems.push(`${path}: the "format" entry for "${match}" has no "command"; ignored.`)
      continue
    }
    if (!command.includes('$FILE')) {
      problems.push(`${path}: the "format" command for "${match}" does not mention $FILE, ` +
        'so it would format something other than the edited file; ignored.')
      continue
    }
    rules.push({ match, command, test: globToRegExp(match), source: path })
  }
  return rules
}

/**
 * All three layers, most specific LAST — so `local` wins over `project` wins over `user`
 * when several match, which is the same precedence the permission layers use.
 */
export function loadFormatRules(root: string, userPath = userSettingsPath()): LoadedFormatRules {
  const problems: string[] = []
  const rules = [
    ...readRules(userPath, problems),
    ...readRules(projectSettingsPath(root), problems),
    ...readRules(localSettingsPath(root), problems),
  ]
  return { rules, problems }
}

/** The rule that governs a path, or null. Last match wins; see `loadFormatRules`. */
export function ruleFor(rules: FormatRule[], relativePath: string): FormatRule | null {
  const normalized = relativePath.replace(/\\/g, '/').toLowerCase()
  let found: FormatRule | null = null
  for (const rule of rules) if (rule.test.test(normalized)) found = rule
  return found
}
