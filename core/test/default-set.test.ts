import { expect, test } from 'vitest'
import { buildRegistry } from '../src/tools/default-set.js'
import {
  BUILT_IN_TOOL_NAMES, EDITING_TOOL_NAMES, READ_ONLY_TOOL_NAMES,
} from '../src/tools/built-in-names.js'

/**
 * Pins the readOnly set of the eight REAL tools, not synthetic stand-ins.
 *
 * registry.test.ts proves ToolRegistry.readOnlyNames() reflects whatever a tool declares
 * about itself — but that only guarantees the mechanism is honest, not that the actual
 * tools wired into the CLI declare the right thing. readOnly is now the sole basis Agent
 * uses to build plan mode's tool list (agent/loop.ts, mode === 'plan'), so a wrong flag on
 * one of the real tools is a silent safety hole that no other test catches: flip
 * edit-file.ts's readOnly to true and every other test in the suite still passes while
 * plan mode quietly offers and executes Edit. This test is what turns that into a
 * failing test instead of a shipped defect.
 */
test('buildRegistry() marks exactly the read-only tools as readOnly', () => {
  expect(buildRegistry().readOnlyNames().sort()).toEqual(
    ['AskUserQuestion',
     // Parses C# and answers a question about it. Available in PLAN mode for the same
     // reason as Skill: understanding how the code connects is most of what planning
     // is, and it is the one tool that answers that without reading files.
     'csharp_nav',
     // Reads a database and cannot change one: the helper behind it has no operation that
     // writes, `query` refuses a writing statement, and what survives runs in a transaction
     // that is always rolled back. In plan mode for the same reason as csharp_nav — a plan
     // written against what the code claims the schema is, rather than what it is, is the
     // plan that fails at the first migration.
     'database',
     'Glob', 'git_status', 'list_dir', 'Read',
     // Reads back the notes `remember` wrote, through the SAME freshness filter that puts
     // them in message 0. Read-only, and in plan mode deliberately: what earlier sessions
     // worked out about this project is most of what a plan should be built on, and the
     // alternative the model reached for without it was reading the notes file directly —
     // which returns the stale notes the filter exists to drop.
     'recall',
     'Grep',
     // Lists, reads and searches the stored conversations; it changes nothing. In plan mode
     // deliberately — "what did we decide about this last time" and "what were we doing on
     // Tuesday" are questions a plan should be built on rather than re-derived around.
     'sessions',
     'symbol_outline', 'TodoWrite',
     // Reads a file the user wrote and returns its text; it runs nothing. Read-only is
     // what makes it available in PLAN mode, which is where reading a procedure before
     // proposing a plan is most of the point.
     'Skill'].sort(),
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

/**
 * The shipped tool names, kept in step with the registry.
 *
 * `BUILT_IN_TOOL_NAMES` is what `doctor` prints a name from, and it is a hand-written list
 * rather than a read of the registry because reading the registry would close an import
 * cycle. This is what stops it drifting: a tool added without touching that file fails here,
 * loudly, instead of quietly rendering as `unknown-tool` in every diagnosis from then on.
 */
/**
 * The shipped names, plus the ones this build has RETIRED.
 *
 * `BUILT_IN_TOOL_NAMES` is what the diagnosis checks a transcript's tool names against, and a
 * transcript outlives the tool that wrote it. `doctor` was a tool until it became a slash
 * command; every session recorded before that has real `doctor` calls in it, and dropping
 * the name would render all of them as `unknown-tool` — quietly rewriting history in the one
 * report whose whole value is that it can be trusted without being audited.
 *
 * So the assertion is containment plus an explicit account of the difference, rather than
 * equality. A tool ADDED without touching that file still fails here, which is what the
 * equality was protecting; a tool retired without being recorded fails too.
 */
test('BUILT_IN_TOOL_NAMES is what buildRegistry() ships, plus only what was retired', () => {
  const registered = buildRegistry().schemas().map((s) => s.function.name)
  for (const name of registered) expect(BUILT_IN_TOOL_NAMES.has(name)).toBe(true)
  const extra = [...BUILT_IN_TOOL_NAMES].filter((n) => !registered.includes(n)).sort()
  expect(extra).toEqual([
    'ask_user', 'delegate', 'doctor', 'edit_file', 'find_files', 'read_file', 'run_command', 'search_code',
    'todo_write', 'use_skill', 'web', 'write_file',
  ])
})

test('the retired doctor is not offered to the model, in any mode', () => {
  // The point of retiring it. A tool that is not in the array cannot be called, which is
  // what makes "the model should not run this" true rather than merely asked for.
  const registry = buildRegistry()
  expect(registry.names()).not.toContain('doctor')
  expect(registry.readOnlyNames()).not.toContain('doctor')
})

/**
 * The editing set, kept in step with what those tools actually declare.
 *
 * `EDITING_TOOL_NAMES` decides whether the model's answer to a failed check counts as a fix
 * or as an argument, so drift here does not produce a missing row — it produces a WRONG
 * verdict. If `Edit` fell out of this set, a session where the model dutifully fixed
 * every build failure would be reported as one where it only ever looked, and the report
 * would be read as evidence.
 */
test('EDITING_TOOL_NAMES are registered tools that are not read-only', () => {
  const registry = buildRegistry()
  const readOnly = new Set(registry.readOnlyNames())
  for (const name of EDITING_TOOL_NAMES) {
    expect(registry.names()).toContain(name)
    expect(readOnly.has(name)).toBe(false)
  }
})

/**
 * The read-only set, pinned against the registry's own declaration.
 *
 * It decides when the report may say a check was answered by "only looking, changing
 * nothing" — a claim about the workspace, made in a document forwarded as evidence. Drift
 * makes that claim false rather than missing: a tool dropped from here starts reading as
 * having changed something, and a tool wrongly added here makes a real change invisible.
 */
test('READ_ONLY_TOOL_NAMES is exactly what buildRegistry() declares read-only', () => {
  expect([...READ_ONLY_TOOL_NAMES].sort()).toEqual(buildRegistry().readOnlyNames().sort())
})

test('the two sets cannot overlap', () => {
  for (const name of EDITING_TOOL_NAMES) expect(READ_ONLY_TOOL_NAMES.has(name)).toBe(false)
})
