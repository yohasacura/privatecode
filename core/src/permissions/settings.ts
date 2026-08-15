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
 * A settings file's text, ready for `JSON.parse`.
 *
 * The only thing it does is drop a leading byte-order mark, and that is enough to matter:
 * `JSON.parse` on a string beginning with U+FEFF THROWS, and this ships on Windows, where
 * writing UTF-8 with a BOM is the default in PowerShell's `Out-File -Encoding utf8` and in
 * several editors. Every one of the six loaders that read these files parsed the raw string,
 * so a `settings.json` saved that way was silently ignored in full — permissions, the project
 * check, the database, the browser, hooks and formatting all at once.
 *
 * Found by writing one from PowerShell during a measurement and watching the feature under
 * test simply not happen. The file looked perfect in every editor that opened it.
 */
export function settingsText(raw: string): string {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
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
    parsed = JSON.parse(settingsText(raw))
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
 * Read-modify-write one layer file: read existing JSON, deep-default
 * `permissions.allow/ask/deny` to `[]`, append `rule` to `list` if it isn't already present
 * (compared trimmed on both sides), and write back pretty-printed with `\n` line endings.
 *
 * A MISSING file is the only case treated as `{}` -- that's the normal state for a layer
 * that has never had a rule remembered into it, and there is nothing to lose by starting
 * fresh. An EXISTING file that fails to parse, or whose shape can't be trusted (its JSON
 * root isn't an object, `permissions` is present but isn't an object, or one of
 * `allow`/`ask`/`deny` is present but isn't an array) is a different situation: it may hold
 * deny/ask rules the user is relying on right now, and silently replacing it with a fresh
 * document -- as this function used to do -- would permanently erase them the moment any
 * tool call happened to trigger a `remember()`. So this function now THROWS in every one of
 * those cases, naming the file and the problem, and writes nothing. The caller
 * (`engine.ts`'s `remember()`) catches this, keeps the just-approved rule as a session-only
 * grant, and surfaces the throw's message as a problem so the user learns their settings
 * file needs manual attention. `loadLayers` already reports these same shape problems when
 * *reading* a layer -- this is the write-side half of not compounding a broken file into
 * permanent data loss.
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
  editRules(filePath, (lists) => {
    const trimmedRule = rule.trim()
    if (!lists[list].some((existing) => existing.trim() === trimmedRule)) lists[list].push(rule)
  })
}

/**
 * Takes a rule back out, and returns whether it was there.
 *
 * The other half of `addRuleToSettings`, and it was missing for longer than it should have
 * been: the window could GRANT a standing permission from an approval card and from the
 * decision queue, and had no way to show what had been granted, let alone withdraw it. A
 * permission you cannot revoke from the same place you gave it is not a permission, it is a
 * one-way door — which is a strange shape for the one screen whose entire subject is what
 * the agent is allowed to do to your machine.
 *
 * A file that does not exist holds no rules, so removing from it is `false` and writes
 * nothing — notably it does NOT create an empty settings file as a side effect of a
 * revocation that had nothing to revoke.
 */
export function removeRuleFromSettings(
  filePath: string, list: 'allow' | 'ask' | 'deny', rule: string,
): boolean {
  if (!existsSync(filePath)) return false
  let removed = false
  editRules(filePath, (lists) => {
    const trimmedRule = rule.trim()
    const kept = lists[list].filter((existing) => existing.trim() !== trimmedRule)
    removed = kept.length !== lists[list].length
    lists[list] = kept
  })
  return removed
}

/**
 * The read-modify-write both of the above are: every validation, and the rule that unknown
 * keys survive, lives here once. The alternative — a second copy in the remover — is how the
 * two drift until one of them silently discards a field the other preserves.
 */
function editRules(
  filePath: string,
  edit: (lists: { allow: string[]; ask: string[]; deny: string[] }) => void,
): void {
  let doc: Record<string, unknown> = {}

  if (existsSync(filePath)) {
    const raw = readFileSync(filePath, 'utf8')
    let candidate: unknown
    try {
      candidate = JSON.parse(settingsText(raw))
    } catch (e) {
      throw new Error(
        `${filePath} exists but is not valid JSON (${(e as Error).message}); fix or delete it — refusing to overwrite`,
      )
    }
    if (!isRecord(candidate)) {
      throw new Error(
        `${filePath} exists but its JSON root is not an object; fix or delete it — refusing to overwrite`,
      )
    }
    doc = candidate
  }

  const permissionsRaw = doc['permissions']
  if (permissionsRaw !== undefined && !isRecord(permissionsRaw)) {
    throw new Error(`${filePath} exists but "permissions" is not an object; fix or delete it — refusing to overwrite`)
  }
  const existingPermissions: Record<string, unknown> = isRecord(permissionsRaw) ? permissionsRaw : {}

  const toStringArray = (key: 'allow' | 'ask' | 'deny'): string[] => {
    const value = existingPermissions[key]
    if (value === undefined) return []
    if (!Array.isArray(value)) {
      throw new Error(
        `${filePath} exists but "permissions.${key}" is not an array; fix or delete it — refusing to overwrite`,
      )
    }
    return value.filter((entry): entry is string => typeof entry === 'string')
  }

  const allow = toStringArray('allow')
  const ask = toStringArray('ask')
  const deny = toStringArray('deny')
  const lists = { allow, ask, deny }
  edit(lists)

  const nextDoc = {
    ...doc,
    permissions: { ...existingPermissions, allow: lists.allow, ask: lists.ask, deny: lists.deny },
  }

  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, `${JSON.stringify(nextDoc, null, 2)}\n`, 'utf8')
}
