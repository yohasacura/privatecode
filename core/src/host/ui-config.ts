import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * `%APPDATA%\PrivateCode\ui.json` -- the UI's own small preferences file: last-used server
 * URL and a short recent-workspaces list (Plan 4 Task 8's `config.get`/`config.set`).
 *
 * Deliberately a SEPARATE file from `permissions/settings.ts`'s `userSettingsPath()`
 * (`settings.json`): that file holds PERMISSION rules (allow/ask/deny), is audited, and is
 * merged across three layers (user/project/local) by `loadLayers()`. This file holds
 * nothing security-relevant at all -- only which server URL and workspace the UI last
 * pointed at -- and has no layering. Mixing the two would make any future audit of the
 * permissions file also have to reason about UI preferences that carry no permission
 * weight, for no benefit; keeping them apart means `settings.json`'s meaning never has to
 * be "permissions, plus whatever else accreted onto it."
 *
 * Falls back to `<home>\AppData\Roaming` if `APPDATA` is unset, matching
 * `userSettingsPath()`'s own fallback.
 */
export function uiConfigPath(): string {
  const appData = process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming')
  return join(appData, 'PrivateCode', 'ui.json')
}

/** The window's theme setting: follow the OS, or one of the two by hand. */
export type ThemeSetting = 'system' | 'dark' | 'light'
export const THEME_SETTINGS: readonly ThemeSetting[] = ['system', 'dark', 'light']

export interface UiConfig {
  serverUrl?: string
  recentWorkspaces: string[]
  theme?: ThemeSetting
}

function emptyUiConfig(): UiConfig {
  return { recentWorkspaces: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Tolerant read, the same discipline `permissions/settings.ts`'s `loadLayers` uses: a
 * missing file is the normal "never configured" state (empty config, nothing reported as
 * a problem -- this is expected for a fresh install). Anything else wrong (unreadable,
 * malformed JSON, wrong shape, a wrong-typed field) is a LOUD problem string plus a safe
 * default for the affected field(s) -- never a thrown exception, never a silent guess.
 *
 * `path` is a parameter (defaulting to `uiConfigPath()`) purely so tests can point this at
 * a temp file instead of the real `%APPDATA%`.
 */
export function loadUiConfig(path: string = uiConfigPath()): { config: UiConfig; problems: string[] } {
  const problems: string[] = []
  if (!existsSync(path)) return { config: emptyUiConfig(), problems }

  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (e) {
    problems.push(`could not read ui settings (${path}): ${(e as Error).message}`)
    return { config: emptyUiConfig(), problems }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    problems.push(`malformed JSON in ui settings (${path}): ${(e as Error).message}`)
    return { config: emptyUiConfig(), problems }
  }

  if (!isRecord(parsed)) {
    problems.push(`ui settings (${path}) must be a JSON object; ignoring its contents`)
    return { config: emptyUiConfig(), problems }
  }

  const config = emptyUiConfig()

  const serverUrlRaw = parsed['serverUrl']
  if (serverUrlRaw !== undefined) {
    if (typeof serverUrlRaw === 'string') config.serverUrl = serverUrlRaw
    else problems.push(`"serverUrl" in ui settings (${path}) is not a string; ignoring it`)
  }

  const themeRaw = parsed['theme']
  if (themeRaw !== undefined) {
    if (typeof themeRaw === 'string' && (THEME_SETTINGS as readonly string[]).includes(themeRaw)) {
      config.theme = themeRaw as ThemeSetting
    } else {
      problems.push(`"theme" in ui settings (${path}) is not one of system, dark, light; ignoring it`)
    }
  }

  const recentRaw = parsed['recentWorkspaces']
  if (recentRaw !== undefined) {
    if (Array.isArray(recentRaw)) {
      const strings = recentRaw.filter((entry): entry is string => typeof entry === 'string')
      if (strings.length !== recentRaw.length) {
        problems.push(`a non-string entry in ui settings (${path}) "recentWorkspaces" was ignored`)
      }
      config.recentWorkspaces = strings
    } else {
      problems.push(`"recentWorkspaces" in ui settings (${path}) is not an array; ignoring it`)
    }
  }

  return { config, problems }
}

/** How many recent workspaces `saveUiConfig` keeps -- most-recent first. */
const MAX_RECENT_WORKSPACES = 8

/**
 * Read-modify-write: merges `patch` (only the fields given) into whatever `ui.json`
 * already holds, then writes back pretty-printed with a trailing newline.
 *
 * Unlike `permissions/settings.ts`'s `addRuleToSettings`, a corrupt EXISTING file here
 * does NOT throw and refuse to write: nothing in `ui.json` is security-relevant enough to
 * justify blocking a settings-modal save over a hand-edit typo. `loadUiConfig` already
 * salvages whatever it safely can from a partially-broken file (see its own problem
 * reporting); this writes a fresh, valid document built from that salvage plus `patch`.
 *
 * These files live OUTSIDE the workspace jail by design (`%APPDATA%`, entirely outside any
 * workspace root), so this uses plain `node:fs` sync calls rather than routing through
 * `Workspace`, matching `addRuleToSettings`'s own reasoning.
 */
export function saveUiConfig(
  patch: { serverUrl?: string; recentWorkspace?: string; theme?: ThemeSetting },
  path: string = uiConfigPath(),
): void {
  const { config } = loadUiConfig(path)
  if (patch.theme !== undefined) config.theme = patch.theme

  if (patch.serverUrl !== undefined) config.serverUrl = patch.serverUrl

  if (patch.recentWorkspace !== undefined) {
    const withoutDuplicate = config.recentWorkspaces.filter((w) => w !== patch.recentWorkspace)
    config.recentWorkspaces = [patch.recentWorkspace, ...withoutDuplicate].slice(0, MAX_RECENT_WORKSPACES)
  }

  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}
