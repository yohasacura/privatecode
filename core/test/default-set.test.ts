import { expect, test } from 'vitest'
import { buildRegistry } from '../src/tools/default-set.js'

/**
 * Pins the readOnly set of the eight REAL tools, not synthetic stand-ins.
 *
 * registry.test.ts proves ToolRegistry.readOnlyNames() reflects whatever a tool declares
 * about itself — but that only guarantees the mechanism is honest, not that the actual
 * tools wired into the CLI declare the right thing. readOnly is now the sole basis Agent
 * uses to build plan mode's tool list (agent/loop.ts, mode === 'plan'), so a wrong flag on
 * one of the real tools is a silent safety hole that no other test catches: flip
 * edit-file.ts's readOnly to true and every other test in the suite still passes while
 * plan mode quietly offers and executes edit_file. This test is what turns that into a
 * failing test instead of a shipped defect.
 */
test('buildRegistry() marks exactly the read-only tools as readOnly', () => {
  expect(buildRegistry().readOnlyNames().sort()).toEqual(
    ['ask_user',
     // Parses C# and answers a question about it. Available in PLAN mode for the same
     // reason as use_skill: understanding how the code connects is most of what planning
     // is, and it is the one tool that answers that without reading files.
     'csharp_nav',
     // Reads a database and cannot change one: the helper behind it has no operation that
     // writes, `query` refuses a writing statement, and what survives runs in a transaction
     // that is always rolled back. In plan mode for the same reason as csharp_nav — a plan
     // written against what the code claims the schema is, rather than what it is, is the
     // plan that fails at the first migration.
     'database',
     // Reads this workspace's own stored sessions and returns counts. Read-only in the
     // strongest sense available: `doctor/diagnose.ts` is built so that nothing but numbers
     // and a closed set of category names can come out of it.
     'doctor',
     'find_files', 'git_status', 'list_dir', 'read_file',
     // Reads back the notes `remember` wrote, through the SAME freshness filter that puts
     // them in message 0. Read-only, and in plan mode deliberately: what earlier sessions
     // worked out about this project is most of what a plan should be built on, and the
     // alternative the model reached for without it was reading the notes file directly —
     // which returns the stale notes the filter exists to drop.
     'recall',
     'search_code',
     // Searches stored transcripts and returns text; it changes nothing. In plan mode
     // deliberately — "what did we decide about this last time" is a question a plan should
     // be built on rather than re-derived around.
     'search_history',
     'symbol_outline', 'todo_write',
     // Reads a file the user wrote and returns its text; it runs nothing. Read-only is
     // what makes it available in PLAN mode, which is where reading a procedure before
     // proposing a plan is most of the point.
     'use_skill'],
  )
})

test('sql_deploy is deliberately not read-only, so plan mode cannot reach it', () => {
  // `database` can be allowed once and forgotten because nothing it does can be regretted.
  // This one changes a live server, and the checkpoint history covers the working tree and
  // not the database -- no snapshot taken afterwards undoes a dropped column. So it is
  // gated on every use, and absent from the mode whose whole promise is that it changes
  // nothing.
  const registry = buildRegistry()
  expect(registry.readOnlyNames()).not.toContain('sql_deploy')
  expect(registry.names()).toContain('sql_deploy')
})
