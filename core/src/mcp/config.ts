import { readFileSync } from 'node:fs'
import { localSettingsPath, projectSettingsPath, userSettingsPath } from '../permissions/settings.js'
import type { ServerSpec } from './transport.js'

/**
 * MCP servers, read from the same three settings files everything else comes from.
 *
 * ```json
 * {
 *   "mcpServers": {
 *     "sqlite": { "command": "uvx", "args": ["mcp-server-sqlite", "--db-path", "./app.db"] },
 *     "issues": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${GH_TOKEN}" } }
 *   }
 * }
 * ```
 *
 * The key is `mcpServers` because that is what Claude Desktop established: a config someone
 * already has can be pasted in unchanged, which is worth more than a name of our own.
 *
 * These files are write-denied to every model-issued tool (`.privatecode/` is a built-in
 * deny in the permission engine), and that is what makes it acceptable to spawn a command
 * named here: it is a command the USER wrote. If that deny ever goes away, this becomes a
 * way for the model to run anything without a gate, so the two are load-bearing together.
 */

export interface ServerConfig {
  name: string
  spec: ServerSpec
  /** Where it was configured, for problem messages. */
  source: string
  /**
   * Honour the server's own `annotations.readOnlyHint`, admitting such tools to plan mode.
   *
   * Off by default, and this is the important half. `readOnly` is what plan mode consults,
   * and taking a third party's word for "this changes nothing" is exactly the wrong
   * direction of trust: plan mode is a promise made to the USER. Opting in is one line in a
   * file the model cannot write.
   */
  trustReadOnlyHints: boolean
}

export interface LoadedServers {
  servers: ServerConfig[]
  problems: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Expands `${VAR}` from the environment.
 *
 * This is what lets a token stay OUT of a settings file that may well be committed: the
 * file names the variable, the environment holds the secret. An unset variable expands to
 * the empty string and is reported, because the alternative -- sending the literal text
 * `${GH_TOKEN}` as a bearer token -- produces a 401 that explains nothing.
 */
function expandEnv(value: string, where: string, problems: string[]): string {
  // `${VAR:-default}` is Claude Code's form for a variable that may be unset; honoured here
  // so a plugin's `.mcp.json` written against it reads the same way.
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, name: string, fallback: string | undefined) => {
    const found = process.env[name]
    if (found === undefined) {
      if (fallback !== undefined) return fallback
      problems.push(`${where} refers to \${${name}}, which is not set in the environment`)
      return ''
    }
    return found
  })
}

function readStringMap(
  raw: unknown, where: string, problems: string[], expand: boolean,
): Record<string, string> | undefined {
  if (raw === undefined) return undefined
  if (!isRecord(raw)) {
    problems.push(`${where} must be an object of string values; ignoring it`)
    return undefined
  }
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') {
      problems.push(`${where}.${key} must be a string; ignoring it`)
      continue
    }
    out[key] = expand ? expandEnv(value, `${where}.${key}`, problems) : value
  }
  return out
}

function readStringArray(raw: unknown, where: string, problems: string[]): string[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) {
    problems.push(`${where} must be an array of strings; ignoring it`)
    return undefined
  }
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      problems.push(`${where} contains a non-string entry; ignoring it`)
      continue
    }
    out.push(entry)
  }
  return out
}

/** One server entry. Returns null (with a problem) rather than throwing: a typo in one
 * server must not cost the user the others. */
function readServer(
  name: string, raw: unknown, source: string, problems: string[],
): ServerConfig | null {
  const where = `mcpServers.${name} in ${source}`
  if (!isRecord(raw)) {
    problems.push(`${where} must be an object; ignoring it`)
    return null
  }
  if (raw['enabled'] === false) return null

  const trustReadOnlyHints = raw['trustReadOnlyHints'] === true
  const command = raw['command']
  const url = raw['url']

  if (typeof command === 'string' && command.trim() !== '') {
    if (typeof url === 'string') {
      problems.push(`${where} has both "command" and "url"; using "command"`)
    }
    const spec: ServerSpec = { kind: 'stdio', command }
    const args = readStringArray(raw['args'], `${where}.args`, problems)
    if (args) spec.args = args
    const env = readStringMap(raw['env'], `${where}.env`, problems, true)
    if (env) spec.env = env
    if (typeof raw['cwd'] === 'string') spec.cwd = raw['cwd']
    return { name, spec, source, trustReadOnlyHints }
  }

  if (typeof url === 'string' && url.trim() !== '') {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      problems.push(`${where} has a "url" that is not a URL; ignoring this server`)
      return null
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      problems.push(`${where} must use http:// or https://; ignoring this server`)
      return null
    }
    const spec: ServerSpec = { kind: 'http', url: parsed.href }
    const headers = readStringMap(raw['headers'], `${where}.headers`, problems, true)
    if (headers) spec.headers = headers
    return { name, spec, source, trustReadOnlyHints }
  }

  problems.push(`${where} needs either a "command" (a local server) or a "url" (a remote one)`)
  return null
}

/**
 * The `mcpServers` object of any file that carries one — a settings layer, a project's
 * `.mcp.json`, a plugin's — read with the rules above. Exported for the plugin loader.
 */
export function readServersObject(servers: Record<string, unknown>, source: string, problems: string[]): ServerConfig[] {
  const out: ServerConfig[] = []
  for (const [name, entry] of Object.entries(servers)) {
    const config = readServer(name, entry, source, problems)
    if (config) out.push(config)
  }
  return out
}

function readFile(path: string, scope: string, problems: string[]): Map<string, ServerConfig> {
  const found = new Map<string, ServerConfig>()
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      problems.push(`Could not read ${path}: ${(e as Error).message}`)
    }
    return found
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // The permission loader already reports this file as unparseable; saying it twice in
    // two different voices is noise.
    return found
  }
  if (!isRecord(parsed)) return found
  const servers = parsed['mcpServers']
  if (servers === undefined) return found
  if (!isRecord(servers)) {
    problems.push(`"mcpServers" in ${scope} settings must be an object; ignoring it`)
    return found
  }
  for (const [name, entry] of Object.entries(servers)) {
    const config = readServer(name, entry, `${scope} settings`, problems)
    if (config) found.set(name, config)
  }
  return found
}

/**
 * Loads every configured server across the three layers.
 *
 * Later layers override earlier ones BY NAME -- the same precedence permissions use, so a
 * project can define `sqlite` and a developer can point it at their own database in
 * `settings.local.json` without editing the shared file. A server disabled in a later layer
 * (`"enabled": false`) is absent from that layer's map and therefore keeps the earlier
 * layer's definition, which is wrong; so disabling is checked here too, against the merged
 * result, by re-reading the flag from the last layer that named it.
 */
export function loadServers(workspaceRoot: string): LoadedServers {
  const problems: string[] = []
  const merged = new Map<string, ServerConfig>()
  const disabled = new Set<string>()

  for (const [scope, path] of [
    ['user', userSettingsPath()],
    ['project', projectSettingsPath(workspaceRoot)],
    ['local', localSettingsPath(workspaceRoot)],
  ] as const) {
    // Names present in this file but disabled: recorded so a later layer's "off" beats an
    // earlier layer's definition rather than silently leaving it on.
    for (const name of disabledNames(path)) disabled.add(name)
    for (const [name, config] of readFile(path, scope, problems)) {
      merged.set(name, config)
      disabled.delete(name)
    }
  }

  return { servers: [...merged.values()].filter((s) => !disabled.has(s.name)), problems }
}

/** Names a settings file explicitly turns off. Read separately because `readFile` skips
 * disabled entries entirely, and "off" has to be able to travel between layers. */
function disabledNames(path: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!isRecord(parsed) || !isRecord(parsed['mcpServers'])) return []
    return Object.entries(parsed['mcpServers'])
      .filter(([, entry]) => isRecord(entry) && entry['enabled'] === false)
      .map(([name]) => name)
  } catch {
    return []
  }
}
