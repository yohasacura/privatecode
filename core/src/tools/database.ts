import { sqlProcess } from '../sql/sql-process.js'
import { describeConnection } from '../sql/settings.js'
import { renderRows, renderSchema } from '../sql/render.js'
import type { Tool } from './types.js'

export interface DatabaseArgs {
  action: 'schema' | 'describe' | 'query'
  /** For `describe`: the object. For `query`: the statement. Unused by `schema`. */
  target?: string
  limit?: number
}

const ACTIONS: readonly DatabaseArgs['action'][] = ['schema', 'describe', 'query']

/**
 * What is actually in the database, rather than what the code says should be.
 *
 * The two disagree constantly — a column added by hand, a migration half-applied, a procedure
 * someone edited in Management Studio — and every one of those is a bug the model cannot
 * reason its way to from the repository alone.
 *
 * `readOnly`, and meant literally: the helper behind it has no operation that changes
 * anything, `query` refuses a statement carrying a writing keyword, and whatever survives
 * that runs inside a transaction that is always rolled back. Available in plan mode for the
 * same reason `use_skill` is — understanding is most of what planning is.
 *
 * A workspace with no database configured is the ordinary case and says so plainly, naming
 * the file to write, rather than failing.
 */
export const databaseTool: Tool<DatabaseArgs> = {
  name: 'database',
  readOnly: true,
  description:
    'Answers "what tables are there?", "what columns does this have?", "what does this ' +
    'procedure do?" and "what is actually in this data?" against the workspace\'s SQL Server ' +
    'database, from the live server rather than from the code. Use it before assuming a ' +
    'schema from a model class or a migration — the two disagree often, and the database is ' +
    'the one that is right. Reads only: statements that would change anything are refused.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...ACTIONS],
        description:
          'schema = every table with its columns, keys and relationships, plus the names of ' +
          'views and procedures. describe = one object in full, including the body of a view ' +
          'or procedure. query = run a SELECT and get the rows.',
      },
      target: {
        type: 'string',
        description:
          'For describe: the object, like `dbo.Invoice`. For query: the SELECT statement. ' +
          'Not used by schema.',
      },
      limit: { type: 'number', description: 'Maximum rows for `query` (default 50, max 500).' },
    },
    required: ['action'],
  },
  validate(raw) {
    const r = raw as Partial<DatabaseArgs>
    if (typeof r?.action !== 'string' || !ACTIONS.includes(r.action as DatabaseArgs['action'])) {
      return { ok: false, error: `action must be one of: ${ACTIONS.join(', ')}` }
    }
    const action = r.action as DatabaseArgs['action']
    const args: DatabaseArgs = { action }
    if (action !== 'schema') {
      if (typeof r.target !== 'string' || r.target.trim() === '') {
        return {
          ok: false,
          error: action === 'describe'
            ? 'describe needs the name of an object, like dbo.Invoice'
            : 'query needs a SELECT statement',
        }
      }
      args.target = r.target.trim()
    }
    if (typeof r.limit === 'number' && Number.isFinite(r.limit) && r.limit > 0) {
      args.limit = Math.min(Math.floor(r.limit), 500)
    }
    return { ok: true, args }
  },
  permissionKey(args) {
    return { tool: 'database', target: args.action }
  },
  async execute(args, ctx) {
    const configured = ctx.database ?? null
    if (configured === null) {
      return {
        ok: false,
        content:
          'No database is configured for this workspace. Add one to ' +
          '`.privatecode/settings.json`:\n\n' +
          '  { "database": { "connectionString": "Server=(localdb)\\\\MSSQLLocalDB;' +
          'Database=YourDb;Integrated Security=true" } }\n\n' +
          'Prefer integrated security. Where a password is unavoidable, write ' +
          '${env:SOME_VARIABLE} and set it in the environment rather than in the file.',
      }
    }

    const sql = sqlProcess()
    if (sql === null) {
      return {
        ok: false,
        content:
          'Database access is not available in this build (the helper binary is not ' +
          'installed). Nothing else can reach the database from here.',
      }
    }

    let connected: Record<string, unknown>
    try {
      connected = await sql.ensureConnected(configured.connectionString)
    } catch (e) {
      return { ok: false, content: `could not reach the database: ${(e as Error).message}` }
    }
    if (connected['ok'] !== true) {
      // The helper's message names what it dialled, which for LocalDB is not what was asked
      // for. The connection string itself is never echoed — it can carry a password.
      return {
        ok: false,
        content: `could not connect to ${describeConnection(configured)}: ` +
          `${String(connected['error'] ?? 'unknown')}`,
      }
    }

    let reply: Record<string, unknown>
    try {
      reply = await sql.ask(
        args.action,
        args.action === 'schema' ? {}
          : args.action === 'describe' ? { object: args.target }
            : { sql: args.target, ...(args.limit !== undefined ? { limit: args.limit } : {}) },
      )
    } catch (e) {
      return { ok: false, content: `${args.action} failed: ${(e as Error).message}` }
    }
    if (reply['ok'] !== true) {
      return { ok: false, content: `${args.action} failed: ${String(reply['error'] ?? 'unknown')}` }
    }

    if (args.action === 'schema') return { ok: true, content: renderSchema(reply) }
    if (args.action === 'describe') return { ok: true, content: renderDescribe(reply, args.target ?? '') }
    return { ok: true, content: renderRows(reply) }
  },
}

function renderDescribe(reply: Record<string, unknown>, asked: string): string {
  if (reply['found'] !== true) return String(reply['note'] ?? `no object named "${asked}"`)
  const definition = typeof reply['definition'] === 'string' ? reply['definition'] : null
  const head = `${String(reply['name'])} — ${String(reply['kind'])}`
  return definition === null
    ? `${head}\n(no stored definition; use schema for its columns)`
    : `${head}\n\n${definition}`
}
