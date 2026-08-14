import { sqlProcess } from './sql-process.js'
import type { DatabaseSettings } from './settings.js'
import { renderSchema } from './render.js'

/**
 * The database's shape, for the top of the prompt.
 *
 * Placed beside the repository map and for the same reason. Everything before the
 * conversation is a stable prefix the server keeps cached, so this is paid for ONCE on the
 * first request of a session and is free on every request after it. The same text handed over
 * as a tool result would cost a step every time and would still end up in the transcript.
 *
 * It exists because of a measurement, not a preference. Naming a tool in the prompt does not
 * make this model reach for it — `symbol_outline` was named for 81% of a 703-call corpus and
 * chosen zero times — so the reliable way to have the schema available is to have it
 * ALREADY THERE. "Which table holds the document status" then costs nothing at all.
 *
 * Best-effort by construction. A server that is asleep, a wrong password, a database that has
 * been renamed: all of them return null, the session starts exactly as it would have without
 * a database, and the `database` tool reports the real error the first time it is used. A
 * dead database must never be the reason a session cannot start.
 */

/**
 * Roughly 1.5k tokens. Deliberately smaller than the repository map's 10 000: a schema is
 * denser than an outline — every line is a column that exists — and a 200-table warehouse
 * would otherwise crowd out the code the session is actually about. What does not fit is
 * named as a count, so the model knows to ask rather than concluding the tables are absent.
 */
export const DEFAULT_SCHEMA_BUDGET = 6_000

/** Bounded hard: this runs on the path that opens a session, and a server that accepts a
 * connection and then never answers must not hold the window on its welcome screen. */
const SCHEMA_TIMEOUT_MS = 20_000

export async function loadSchemaBlock(
  settings: DatabaseSettings, budget = DEFAULT_SCHEMA_BUDGET,
): Promise<string | null> {
  const sql = sqlProcess()
  if (sql === null) return null
  try {
    const deadline = new Promise<null>((resolve) => setTimeout(() => resolve(null), SCHEMA_TIMEOUT_MS))
    const work = (async (): Promise<string | null> => {
      const connected = await sql.ensureConnected(settings.connectionString)
      if (connected['ok'] !== true) return null
      const reply = await sql.ask('schema', {})
      if (reply['ok'] !== true) return null
      return renderSchema(reply, budget)
    })()
    const rendered = await Promise.race([work, deadline])
    if (rendered === null || rendered === '') return null
    return `DATABASE\n${HEADER}\n\n${rendered}`
  } catch {
    // Every failure is the same failure here: there is no schema to show. The tool says why
    // when it is used, which is the moment the reason is worth reading.
    return null
  }
}

/**
 * Precise about what is trustworthy here, rather than cautious about all of it.
 *
 * The first version ended "confirm anything here before relying on it" — the repository
 * map's wording, carried over without thinking. But the map is derived from syntax and can
 * be wrong about meaning, while this was read from the server itself minutes ago and is
 * simply correct about structure. Measured: asked which column holds an invoice total, the
 * model answered correctly and called the tool TWICE first, because the header had told it
 * to. An instruction that buys a round trip and changes no answer is worse than no
 * instruction, so this one now names the two things that genuinely are not in here.
 */
const HEADER =
  'The structure of the database this workspace works against, read from the server when ' +
  'this session started. Table and column names, types, keys and relationships here are ' +
  'accurate — answer from them directly rather than looking them up again. Two things are ' +
  'NOT here: the DATA, and any change made since the session started. Use `database` for ' +
  'those, and for the body of a view or procedure.'
