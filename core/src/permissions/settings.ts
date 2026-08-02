import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * The three named rule lists a settings layer can carry. Every entry is a rule string in
 * the syntax `rules.ts`'s `parseRule` understands (`tool_name` or `tool_name(spec)`) --
 * this module does not parse or validate rule *syntax* itself, only the JSON shape around
 * it. `engine.ts` is what turns these strings into `ParsedRule`s and reports malformed
 * ones as problems.
 */
export interface PermissionSettings {
  allow: string[]
  ask: string[]
  deny: string[]
}

export interface SettingsLayer {
  scope: 'user' | 'project' | 'local'
  path: string
  permissions: PermissionSettings
}

function emptyPermissions(): PermissionSettings {
  return { allow: [], ask: [], deny: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function scopeLabel(scope: SettingsLayer['scope']): string {
  return `${scope} settings`
}

/**
 * `%APPDATA%\PrivateCode\settings.json`. Falls back to `<home>\AppData\Roaming` if
 * `APPDATA` is unset (not expected on a normal Windows session, but cheap to guard).
 */
export function userSettingsPath(): string {
  const appData = process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming')
  return join(appData, 'PrivateCode', 'settings.json')
}

/** `<root>\.privatecode\settings.json` -- shared, checked-in project policy. */
export function projectSettingsPath(root: string): string {
  return join(root, '.privatecode', 'settings.json')
}

/** `<root>\.privatecode\settings.local.json` -- personal, gitignored overrides. */
export function localSettingsPath(root: string): string {
  return join(root, '.privatecode', 'settings.local.json')
}

// Reads one of the three named lists out of an already-parsed `permissions` object,
// tolerating every way a hand-edited JSON file can be wrong: the key absent (silently
// defaults to `[]`, this is normal for a freshly created layer), the key present but not
// an array (a problem: the whole list is dropped rather than guessed at), or an array
// containing a non-string entry (a problem per bad entry; the entry is dropped, its
// string siblings are kept -- one typo shouldn't cost the user every other rule in the
// list).
function loadList(
  permissions: Record<string, unknown>,
  key: 'allow' | 'ask' | 'deny',
  scope: SettingsLayer['scope'],
  path: string,
  problems: string[],
): string[] {
  if (!(key in permissions)) return []
  const value = permissions[key]
  if (!Array.isArray(value)) {
    problems.push(`"${key}" in ${scopeLabel(scope)} (${path}) is not an array; ignoring it`)
    return []
  }
  const result: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') {
      problems.push(`a non-string entry in ${scopeLabel(scope)} (${path}) "${key}" list was ignored`)
      continue
    }
    result.push(entry)
  }
  return result
}

// Loads and validates one layer file. Never throws: every failure mode (file missing,
// unreadable, not valid JSON, not a JSON object, `permissions` not an object) is reported
// as a problem string and answered with an empty-but-valid `PermissionSettings`, so a
// broken settings file degrades the layer to "grants nothing" instead of crashing the
// engine or silently losing rules the user thinks are still in force.
function loadLayerFile(scope: SettingsLayer['scope'], path: string, problems: string[]): PermissionSettings {
  if (!existsSync(path)) return emptyPermissions()

  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (e) {
    problems.push(`could not read ${scopeLabel(scope)} (${path}): ${(e as Error).message}`)
    return emptyPermissions()
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    problems.push(`malformed JSON in ${scopeLabel(scope)} (${path}): ${(e as Error).message}`)
    return emptyPermissions()
  }

  if (!isRecord(parsed)) {
    problems.push(`${scopeLabel(scope)} (${path}) must be a JSON object; ignoring its contents`)
    return emptyPermissions()
  }

  const permissionsRaw = parsed['permissions']
  if (permissionsRaw === undefined) return emptyPermissions()
  if (!isRecord(permissionsRaw)) {
    problems.push(`"permissions" in ${scopeLabel(scope)} (${path}) is not an object; ignoring it`)
    return emptyPermissions()
  }

  return {
    allow: loadList(permissionsRaw, 'allow', scope, path, problems),
    ask: loadList(permissionsRaw, 'ask', scope, path, problems),
    deny: loadList(permissionsRaw, 'deny', scope, path, problems),
  }
}

/**
 * Loads all three layers (user, project, local) for a workspace rooted at `root`. A
 * missing file is an empty layer with no problem reported -- that is the normal state for
 * a workspace that has never had a rule remembered into it. A malformed file (bad JSON,
 * wrong shape, wrong-typed entries) is a problem string describing exactly what was wrong
 * and where, plus an empty layer for the affected list(s) -- never a thrown exception,
 * never a silently-dropped file whose rules the user believes are still active.
 */
export function loadLayers(root: string): { layers: SettingsLayer[]; problems: string[] } {
  const problems: string[] = []
  const specs: { scope: SettingsLayer['scope']; path: string }[] = [
    { scope: 'user', path: userSettingsPath() },
    { scope: 'project', path: projectSettingsPath(root) },
    { scope: 'local', path: localSettingsPath(root) },
  ]
  const layers = specs.map(({ scope, path }) => ({
    scope,
    path,
    permissions: loadLayerFile(scope, path, problems),
  }))
  return { layers, problems }
}

/**
 * Read-modify-write one layer file: read existing JSON (a missing file, or one whose
 * content isn't a usable JSON object, is treated the same as `{}` -- the write must
 * succeed and produce a fresh, valid file rather than fail because the old one was
 * corrupt), deep-default `permissions.allow/ask/deny` to `[]`, append `rule` to `list` if
 * it isn't already present verbatim, and write back pretty-printed with `\n` line endings.
 *
 * Any top-level key besides `permissions` -- and any key inside `permissions` besides
 * `allow`/`ask`/`deny` -- is carried through untouched, so a hand-added comment-like field
 * or a future setting this module doesn't know about survives a rule being remembered.
 *
 * These files live OUTSIDE the workspace jail by design (one of them is in `%APPDATA%`,
 * entirely outside any workspace root), so this uses plain `node:fs` sync calls rather
 * than routing through `Workspace`.
 */
export function addRuleToSettings(filePath: string, list: 'allow' | 'ask' | 'deny', rule: string): void {
  let doc: Record<string, unknown> = {}
  if (existsSync(filePath)) {
    try {
      const candidate: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
      if (isRecord(candidate)) doc = candidate
    } catch {
      // Corrupt existing file: fall through with a fresh `{}`. The user's new rule must
      // still get written -- refusing because the old file was already broken would
      // compound the problem, not fix it.
    }
  }

  const existingPermissions = isRecord(doc['permissions']) ? doc['permissions'] : {}
  const toStringArray = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []

  const allow = toStringArray(existingPermissions['allow'])
  const ask = toStringArray(existingPermissions['ask'])
  const deny = toStringArray(existingPermissions['deny'])
  const lists = { allow, ask, deny }
  if (!lists[list].includes(rule)) lists[list].push(rule)

  const nextDoc = {
    ...doc,
    permissions: { ...existingPermissions, allow: lists.allow, ask: lists.ask, deny: lists.deny },
  }

  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, `${JSON.stringify(nextDoc, null, 2)}\n`, 'utf8')
}
