import { readFileSync } from 'node:fs'
import { parseRule, ruleMatches, type ParsedRule } from '../permissions/rules.js'
import { runPowershell } from '../powershell.js'
import { localSettingsPath, projectSettingsPath, userSettingsPath, settingsText } from '../permissions/settings.js'
import type { PermissionKey, ToolResult } from '../tools/types.js'
import type { Workspace } from '../workspace.js'

/**
 * After-tool hooks: a command the USER configured, run after a tool call, whose output the
 * model sees.
 *
 * One event, not a matrix. `after-tool` is where the useful things live — run the tests
 * after an edit, lint what was just written, notify something — and every other candidate
 * either has nowhere to put its output or has to be awaited at a point where waiting is
 * wrong. A turn-end hook, specifically, can only ever be a beep: its output cannot reach
 * the model, and awaiting it would delay the turn's completion by up to its timeout.
 *
 * Configured in the same settings files as permissions and formatting:
 *
 * ```json
 * { "hooks": [ { "after": "edit_file(src/**)", "command": "npm run lint" } ] }
 * ```
 *
 * `after` is parsed by `permissions/rules.ts`'s own `parseRule`, so hooks introduce ZERO
 * new syntax: `edit_file(src/**)` and `run_command(npm test:*)` mean here exactly what
 * they already mean in an allow/deny rule.
 *
 * A hook OBSERVES; it cannot block. The tool has already run by the time one fires, and a
 * mechanism that could veto an action after it happened would be a worse version of the
 * permission engine, which vetoes before. What a hook can do is tell the model something
 * it would otherwise have to spend a step discovering.
 */

const TIMEOUT_MS = 60_000
const MAX_OUTPUT_CHARS = 2_000
/** After this many failures the hook is disabled for the session: a broken command must
 * cost time once, not after every matching tool call. */
const MAX_FAILURES = 3

export interface HookSpec {
  raw: string
  rule: ParsedRule
  command: string
  source: string
  failures: number
}

export interface LoadedHooks {
  hooks: HookSpec[]
  problems: string[]
}

function readHooks(path: string, problems: string[]): HookSpec[] {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      problems.push(`Could not read ${path}: ${(e as Error).message}`)
    }
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(settingsText(raw))
  } catch {
    return [] // the permission loader already reports this file as unparseable
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const list = (parsed as Record<string, unknown>)['hooks']
  if (list === undefined) return []
  if (!Array.isArray(list)) {
    problems.push(`${path}: "hooks" must be an array of { after, command }; ignored.`)
    return []
  }

  const hooks: HookSpec[] = []
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) {
      problems.push(`${path}: a "hooks" entry is not an object; ignored.`)
      continue
    }
    const { after, command } = entry as Record<string, unknown>
    if (typeof after !== 'string' || typeof command !== 'string' ||
        after.trim() === '' || command.trim() === '') {
      problems.push(`${path}: a "hooks" entry needs both "after" and "command"; ignored.`)
      continue
    }
    const rule = parseRule(after)
    if (!rule) {
      problems.push(`${path}: could not understand the hook trigger "${after}"; ignored.`)
      continue
    }
    hooks.push({ raw: after, rule, command, source: path, failures: 0 })
  }
  return hooks
}

export function loadHooks(root: string, userPath = userSettingsPath()): LoadedHooks {
  const problems: string[] = []
  const hooks = [
    ...readHooks(userPath, problems),
    ...readHooks(projectSettingsPath(root), problems),
    ...readHooks(localSettingsPath(root), problems),
  ]
  return { hooks, problems }
}

export interface HookRunner {
  /** Runs every hook whose trigger matches, appending a bounded note to the tool's result
   * for the model. Returns the result unchanged when nothing matched. */
  afterTool(key: PermissionKey, result: ToolResult, signal?: AbortSignal): Promise<ToolResult>
}

export function createHookRunner(hooks: HookSpec[], workspace: Workspace): HookRunner {
  return {
    async afterTool(key, result, signal) {
      if (hooks.length === 0) return result
      const notes: string[] = []

      for (const hook of hooks) {
        if (hook.failures >= MAX_FAILURES) continue
        if (!ruleMatches(hook.rule, key)) continue
        try {
          // Through runPowershell so a timeout or an abort takes the whole tree down —
          // a hook is arbitrary user-configured shell, and killing the shell alone leaves
          // whatever it started behind.
          const { result: run } = await runPowershell(hook.command, {
            cwd: workspace.root, timeoutMs: TIMEOUT_MS, signal,
          })
          const out = (run.all ?? '').trim()
          const clipped = out.length > MAX_OUTPUT_CHARS
            ? `${out.slice(0, MAX_OUTPUT_CHARS)}\n... (hook output clipped)`
            : out
          // CONSECUTIVE failures, and a success clears the count. `MAX_FAILURES`'s own
          // comment says the intent is that a broken command must cost time once — but a
          // hook whose whole job is to report problems (`npm run lint`, a type check) exits
          // non-zero legitimately, and counting those cumulatively switched it off for the
          // rest of the session after the third red file. Resetting on success keeps the
          // guard pointed at what it was written for: a command that never works at all.
          if (run.exitCode !== 0) hook.failures++
          else hook.failures = 0
          notes.push(
            `[hook ${hook.raw}] ${hook.command} exited ${run.exitCode ?? '?'}` +
            `${clipped === '' ? '' : `:\n${clipped}`}`,
          )
          // And it SAYS so when it trips. It used to fall silent: the `continue` at the top
          // skips the hook on every later tool call with nothing in the transcript admitting
          // it, so a check the user believes is guarding their edits has quietly stopped.
          if (hook.failures === MAX_FAILURES) {
            notes.push(
              `[hook ${hook.raw}] failed ${MAX_FAILURES} times in a row and will not be run ` +
              'again this session.',
            )
          }
        } catch (e) {
          hook.failures++
          notes.push(`[hook ${hook.raw}] could not run: ${(e as Error).message}`)
        }
      }

      if (notes.length === 0) return result
      // Folded into `content` BEFORE the loop appends the tool message, so nothing is ever
      // rewritten -- the append-only transcript law holds. `display` follows it so the app
      // shows the same thing.
      const suffix = `\n\n${notes.join('\n')}`
      return {
        ...result,
        content: `${result.content}${suffix}`,
        ...(result.display !== undefined ? { display: `${result.display}${suffix}` } : {}),
      }
    },
  }
}
