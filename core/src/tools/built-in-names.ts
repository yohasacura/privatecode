/**
 * The names of the tools this build ships, as data.
 *
 * A separate module from `default-set.ts` for one reason: `doctor/diagnose.ts` needs this
 * list, `default-set.ts` imports every tool including `doctor.ts`, and `doctor.ts` imports
 * `diagnose.ts` — so reading it from the registry would close a cycle. Kept honest by
 * `default-set.test.ts`, which asserts this list is exactly what `buildRegistry()` returns:
 * a tool added without touching this file fails that test rather than quietly falling out.
 *
 * Why a list at all, when a shape check looked like enough: it was not. A tool name reaching
 * the diagnosis comes off the TRANSCRIPT, which is model output, and MCP tool names are
 * `mcp__<server>__<tool>` where `<server>` is a key out of the user's own config — a client
 * name, a project codename, whatever they called it. Checking that a name LOOKS like a tool
 * name admits every one of those. Membership is the only check that does not.
 */
export const BUILT_IN_TOOL_NAMES: ReadonlySet<string> = new Set([
  'ask_user',
  'background_task',
  'browser',
  'csharp_nav',
  'database',
  'delegate',
  'delete_file',
  'doctor',
  'edit_file',
  'find_files',
  'git_status',
  'list_dir',
  'move_file',
  'read_file',
  'recall',
  'remember',
  'run_command',
  'search_code',
  'search_history',
  'sql_deploy',
  'symbol_outline',
  'todo_write',
  'use_skill',
  'web',
  'write_file',
])

/** The prefix every MCP tool's name is built with (`mcp/manager.ts`'s `toolNameFor`). Ours,
 * not the user's — the part after it is theirs. */
export const MCP_TOOL_PREFIX = 'mcp__'

/**
 * The tools that CHANGE FILES, as opposed to the ones that merely write something.
 *
 * Narrower than "not read-only" on purpose, and the narrowing is the whole point. `remember`
 * writes, `browser` writes, `run_command` may write and there is no way to know — none of
 * them answers the question this set exists for, which is asked of a gate: *the check handed
 * the turn back, did the model then change the code, or did it explain why the check was
 * wrong?* Counting `remember` as a fix would make arguing look like fixing.
 *
 * `run_command` is deliberately outside. A build command changes nothing and a script may
 * change everything; folding it in either direction would be a guess reported as a count, so
 * it gets its own answer category instead.
 *
 * Kept honest by `default-set.test.ts`: every name here must be a registered tool that does
 * NOT declare `readOnly`, so a tool that becomes read-only, or vanishes, fails the test
 * rather than silently dropping out of the gate analysis.
 */
export const EDITING_TOOL_NAMES: ReadonlySet<string> = new Set([
  'delete_file',
  'edit_file',
  'move_file',
  'write_file',
])
