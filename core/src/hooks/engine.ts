import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { execa } from 'execa'
import { killTree, POWERSHELL_EXE, powershellArgs } from '../powershell.js'
import { substitutePluginVars, type HookSource } from '../plugins/components.js'
import { CLAUDE_CODE_OLD_NAMES } from '../tools/built-in-names.js'

/**
 * Whether a Claude Code matcher (`*`, `Edit|Write`, a regex) names this tool. The tools
 * carry Claude Code's names, so a matcher is compared to the name itself; the three names
 * Claude Code retired (`Task` for `Agent`, …) are read as the tools they became.
 */
export function matcherCovers(matcher: string | undefined, toolName: string): boolean {
  const m = (matcher ?? '').trim()
  if (m === '' || m === '*') return true
  const alternatives = m.split('|').map((s) => s.trim()).filter((s) => s !== '')
  if (alternatives.every((a) => /^[A-Za-z0-9_*]+$/.test(a))) {
    return alternatives.some((a) => a === '*' || a === toolName || CLAUDE_CODE_OLD_NAMES[a] === toolName)
  }
  try {
    return new RegExp(m).test(toolName)
  } catch {
    return alternatives.some((a) => a === toolName)
  }
}
import type { PermissionKey, ToolResult } from '../tools/types.js'
import type { Workspace } from '../workspace.js'
import { createHookRunner, type HookSpec } from './hooks.js'

/**
 * Claude Code's hook contract, run by PrivateCode (docs/PLUGINS-2026-09.md §5).
 *
 * A hook is a command a person configured — in a plugin's `hooks/hooks.json`, in
 * `.claude/settings.json`, in PrivateCode's own settings — that runs at one of the events
 * below, reads JSON on stdin, and answers with an exit code and, optionally, JSON on stdout.
 * The contract is Claude Code's to the letter, because the whole point is that a hook
 * written for Claude Code runs here unchanged:
 *
 *   exit 0   continue; stdout that is a JSON object is read for decisions, other stdout is
 *            context (UserPromptSubmit, SessionStart) or shown to the model (PostToolUse)
 *   exit 2   block; stderr is the reason, and it goes to the model
 *   other    a non-blocking error, noted in the transcript; three in a row disable the hook
 *
 * PrivateCode's older `[{ after, command }]` hooks keep running exactly as they did,
 * through `createHookRunner`, as `PostToolUse` hooks that match on the permission-rule
 * syntax rather than a tool name.
 *
 * The shell is Git Bash when it is on this machine — Claude Code's own choice on Windows,
 * and what every plugin's hook script assumes — and PowerShell otherwise.
 */

export const HOOK_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop',
  'SubagentStart', 'SubagentStop', 'PreCompact', 'SessionEnd',
] as const
export type HookEvent = typeof HOOK_EVENTS[number]

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 600_000
const MAX_OUTPUT_CHARS = 4_000
/** Consecutive failures (a spawn error, a timeout, an exit other than 0 or 2) that disable a hook for the session. */
const MAX_FAILURES = 3

export interface HookDefinition {
  event: HookEvent
  /** `*`, a `|` list, or a regex — against the tool name, the SessionStart source, the PreCompact trigger. */
  matcher: string
  command: string
  timeoutMs: number
  /** Started and not awaited (PostToolUse and later events only). */
  async: boolean
  /** `plugin:<name>`, or the settings file the hook came from. */
  owner: string
  where: string
  /** `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` for a plugin's hook. */
  vars?: { root: string; data: string }
  failures: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Claude Code's `hooks` object → definitions. Shape: `{ "PreToolUse": [ { "matcher": "Bash",
 * "hooks": [ { "type": "command", "command": "…", "timeout": 30 } ] } ] }`. Only `command`
 * hooks run; the other types (`prompt`, `agent`, `http`, `mcp_tool`) are reported.
 */
export function parseHookConfig(source: HookSource, problems: string[]): HookDefinition[] {
  const out: HookDefinition[] = []
  for (const [event, groups] of Object.entries(source.config)) {
    if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
      problems.push(`${source.where}: ${event} hooks are not supported by PrivateCode; ignored`)
      continue
    }
    if (!Array.isArray(groups)) {
      problems.push(`${source.where}: hooks.${event} must be an array; ignored`)
      continue
    }
    for (const group of groups) {
      if (!isRecord(group)) { problems.push(`${source.where}: an entry under ${event} is not an object; ignored`); continue }
      const matcher = typeof group['matcher'] === 'string' ? group['matcher'] : '*'
      // A group that IS a hook (no nested `hooks`) is accepted too; people write it.
      const hooks = Array.isArray(group['hooks']) ? group['hooks'] : (typeof group['command'] === 'string' ? [group] : [])
      if (hooks.length === 0) { problems.push(`${source.where}: an entry under ${event} has no "hooks"; ignored`); continue }
      for (const h of hooks) {
        if (!isRecord(h)) { problems.push(`${source.where}: a hook under ${event} is not an object; ignored`); continue }
        const type = typeof h['type'] === 'string' ? h['type'] : 'command'
        if (type !== 'command') { problems.push(`${source.where}: a "${type}" hook on ${event} is not supported by PrivateCode (only "command" hooks run); ignored`); continue }
        const command = typeof h['command'] === 'string' ? h['command'].trim() : ''
        if (command === '') { problems.push(`${source.where}: a hook under ${event} has no "command"; ignored`); continue }
        const seconds = typeof h['timeout'] === 'number' && h['timeout'] > 0 ? h['timeout'] : undefined
        out.push({
          event: event as HookEvent,
          matcher,
          command,
          timeoutMs: seconds !== undefined ? Math.min(seconds * 1000, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS,
          async: h['async'] === true,
          owner: source.owner,
          where: source.where,
          ...(source.root !== undefined && source.data !== undefined ? { vars: { root: source.root, data: source.data } } : {}),
          failures: 0,
        })
      }
    }
  }
  return out
}

// ---- the shell ----------------------------------------------------------------------------------

export type HookShell = { kind: 'bash'; path: string } | { kind: 'powershell' }

/** Git Bash, where Git for Windows puts it. Never WSL's `bash.exe`, which is a different machine. */
export function findGitBash(): string | null {
  if (process.platform !== 'win32') return existsSync('/bin/bash') ? '/bin/bash' : null
  const roots = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env['LOCALAPPDATA'] !== undefined ? join(process.env['LOCALAPPDATA'], 'Programs') : undefined]
  for (const root of roots) {
    if (root === undefined) continue
    const candidate = join(root, 'Git', 'bin', 'bash.exe')
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Bash when it is there, PowerShell otherwise. `PRIVATECODE_HOOK_SHELL=powershell` forces the latter. */
export function defaultHookShell(): HookShell {
  if (process.env['PRIVATECODE_HOOK_SHELL'] === 'powershell') return { kind: 'powershell' }
  const bash = findGitBash()
  return bash !== null ? { kind: 'bash', path: bash } : { kind: 'powershell' }
}

interface RunOutcome {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  cancelled: boolean
  /** The process never ran at all. */
  spawnError?: string
}

const forwardSlashes = (p: string): string => p.replace(/\\/g, '/')

async function runHook(def: HookDefinition, input: Record<string, unknown>, shell: HookShell, cwd: string, signal?: AbortSignal): Promise<RunOutcome> {
  // For bash, paths go in with forward slashes: `D:\x\y` unquoted in bash loses its
  // backslashes, and Git Bash reads `D:/x/y` without complaint.
  const path = shell.kind === 'bash' ? forwardSlashes : (p: string): string => p
  const project = path(cwd)
  const vars = def.vars !== undefined ? { root: path(def.vars.root), data: path(def.vars.data), project } : undefined
  const command = vars !== undefined ? substitutePluginVars(def.command, vars) : def.command.replace(/\$\{CLAUDE_PROJECT_DIR\}/g, project)
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_PROJECT_DIR: project,
    ...(vars !== undefined ? { CLAUDE_PLUGIN_ROOT: vars.root, CLAUDE_PLUGIN_DATA: vars.data } : {}),
  }
  const options = { cwd, env, input: JSON.stringify(input), reject: false as const, windowsHide: true, all: false as const, stripFinalNewline: false }
  let child
  try {
    child = shell.kind === 'bash'
      ? execa(shell.path, ['-c', command], options)
      : execa(POWERSHELL_EXE, powershellArgs(command), options)
  } catch (e) {
    return { exitCode: null, stdout: '', stderr: '', timedOut: false, cancelled: false, spawnError: e instanceof Error ? e.message : String(e) }
  }
  let timedOut = false
  let cancelled = false
  const stop = async (why: 'timeout' | 'cancelled'): Promise<void> => {
    if (timedOut || cancelled) return
    if (why === 'timeout') timedOut = true
    else cancelled = true
    await killTree(child)
  }
  const timer = setTimeout(() => { void stop('timeout') }, def.timeoutMs)
  const onAbort = (): void => { void stop('cancelled') }
  signal?.addEventListener('abort', onAbort)
  const result = await child.finally(() => {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  })
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''
  return {
    exitCode: result.exitCode ?? null, stdout, stderr, timedOut, cancelled,
    ...(result.exitCode === undefined && !timedOut && !cancelled ? { spawnError: result.shortMessage } : {}),
  }
}

// ---- stdin and stdout ----------------------------------------------------------------------------

/**
 * `tool_input` carries PrivateCode's arguments AND the Claude Code aliases, so a hook that
 * reads `.tool_input.file_path` works against `Edit`'s `path` (docs §4).
 */
export function claudeToolInput(name: string, args: unknown): Record<string, unknown> {
  const a: Record<string, unknown> = isRecord(args) ? { ...args } : {}
  switch (name) {
    case 'Edit': return { ...a, file_path: a['path'], old_string: a['search_text'], new_string: a['replace_text'] }
    case 'Write': case 'Read': case 'delete_file': case 'list_dir': return { ...a, file_path: a['path'] }
    case 'move_file': return { ...a, file_path: a['from'], new_path: a['to'] }
    case 'Bash': return { ...a, command: Array.isArray(a['commands']) ? (a['commands'] as unknown[]).join(' && ') : a['command'] }
    case 'Glob': return { ...a, pattern: a['glob'] }
    default: return a
  }
}

/** `updatedInput` from a hook, which may use either naming, back into the tool's own arguments. */
export function fromClaudeToolInput(name: string, updated: unknown, original: unknown): unknown {
  if (!isRecord(updated)) return original
  const out: Record<string, unknown> = { ...(isRecord(original) ? original : {}) }
  const aliases: Record<string, Record<string, string>> = {
    Edit: { file_path: 'path', old_string: 'search_text', new_string: 'replace_text' },
    Write: { file_path: 'path' }, Read: { file_path: 'path' }, delete_file: { file_path: 'path' }, list_dir: { file_path: 'path' },
    move_file: { file_path: 'from', new_path: 'to' },
    Glob: { pattern: 'glob' },
  }
  const map = aliases[name] ?? {}
  for (const [key, value] of Object.entries(updated)) {
    if (name === 'Bash' && key === 'command' && typeof value === 'string') { out['commands'] = [value]; continue }
    out[map[key] ?? key] = value
  }
  return out
}

function parseJsonOutput(stdout: string): Record<string, unknown> | null {
  const text = stdout.trim()
  if (!text.startsWith('{')) return null
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function clip(text: string): string {
  const t = text.trim()
  return t.length > MAX_OUTPUT_CHARS ? `${t.slice(0, MAX_OUTPUT_CHARS)}\n… (hook output clipped)` : t
}

function specific(json: Record<string, unknown> | null): Record<string, unknown> {
  return json !== null && isRecord(json['hookSpecificOutput']) ? json['hookSpecificOutput'] : {}
}

// ---- the engine -------------------------------------------------------------------------------------

export interface ToolCallInfo {
  name: string
  args: unknown
  raw: string
  key: PermissionKey
  signal?: AbortSignal | undefined
  toolUseId?: string
}

export interface PreToolOutcome {
  verdict?: 'allow' | 'ask' | 'deny'
  reason?: string
  /** Which hook decided. */
  by?: string
  updatedArgs?: unknown
  /** Lines for the model: additional context, system messages, non-blocking errors. */
  notes: string[]
}

/** What the agent loop calls. PrivateCode's older `HookRunner` satisfies it too. */
export interface ToolHooks {
  beforeTool?(call: ToolCallInfo): Promise<PreToolOutcome>
  afterTool(key: PermissionKey, result: ToolResult, signal?: AbortSignal, call?: { name: string; args: unknown; raw: string; toolUseId?: string }): Promise<ToolResult>
}

export interface HookEngine extends ToolHooks {
  readonly problems: string[]
  definitions(): readonly HookDefinition[]
  has(event: HookEvent): boolean
  userPrompt(text: string, signal?: AbortSignal): Promise<{ text: string; blocked?: string; notes: string[] }>
  stop(finalText: string, active: boolean, signal?: AbortSignal): Promise<{ block?: string; notes: string[] }>
  sessionStart(source: 'startup' | 'resume' | 'clear' | 'compact'): Promise<{ context: string; notes: string[] }>
  sessionEnd(reason: string): Promise<void>
  subagent(phase: 'start' | 'stop', role: string, text: string, signal?: AbortSignal): Promise<void>
  preCompact(trigger: 'manual' | 'auto', signal?: AbortSignal): Promise<void>
}

export interface HookEngineOptions {
  sources: readonly HookSource[]
  /** PrivateCode's own `[{ after, command }]` hooks, run as before. */
  legacy?: readonly HookSpec[]
  workspace: Workspace
  sessionId?: () => string
  permissionMode?: () => string
  shell?: HookShell
  /** Where a problem that has no transcript to land in goes (SessionEnd, PreCompact). */
  onProblem?: (text: string) => void
}

export function createHookEngine(opts: HookEngineOptions): HookEngine {
  const problems: string[] = []
  const defs: HookDefinition[] = []
  for (const source of opts.sources) defs.push(...parseHookConfig(source, problems))
  const legacy = opts.legacy !== undefined && opts.legacy.length > 0 ? createHookRunner([...opts.legacy], opts.workspace) : null
  const shell = opts.shell ?? defaultHookShell()
  const cwd = opts.workspace.root

  const base = (event: HookEvent): Record<string, unknown> => ({
    session_id: opts.sessionId?.() ?? '',
    cwd,
    permission_mode: opts.permissionMode?.() ?? 'default',
    hook_event_name: event,
  })

  const matching = (event: HookEvent, subject: string): HookDefinition[] =>
    defs.filter((d) => d.event === event && d.failures < MAX_FAILURES && matcherCovers(d.matcher, subject))

  /** Runs one hook and reports a failure the way every event reports it. Returns null when it could not run. */
  const runOne = async (def: HookDefinition, input: Record<string, unknown>, notes: string[], signal?: AbortSignal): Promise<RunOutcome | null> => {
    const outcome = await runHook(def, input, shell, cwd, signal)
    const label = `[hook ${def.owner}]`
    if (outcome.spawnError !== undefined) {
      def.failures++
      notes.push(`${label} could not run: ${outcome.spawnError}`)
    } else if (outcome.timedOut) {
      def.failures++
      notes.push(`${label} timed out after ${Math.round(def.timeoutMs / 1000)} s and was stopped`)
    } else if (outcome.cancelled) {
      return null
    } else if (outcome.exitCode !== 0 && outcome.exitCode !== 2) {
      def.failures++
      notes.push(`${label} exited ${outcome.exitCode ?? '?'}${outcome.stderr.trim() !== '' ? `: ${clip(outcome.stderr)}` : ''}`)
    } else {
      def.failures = 0
      return outcome
    }
    if (def.failures === MAX_FAILURES) notes.push(`${label} failed ${MAX_FAILURES} times in a row and will not run again this session`)
    return null
  }

  const fire = (def: HookDefinition, input: Record<string, unknown>): void => {
    void runHook(def, input, shell, cwd).then((o) => {
      if (o.spawnError !== undefined) opts.onProblem?.(`[hook ${def.owner}] could not run: ${o.spawnError}`)
    })
  }

  const appendNotes = (result: ToolResult, notes: string[]): ToolResult => {
    if (notes.length === 0) return result
    const suffix = `\n\n${notes.join('\n')}`
    return { ...result, content: `${result.content}${suffix}`, ...(result.display !== undefined ? { display: `${result.display}${suffix}` } : {}) }
  }

  const engine: HookEngine = {
    problems,
    definitions: () => defs,
    has: (event) => defs.some((d) => d.event === event),

    async beforeTool(call) {
      const out: PreToolOutcome = { notes: [] }
      const hooks = matching('PreToolUse', call.name)
      if (hooks.length === 0) return out
      let args = call.args
      const rank = { deny: 3, ask: 2, allow: 1 } as const
      for (const def of hooks) {
        const input = { ...base('PreToolUse'), tool_name: call.name, tool_input: claudeToolInput(call.name, args), ...(call.toolUseId !== undefined ? { tool_use_id: call.toolUseId } : {}) }
        const o = await runOne(def, input, out.notes, call.signal)
        if (o === null) continue
        const label = `[hook ${def.owner}]`
        if (o.exitCode === 2) {
          const reason = clip(o.stderr) || clip(o.stdout) || 'blocked by the hook'
          return { ...out, verdict: 'deny', reason, by: def.owner }
        }
        const json = parseJsonOutput(o.stdout)
        if (json === null) continue
        if (typeof json['systemMessage'] === 'string') out.notes.push(`${label} ${clip(json['systemMessage'])}`)
        if (json['continue'] === false) {
          return { ...out, verdict: 'deny', reason: typeof json['stopReason'] === 'string' ? json['stopReason'] : 'the hook asked to stop', by: def.owner }
        }
        const s = specific(json)
        let decision: 'allow' | 'ask' | 'deny' | undefined
        if (s['permissionDecision'] === 'allow' || s['permissionDecision'] === 'ask' || s['permissionDecision'] === 'deny') decision = s['permissionDecision']
        else if (json['decision'] === 'approve') decision = 'allow'
        else if (json['decision'] === 'block') decision = 'deny'
        const reason = typeof s['permissionDecisionReason'] === 'string' ? s['permissionDecisionReason'] : typeof json['reason'] === 'string' ? json['reason'] : undefined
        if (decision === 'deny') return { ...out, verdict: 'deny', reason: reason ?? 'blocked by the hook', by: def.owner }
        if (decision !== undefined && (out.verdict === undefined || rank[decision] > rank[out.verdict])) {
          out.verdict = decision
          out.by = def.owner
          if (reason !== undefined) out.reason = reason
        }
        if (s['updatedInput'] !== undefined) {
          args = fromClaudeToolInput(call.name, s['updatedInput'], args)
          out.updatedArgs = args
          out.notes.push(`${label} changed the arguments of ${call.name}`)
        }
        if (typeof s['additionalContext'] === 'string' && s['additionalContext'].trim() !== '') out.notes.push(`${label} ${clip(s['additionalContext'])}`)
      }
      return out
    },

    async afterTool(key, result, signal, call) {
      let current = legacy !== null ? await legacy.afterTool(key, result, signal) : result
      if (call === undefined) return current
      const event: HookEvent = current.ok ? 'PostToolUse' : 'PostToolUseFailure'
      const hooks = matching(event, call.name)
      if (hooks.length === 0) return current
      const notes: string[] = []
      const input = {
        ...base(event), tool_name: call.name, tool_input: claudeToolInput(call.name, call.args),
        ...(call.toolUseId !== undefined ? { tool_use_id: call.toolUseId } : {}),
        tool_response: { ok: current.ok, content: current.content },
        ...(current.ok ? {} : { error: current.content }),
      }
      for (const def of hooks) {
        if (def.async) { fire(def, input); continue }
        const o = await runOne(def, input, notes, signal)
        if (o === null) continue
        const label = `[hook ${def.owner}]`
        if (o.exitCode === 2) {
          notes.push(`${label} ${clip(o.stderr) || clip(o.stdout) || 'blocked'}`)
          continue
        }
        const json = parseJsonOutput(o.stdout)
        if (json === null) {
          if (o.stdout.trim() !== '') notes.push(`${label} ${clip(o.stdout)}`)
          continue
        }
        if (json['decision'] === 'block' && typeof json['reason'] === 'string') notes.push(`${label} ${clip(json['reason'])}`)
        const s = specific(json)
        if (typeof s['additionalContext'] === 'string' && s['additionalContext'].trim() !== '') notes.push(`${label} ${clip(s['additionalContext'])}`)
        if (typeof json['systemMessage'] === 'string') notes.push(`${label} ${clip(json['systemMessage'])}`)
      }
      current = appendNotes(current, notes)
      return current
    },

    async userPrompt(text, signal) {
      const notes: string[] = []
      const hooks = matching('UserPromptSubmit', '*')
      let out = text
      for (const def of hooks) {
        const o = await runOne(def, { ...base('UserPromptSubmit'), prompt: text }, notes, signal)
        if (o === null) continue
        const label = `[hook ${def.owner}]`
        if (o.exitCode === 2) return { text, blocked: `Blocked by hook ${def.owner}: ${clip(o.stderr) || clip(o.stdout) || 'no reason given'}`, notes }
        const json = parseJsonOutput(o.stdout)
        if (json === null) {
          if (o.stdout.trim() !== '') out = `${out}\n\n${label} ${clip(o.stdout)}`
          continue
        }
        if (json['decision'] === 'block') return { text, blocked: `Blocked by hook ${def.owner}: ${typeof json['reason'] === 'string' ? json['reason'] : 'no reason given'}`, notes }
        if (json['continue'] === false) return { text, blocked: `Stopped by hook ${def.owner}: ${typeof json['stopReason'] === 'string' ? json['stopReason'] : 'no reason given'}`, notes }
        const s = specific(json)
        if (typeof s['additionalContext'] === 'string' && s['additionalContext'].trim() !== '') out = `${out}\n\n${label} ${clip(s['additionalContext'])}`
        if (typeof json['systemMessage'] === 'string') notes.push(`${label} ${clip(json['systemMessage'])}`)
      }
      return { text: out, notes }
    },

    async stop(finalText, active, signal) {
      const notes: string[] = []
      for (const def of matching('Stop', '*')) {
        const input = { ...base('Stop'), stop_hook_active: active, last_assistant_message: clip(finalText) }
        if (def.async) { fire(def, input); continue }
        const o = await runOne(def, input, notes, signal)
        if (o === null) continue
        if (o.exitCode === 2) return { block: `${clip(o.stderr) || clip(o.stdout) || 'the hook asked to continue'} (from hook ${def.owner})`, notes }
        const json = parseJsonOutput(o.stdout)
        if (json === null) continue
        if (json['decision'] === 'block') return { block: `${typeof json['reason'] === 'string' ? json['reason'] : 'the hook asked to continue'} (from hook ${def.owner})`, notes }
        if (typeof json['systemMessage'] === 'string') notes.push(`[hook ${def.owner}] ${clip(json['systemMessage'])}`)
      }
      return { notes }
    },

    async sessionStart(source) {
      const notes: string[] = []
      const parts: string[] = []
      for (const def of matching('SessionStart', source)) {
        const input = { ...base('SessionStart'), source }
        if (def.async) { fire(def, input); continue }
        const o = await runOne(def, input, notes)
        if (o === null) continue
        const json = parseJsonOutput(o.stdout)
        const s = specific(json)
        const text = typeof s['additionalContext'] === 'string' ? s['additionalContext'] : json === null ? o.stdout : ''
        if (text.trim() !== '') parts.push(`[hook ${def.owner}] ${clip(text)}`)
      }
      return { context: parts.join('\n\n'), notes }
    },

    async sessionEnd(reason) {
      const notes: string[] = []
      for (const def of matching('SessionEnd', '*')) {
        const capped = { ...def, timeoutMs: Math.min(def.timeoutMs, 10_000) }
        await runOne(capped, { ...base('SessionEnd'), reason }, notes)
      }
      for (const n of notes) opts.onProblem?.(n)
    },

    async subagent(phase, role, text, signal) {
      const notes: string[] = []
      const event: HookEvent = phase === 'start' ? 'SubagentStart' : 'SubagentStop'
      for (const def of matching(event, role)) {
        const input = { ...base(event), agent_type: role, ...(phase === 'start' ? { task: clip(text) } : { last_assistant_message: clip(text), stop_hook_active: false }) }
        if (def.async) { fire(def, input); continue }
        await runOne(def, input, notes, signal)
      }
      for (const n of notes) opts.onProblem?.(n)
    },

    async preCompact(trigger, signal) {
      const notes: string[] = []
      for (const def of matching('PreCompact', trigger)) {
        const input = { ...base('PreCompact'), trigger }
        if (def.async) { fire(def, input); continue }
        await runOne(def, input, notes, signal)
      }
      for (const n of notes) opts.onProblem?.(n)
    },
  }
  return engine
}
