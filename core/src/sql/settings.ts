import { readFileSync } from 'node:fs'
import { localSettingsPath, projectSettingsPath, userSettingsPath } from '../permissions/settings.js'

/**
 * The database this workspace works against, from the same three files everything else is
 * configured in.
 *
 * ```json
 * { "database": { "connectionString": "Server=(localdb)\\MSSQLLocalDB;Database=Crm;Integrated Security=true" } }
 * ```
 *
 * **Integrated security is the shape to prefer**, because it puts no secret anywhere. Where a
 * password is unavoidable, `${env:NAME}` is expanded from the environment at load:
 *
 * ```json
 * { "database": { "connectionString": "Server=sql01;Database=Crm;User Id=app;Password=${env:CRM_PASSWORD}" } }
 * ```
 *
 * That is not decoration. `.privatecode/` is git-ignored in full, so a password written here
 * would not travel with the repository — but it would still sit in plain text in a file that
 * gets opened, screen-shared and copied to another laptop, and every one of those is a way to
 * lose it that the ignore rule does not cover.
 *
 * Absent configuration is the ordinary state, not a problem: most workspaces have no database
 * and must not be told about one.
 */

export interface DatabaseSettings {
  connectionString: string
  /** What the model and the window call it. Defaults to the database name once connected. */
  label?: string
}

export interface LoadedDatabaseSettings {
  database: DatabaseSettings | null
  problems: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * `${env:NAME}` replaced by the environment, or reported and left for the caller to refuse.
 *
 * An unset variable must NOT silently become an empty password: that produces a connection
 * attempt that fails with the server's own unhelpful message, several steps away from the
 * actual mistake, which is a line in a settings file.
 */
export function expandEnv(
  value: string, scope: string, problems: string[], env: NodeJS.ProcessEnv = process.env,
): string | null {
  let missing = false
  const out = value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const found = env[name]
    if (found === undefined || found === '') {
      problems.push(
        `"database.connectionString" in ${scope} settings refers to \${env:${name}}, and that ` +
        'environment variable is not set. The database is not configured until it is.',
      )
      missing = true
      return ''
    }
    return found
  })
  return missing ? null : out
}

function readLayer(
  path: string, scope: string, problems: string[], env: NodeJS.ProcessEnv,
): DatabaseSettings | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      problems.push(`Could not read ${path}: ${(e as Error).message}`)
    }
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null // the permission loader already reports this file as unparseable
  }
  if (!isRecord(parsed)) return null
  const db = parsed['database']
  if (db === undefined) return null
  if (!isRecord(db)) {
    problems.push(`"database" in ${scope} settings must be an object; ignoring it`)
    return null
  }

  const connectionString = db['connectionString']
  if (typeof connectionString !== 'string' || connectionString.trim() === '') {
    problems.push(`"database.connectionString" in ${scope} settings must be a connection string; ignoring it`)
    return null
  }
  const expanded = expandEnv(connectionString, scope, problems, env)
  if (expanded === null) return null

  const settings: DatabaseSettings = { connectionString: expanded }
  const label = db['label']
  if (label !== undefined) {
    if (typeof label !== 'string' || label.trim() === '') {
      problems.push(`"database.label" in ${scope} settings must be a name; ignoring it`)
    } else {
      settings.label = label.trim()
    }
  }
  return settings
}

/**
 * Later layers win WHOLE, unlike the browser's field-by-field merge.
 *
 * A connection string is one thing: half of a user-scope connection and half of a project one
 * is not a connection to anywhere, and merging them field-wise would produce exactly that the
 * first time someone set a label in one file and a server in another.
 */
export function loadDatabaseSettings(
  workspaceRoot: string, env: NodeJS.ProcessEnv = process.env,
): LoadedDatabaseSettings {
  const problems: string[] = []
  let database: DatabaseSettings | null = null
  for (const [scope, path] of [
    ['user', userSettingsPath()],
    ['project', projectSettingsPath(workspaceRoot)],
    ['local', localSettingsPath(workspaceRoot)],
  ] as const) {
    const found = readLayer(path, scope, problems, env)
    if (found !== null) database = found
  }
  return { database, problems }
}

/** Safe to print: everything but the secret. Used wherever a connection is named to the user
 * or to the model, so a password cannot reach a transcript that gets pasted into a chat. */
export function describeConnection(settings: DatabaseSettings): string {
  if (settings.label !== undefined) return settings.label
  const parts = new Map<string, string>()
  for (const pair of settings.connectionString.split(';')) {
    const at = pair.indexOf('=')
    if (at <= 0) continue
    parts.set(pair.slice(0, at).trim().toLowerCase(), pair.slice(at + 1).trim())
  }
  const server = parts.get('server') ?? parts.get('data source') ?? '?'
  const database = parts.get('database') ?? parts.get('initial catalog') ?? '?'
  return `${database} on ${server}`
}
