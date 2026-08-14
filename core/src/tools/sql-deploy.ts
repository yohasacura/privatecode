import { isAbsolute, join } from 'node:path'
import { sqlProcess } from '../sql/sql-process.js'
import { describeConnection } from '../sql/settings.js'
import type { Tool } from './types.js'

export interface SqlDeployArgs {
  action: 'script' | 'publish'
  dacpac: string
}

const ACTIONS: readonly SqlDeployArgs['action'][] = ['script', 'publish']

/**
 * Bringing a database up to the schema a `.sqlproj` describes.
 *
 * **Separate from `database`, and not read-only.** That is the whole point of it being its
 * own tool: `database` can be allowed once and forgotten, because nothing it does can be
 * regretted. This one changes a live database, the checkpoint history covers the working tree
 * and not the server, and no snapshot taken afterwards can undo a column that has been
 * dropped. It goes through the permission engine every time, and it should.
 *
 * `script` is the honest default and the reason both actions live here: it produces exactly
 * the SQL `publish` would run, and runs none of it. A model that has read the script has
 * given the user something to approve; a model that has only intentions has not.
 *
 * Two of DacFx's own guards stay on and are not exposed as options. `BlockOnPossibleDataLoss`
 * stops a deployment that would discard rows. `DropObjectsNotInSource` stays off, so a
 * deployment adds and alters but does not remove — a schema deployment that quietly drops the
 * table someone forgot to put in the project is the failure people tell stories about.
 * Turning either off is a decision made at a keyboard with the script in view, never
 * something reached through a tool call.
 */
export const sqlDeployTool: Tool<SqlDeployArgs> = {
  name: 'sql_deploy',
  // Deliberately absent from plan mode, and gated on every use in every other mode.
  readOnly: false,
  description:
    'Applies a built SQL Server database project (a .dacpac, produced by `dotnet build` on a ' +
    '.sqlproj) to the workspace\'s database. Use action "script" FIRST: it returns the exact ' +
    'SQL that would run and changes nothing, which is what makes the change reviewable. ' +
    '"publish" then applies it. Deployments add and alter; they do not drop objects missing ' +
    'from the project, and one that would lose rows is refused rather than performed.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...ACTIONS],
        description:
          'script = return the SQL that would run, change nothing. publish = apply it.',
      },
      dacpac: {
        type: 'string',
        description:
          'Path to the .dacpac, workspace-relative or absolute. Building a .sqlproj puts one ' +
          'under its bin/ folder.',
      },
    },
    required: ['action', 'dacpac'],
  },
  validate(raw) {
    const r = raw as Partial<SqlDeployArgs>
    if (typeof r?.action !== 'string' || !ACTIONS.includes(r.action as SqlDeployArgs['action'])) {
      return { ok: false, error: `action must be one of: ${ACTIONS.join(', ')}` }
    }
    if (typeof r.dacpac !== 'string' || r.dacpac.trim() === '') {
      return { ok: false, error: 'needs the path of a .dacpac — build the .sqlproj first' }
    }
    return { ok: true, args: { action: r.action as SqlDeployArgs['action'], dacpac: r.dacpac.trim() } }
  },
  /**
   * The ACTION is the permission key, not the file.
   *
   * "Allow sql_deploy for Probe.dacpac" would be a rule that stops meaning what it said the
   * moment the project gains a table — the file name is the same and its contents are not.
   * What a person can sensibly grant standing permission to is reading the script; applying
   * one is a decision per deployment.
   */
  permissionKey(args) {
    return { tool: 'sql_deploy', target: args.action }
  },
  async execute(args, ctx) {
    const configured = ctx.database ?? null
    if (configured === null) {
      return {
        ok: false,
        content:
          'No database is configured for this workspace, so there is nothing to deploy to. ' +
          'Add one to `.privatecode/settings.json` under "database".',
      }
    }

    const sql = sqlProcess()
    if (sql === null) {
      return {
        ok: false,
        content: 'Database access is not available in this build (the helper binary is not installed).',
      }
    }

    // Resolved through the workspace so a deployment cannot be pointed at a file outside it
    // by a relative path, and so the model can name `bin/Debug/X.dacpac` the way it names
    // every other path.
    let dacpac: string
    if (isAbsolute(args.dacpac)) {
      dacpac = args.dacpac
    } else {
      try {
        dacpac = ctx.workspace.resolve(join(args.dacpac))
      } catch (e) {
        return { ok: false, content: (e as Error).message }
      }
    }

    let connected: Record<string, unknown>
    try {
      connected = await sql.ensureConnected(configured.connectionString)
    } catch (e) {
      return { ok: false, content: `could not reach the database: ${(e as Error).message}` }
    }
    if (connected['ok'] !== true) {
      return {
        ok: false,
        content: `could not connect to ${describeConnection(configured)}: ` +
          `${String(connected['error'] ?? 'unknown')}`,
      }
    }

    let reply: Record<string, unknown>
    try {
      reply = await sql.ask(args.action, { dacpac })
    } catch (e) {
      return { ok: false, content: `${args.action} failed: ${(e as Error).message}` }
    }
    if (reply['ok'] !== true) {
      return { ok: false, content: `${args.action} failed: ${String(reply['error'] ?? 'unknown')}` }
    }

    const where = describeConnection(configured)
    if (args.action === 'publish') {
      const messages = typeof reply['messages'] === 'string' ? reply['messages'].trim() : ''
      return {
        ok: true,
        content: `Deployed to ${where}.${messages === '' ? '' : `\n\n${messages}`}`,
      }
    }

    const script = typeof reply['script'] === 'string' ? reply['script'] : ''
    if (script.trim() === '') {
      return { ok: true, content: `${where} already matches this project — nothing to deploy.` }
    }
    return { ok: true, content: `The SQL that publishing to ${where} would run:\n\n${script}` }
  },
}
