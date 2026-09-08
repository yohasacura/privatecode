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
/**
 * Tools this build no longer OFFERS but whose calls are still on disk.
 *
 * `doctor` was a tool until the owner took it away — the model kept reaching for it, and
 * there is nothing it can do with the answer: the report describes the agent's own behaviour
 * and is addressed to whoever maintains it. It is a `/doctor` command now, run by a person,
 * costing no generation at all.
 *
 * It stays NAMED here because this set is what the diagnosis checks a transcript's tool
 * names against, and every session recorded before the change has real `doctor` calls in it.
 * Dropping the name would render all of them as `unknown-tool` and quietly rewrite history —
 * in the one report whose entire value is that it can be trusted without being audited.
 */
/**
 * And the names the tools had before 2026-09-03, when they took Claude Code's (`Read`,
 * `Edit`, `Bash`, …): every session recorded before then names them the old way. The
 * permission rules a settings file still spells the old way are read by
 * `permissions/rules.ts`'s `LEGACY_TOOL_NAMES`; this list is for what is already on disk.
 */
const RETIRED_TOOL_NAMES: readonly string[] = [
  'doctor',
  'read_file', 'write_file', 'edit_file', 'run_command', 'find_files', 'search_code',
  'todo_write', 'ask_user', 'use_skill', 'delegate', 'web',
  // The second round (2026-09-07): the tools that still carried snake_case names.
  'list_dir', 'delete_file', 'move_file', 'git_status', 'sql_deploy', 'symbol_outline', 'csharp_nav',
  'browser', 'database', 'plugins', 'recall', 'remember', 'sessions', 'background_task',
]

export const BUILT_IN_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...RETIRED_TOOL_NAMES,
  'Agent',
  'AskUserQuestion',
  'Bash',
  'Browser',
  'CSharpNav',
  'CSharpRename',
  'Database',
  'DeleteFile',
  'Edit',
  'GitStatus',
  'Glob',
  'Grep',
  'LS',
  'MoveFile',
  'Plugin',
  'Read',
  'Recall',
  'Remember',
  'Sessions',
  'Skill',
  'SqlDeploy',
  'SymbolOutline',
  'TaskOutput',
  'TaskStop',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'Write',
])

/**
 * Names Claude Code itself retired, still found in plugins written against them: an
 * agent's `tools:` line or a hook's matcher saying `Task` means `Agent`. Claude Code's own
 * history, kept to three entries; nothing of PrivateCode's is translated here.
 */
export const CLAUDE_CODE_OLD_NAMES: Readonly<Record<string, string>> = {
  Task: 'Agent',
  MultiEdit: 'Edit',
  BashOutput: 'TaskOutput',
  KillShell: 'TaskStop',
  KillBash: 'TaskStop',
}

/** The prefix every MCP tool's name is built with (`mcp/manager.ts`'s `toolNameFor`). Ours,
 * not the user's — the part after it is theirs. */
export const MCP_TOOL_PREFIX = 'mcp__'

/**
 * The tools that change nothing, as the registry itself declares.
 *
 * A duplicate of `readOnlyNames()` for the reason the whole file exists — reading the
 * registry from the doctor would close an import cycle — and pinned by `default-set.test.ts`
 * against the real thing.
 *
 * It is here because MEMBERSHIP is the only honest way to say "the model went and looked
 * and changed nothing". Deciding that by falling through — not an editing tool, not
 * `Bash`, therefore read-only — asserted it of `Agent`, `SqlDeploy`,
 * `background_task`, `Browser`, `Remember` and every MCP tool, so a check answered by
 * delegating the fix to a sub-agent that rewrote four files was reported as `only looked`,
 * whose stated meaning is that nothing changed. An audit found it; the fallback is now the
 * other way round, and an unrecognised tool reads as having done something.
 */

export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'AskUserQuestion', 'CSharpNav', 'Database', 'Glob', 'GitStatus', 'LS',
  'Read', 'Recall', 'Grep', 'Sessions', 'SymbolOutline', 'TodoWrite',
  'Skill',
  // Not `TaskOutput`, although reading a process changes nothing: this set is also what
  // plan mode OFFERS, and a plan-mode turn has no Bash to start anything. Offered alone, it
  // was the one process-shaped tool a model asked to run something could still reach —
  // and it reached for it, with a made-up id, over and over. It goes with Bash now.
])

/**
 * The tools that CHANGE FILES, as opposed to the ones that merely write something.
 *
 * Narrower than "not read-only" on purpose, and the narrowing is the whole point. `Remember`
 * writes, `Browser` writes, `Bash` may write and there is no way to know — none of
 * them answers the question this set exists for, which is asked of a gate: *the check handed
 * the turn back, did the model then change the code, or did it explain why the check was
 * wrong?* Counting `Remember` as a fix would make arguing look like fixing.
 *
 * `Bash` is deliberately outside. A build command changes nothing and a script may
 * change everything; folding it in either direction would be a guess reported as a count, so
 * it gets its own answer category instead.
 *
 * Kept honest by `default-set.test.ts`: every name here must be a registered tool that does
 * NOT declare `readOnly`, so a tool that becomes read-only, or vanishes, fails the test
 * rather than silently dropping out of the gate analysis.
 */
export const EDITING_TOOL_NAMES: ReadonlySet<string> = new Set([
  // Rewrites every file that uses a symbol — the files are named in its result, not its arguments.
  'CSharpRename',
  'DeleteFile',
  'Edit',
  'MoveFile',
  'Write',
])
