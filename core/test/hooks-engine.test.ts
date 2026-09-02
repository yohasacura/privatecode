import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  claudeToolInput, createHookEngine, findGitBash, fromClaudeToolInput, parseHookConfig, type HookEngineOptions, type HookShell,
} from '../src/hooks/engine.js'
import { parseRule } from '../src/permissions/rules.js'
import { Workspace } from '../src/workspace.js'
import type { HookSource } from '../src/plugins/components.js'

/**
 * Claude Code's hook contract, event by event (docs/PLUGINS-2026-09.md §5): stdin JSON,
 * exit codes, JSON decisions, matchers, timeouts, the circuit breaker — under Git Bash,
 * which is what a plugin's hook script assumes, and under PowerShell for the machine
 * without it.
 */

const bash = findGitBash()
let root: string
let bashShell: HookShell

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-hook-engine-'))
  mkdirSync(join(root, '.privatecode'), { recursive: true })
  bashShell = { kind: 'bash', path: bash ?? 'bash' }
})
afterAll(() => { try { rmSync(root, { recursive: true, force: true }) } catch { /* a handle still open on Windows */ } })

type Hook = { command: string; timeout?: number; async?: boolean; type?: string }
const config = (event: string, matcher: string, ...hooks: Hook[]): Record<string, unknown> => ({ [event]: [{ matcher, hooks: hooks.map((h) => ({ type: 'command', ...h })) }] })

const source = (cfg: Record<string, unknown>, owner = 'plugin:alpha'): HookSource => ({
  owner, root: 'C:\\plug\\root', data: 'C:\\plug\\data', config: cfg, where: `${owner}: hooks.json`,
})

const make = (cfg: Record<string, unknown>, extra: Partial<HookEngineOptions> = {}, shell: HookShell = bashShell) => createHookEngine({
  sources: [source(cfg)], workspace: new Workspace(root), shell, sessionId: () => 'sess-1', permissionMode: () => 'normal', ...extra,
})

const edit = { name: 'edit_file', args: { path: 'secrets.env', search_text: 'a', replace_text: 'b' }, raw: '{}', key: { tool: 'edit_file', paths: ['secrets.env'] } }

describe('parsing hooks.json', () => {
  it('reads command hooks and names what it cannot run', () => {
    const problems: string[] = []
    const defs = parseHookConfig(source({
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo a', timeout: 5 }, { type: 'prompt', prompt: 'x' }, { type: 'command' }] }],
      PostToolUse: [{ command: 'echo flat' }],
      Notification: [{ hooks: [{ type: 'command', command: 'echo n' }] }],
      Stop: 'nope',
    }), problems)
    expect(defs.map((d) => `${d.event}:${d.matcher}:${d.command}:${d.timeoutMs}`)).toEqual(['PreToolUse:Bash:echo a:5000', 'PostToolUse:*:echo flat:60000'])
    expect(defs[0]?.vars).toEqual({ root: 'C:\\plug\\root', data: 'C:\\plug\\data' })
    expect(problems).toEqual([
      expect.stringContaining('"prompt" hook on PreToolUse is not supported'),
      expect.stringContaining('has no "command"'),
      expect.stringContaining('Notification hooks are not supported'),
      expect.stringContaining('hooks.Stop must be an array'),
    ])
  })

  it('translates tool_input both ways', () => {
    expect(claudeToolInput('edit_file', edit.args)).toEqual({ path: 'secrets.env', search_text: 'a', replace_text: 'b', file_path: 'secrets.env', old_string: 'a', new_string: 'b' })
    expect(claudeToolInput('run_command', { commands: ['npm test', 'npm run build'] })).toMatchObject({ command: 'npm test && npm run build' })
    expect(fromClaudeToolInput('edit_file', { file_path: 'other.ts', new_string: 'c' }, edit.args)).toEqual({ path: 'other.ts', search_text: 'a', replace_text: 'c' })
    expect(fromClaudeToolInput('run_command', { command: 'npm test' }, { commands: ['x'] })).toEqual({ commands: ['npm test'] })
    expect(fromClaudeToolInput('web', 'junk', { url: 'u' })).toEqual({ url: 'u' })
  })
})

describe.skipIf(bash === null)('under Git Bash', () => {
  it('a PreToolUse hook that exits 2 denies the call with its stderr, for the tools its matcher names', async () => {
    const engine = make(config('PreToolUse', 'Edit|Write', { command: 'echo "no edits to secrets" >&2; exit 2' }))
    const denied = await engine.beforeTool!(edit)
    expect(denied).toMatchObject({ verdict: 'deny', reason: 'no edits to secrets', by: 'plugin:alpha' })
    const other = await engine.beforeTool!({ ...edit, name: 'read_file', key: { tool: 'read_file' } })
    expect(other.verdict).toBeUndefined()
  })

  it('reads permissionDecision, updatedInput and additionalContext from JSON', async () => {
    const allow = make(config('PreToolUse', '*', { command: `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"trusted"}}'` }))
    expect(await allow.beforeTool!(edit)).toMatchObject({ verdict: 'allow', reason: 'trusted' })
    const ask = make(config('PreToolUse', '*', { command: `echo '{"hookSpecificOutput":{"permissionDecision":"ask"}}'` }))
    expect((await ask.beforeTool!(edit)).verdict).toBe('ask')
    const deny = make(config('PreToolUse', '*', { command: `echo '{"decision":"block","reason":"legacy no"}'` }))
    expect(await deny.beforeTool!(edit)).toMatchObject({ verdict: 'deny', reason: 'legacy no' })
    const rewrite = make(config('PreToolUse', '*', { command: `echo '{"hookSpecificOutput":{"permissionDecision":"allow","updatedInput":{"file_path":"other.ts"},"additionalContext":"be careful"}}'` }))
    const out = await rewrite.beforeTool!(edit)
    expect(out.updatedArgs).toEqual({ path: 'other.ts', search_text: 'a', replace_text: 'b' })
    expect(out.notes).toEqual([expect.stringContaining('changed the arguments'), '[hook plugin:alpha] be careful'])
    // Two hooks: the stricter verdict wins.
    const both = make({ PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `echo '{"hookSpecificOutput":{"permissionDecision":"allow"}}'` }, { type: 'command', command: `echo '{"hookSpecificOutput":{"permissionDecision":"ask"}}'` }] }] })
    expect((await both.beforeTool!(edit)).verdict).toBe('ask')
  })

  it('hands the hook the documented stdin and environment', async () => {
    const engine = make(config('PreToolUse', '*', { command: 'cat > "$CLAUDE_PROJECT_DIR/stdin.json"; echo "$CLAUDE_PLUGIN_ROOT|$CLAUDE_PLUGIN_DATA|${CLAUDE_PLUGIN_ROOT}" > "$CLAUDE_PROJECT_DIR/env.txt"' }))
    await engine.beforeTool!({ ...edit, toolUseId: 'call-7' })
    const stdin = JSON.parse(readFileSync(join(root, 'stdin.json'), 'utf8')) as Record<string, unknown>
    expect(stdin).toMatchObject({
      session_id: 'sess-1', hook_event_name: 'PreToolUse', tool_name: 'Edit', permission_mode: 'normal', tool_use_id: 'call-7', cwd: root,
      tool_input: { file_path: 'secrets.env', path: 'secrets.env', old_string: 'a', new_string: 'b' },
    })
    expect(readFileSync(join(root, 'env.txt'), 'utf8').trim()).toBe('C:/plug/root|C:/plug/data|C:/plug/root')
  })

  it('PostToolUse output reaches the model; PostToolUseFailure only on a failure', async () => {
    const engine = make({
      ...config('PostToolUse', 'Write', { command: 'echo LINT-OK' }),
      ...config('PostToolUseFailure', '*', { command: 'echo FAILED-HOOK' }),
    })
    const call = { name: 'write_file', args: { path: 'a.ts', content: 'x' }, raw: '{}' }
    const ok = await engine.afterTool({ tool: 'write_file', paths: ['a.ts'] }, { ok: true, content: 'wrote', display: 'wrote (display)' }, undefined, call)
    expect(ok.content).toBe('wrote\n\n[hook plugin:alpha] LINT-OK')
    expect(ok.display).toBe('wrote (display)\n\n[hook plugin:alpha] LINT-OK')
    const failed = await engine.afterTool({ tool: 'write_file', paths: ['a.ts'] }, { ok: false, content: 'denied' }, undefined, call)
    expect(failed.content).toContain('FAILED-HOOK')
    expect(failed.content).not.toContain('LINT-OK')
    // Nothing to say about the call: the result is returned as it was.
    const untouched = { ok: true, content: 'read' }
    expect(await engine.afterTool({ tool: 'read_file' }, untouched, undefined, { name: 'read_file', args: {}, raw: '{}' })).toBe(untouched)
  })

  it('PostToolUse JSON: block reasons, additional context, exit 2 feedback', async () => {
    const engine = make({ PostToolUse: [{ matcher: '*', hooks: [
      { type: 'command', command: `echo '{"decision":"block","reason":"tests are red","hookSpecificOutput":{"additionalContext":"see CI"},"systemMessage":"note to self"}'` },
      { type: 'command', command: 'echo "formatter complained" >&2; exit 2' },
    ] }] })
    const out = await engine.afterTool({ tool: 'edit_file' }, { ok: true, content: 'edited' }, undefined, { name: 'edit_file', args: edit.args, raw: '{}' })
    expect(out.content.split('\n\n')[1]?.split('\n')).toEqual([
      '[hook plugin:alpha] tests are red', '[hook plugin:alpha] see CI', '[hook plugin:alpha] note to self', '[hook plugin:alpha] formatter complained',
    ])
  })

  it("PrivateCode's own after hooks keep running beside the new ones", async () => {
    const engine = make(config('PostToolUse', '*', { command: 'echo NEW' }), {
      legacy: [{ raw: 'edit_file', rule: parseRule('edit_file')!, command: 'echo OLD', source: 's', failures: 0 }],
    })
    const out = await engine.afterTool({ tool: 'edit_file' }, { ok: true, content: 'edited' }, undefined, { name: 'edit_file', args: edit.args, raw: '{}' })
    expect(out.content).toContain('[hook edit_file] echo OLD exited 0:\nOLD')
    expect(out.content).toContain('[hook plugin:alpha] NEW')
  })

  it('UserPromptSubmit adds context or blocks the prompt', async () => {
    const context = make(config('UserPromptSubmit', '*', { command: 'echo "Remember: tests first"' }))
    expect(await context.userPrompt('fix the bug')).toEqual({ text: 'fix the bug\n\n[hook plugin:alpha] Remember: tests first', notes: [] })
    const json = make(config('UserPromptSubmit', '*', { command: `echo '{"hookSpecificOutput":{"additionalContext":"branch is main"}}'` }))
    expect((await json.userPrompt('x')).text).toBe('x\n\n[hook plugin:alpha] branch is main')
    const blocked = make(config('UserPromptSubmit', '*', { command: 'echo "not allowed here" >&2; exit 2' }))
    expect((await blocked.userPrompt('rm -rf')).blocked).toBe('Blocked by hook plugin:alpha: not allowed here')
    const decided = make(config('UserPromptSubmit', '*', { command: `echo '{"decision":"block","reason":"contains a secret"}'` }))
    expect((await decided.userPrompt('x')).blocked).toBe('Blocked by hook plugin:alpha: contains a secret')
  })

  it('Stop can send the model back once, and is told when it already did', async () => {
    const engine = make(config('Stop', '*', { command: 'cat > "$CLAUDE_PROJECT_DIR/stop.json"; echo \'{"decision":"block","reason":"finish the tests"}\'' }))
    expect(await engine.stop('done', false)).toEqual({ block: 'finish the tests (from hook plugin:alpha)', notes: [] })
    await engine.stop('done again', true)
    expect(JSON.parse(readFileSync(join(root, 'stop.json'), 'utf8'))).toMatchObject({ hook_event_name: 'Stop', stop_hook_active: true, last_assistant_message: 'done again' })
    const quiet = make(config('Stop', '*', { command: 'echo fine' }))
    expect(await quiet.stop('done', false)).toEqual({ notes: [] })
  })

  it('SessionStart output is context, matched on the source', async () => {
    const engine = make({ SessionStart: [
      { matcher: 'startup', hooks: [{ type: 'command', command: 'echo "hello from startup"' }] },
      { matcher: 'resume', hooks: [{ type: 'command', command: 'echo "hello from resume"' }] },
    ] })
    expect((await engine.sessionStart('startup')).context).toBe('[hook plugin:alpha] hello from startup')
    expect((await engine.sessionStart('resume')).context).toBe('[hook plugin:alpha] hello from resume')
    expect((await engine.sessionStart('clear')).context).toBe('')
    expect(engine.has('SessionStart')).toBe(true)
    expect(engine.has('Stop')).toBe(false)
  })

  it('a slow hook is stopped at its timeout, and three failures switch a hook off', async () => {
    const slow = make(config('PreToolUse', '*', { command: 'sleep 5', timeout: 1 }))
    const started = Date.now()
    const out = await slow.beforeTool!(edit)
    expect(Date.now() - started).toBeLessThan(4_000)
    expect(out.notes).toEqual([expect.stringContaining('timed out after 1 s')])
    const broken = make(config('PreToolUse', '*', { command: 'exit 5' }))
    for (let i = 0; i < 3; i++) await broken.beforeTool!(edit)
    const fourth = await broken.beforeTool!(edit)
    expect(fourth.notes).toEqual([])
    expect(broken.definitions()[0]?.failures).toBe(3)
  })

  it('an async PostToolUse hook does not hold the result', async () => {
    const engine = make(config('PostToolUse', '*', { command: 'sleep 2; echo late', async: true }))
    const started = Date.now()
    const out = await engine.afterTool({ tool: 'edit_file' }, { ok: true, content: 'edited' }, undefined, { name: 'edit_file', args: edit.args, raw: '{}' })
    expect(Date.now() - started).toBeLessThan(1_500)
    expect(out.content).toBe('edited')
  })

  it('SessionEnd, PreCompact and the subagent events run and report only problems', async () => {
    const problems: string[] = []
    const engine = make({
      ...config('SessionEnd', '*', { command: 'echo "$CLAUDE_PROJECT_DIR" > "$CLAUDE_PROJECT_DIR/end.txt"' }),
      ...config('PreCompact', 'manual', { command: 'exit 3' }),
      ...config('SubagentStart', 'investigate', { command: 'cat > "$CLAUDE_PROJECT_DIR/sub.json"' }),
    }, { onProblem: (t) => problems.push(t) })
    await engine.sessionEnd('exit')
    expect(existsSync(join(root, 'end.txt'))).toBe(true)
    await engine.preCompact('auto')
    expect(problems).toEqual([])
    await engine.preCompact('manual')
    expect(problems).toEqual([expect.stringContaining('exited 3')])
    await engine.subagent('start', 'investigate', 'find the bug')
    expect(JSON.parse(readFileSync(join(root, 'sub.json'), 'utf8'))).toMatchObject({ hook_event_name: 'SubagentStart', agent_type: 'investigate', task: 'find the bug' })
  })
})

describe.skipIf(process.platform !== 'win32')('under PowerShell', () => {
  it('reads the same contract', async () => {
    const shell: HookShell = { kind: 'powershell' }
    const deny = make(config('PreToolUse', '*', { command: `Write-Output '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"ps says no"}}'` }), {}, shell)
    expect(await deny.beforeTool!(edit)).toMatchObject({ verdict: 'deny', reason: 'ps says no' })
    const two = make(config('PreToolUse', '*', { command: "[Console]::Error.WriteLine('nope'); exit 2" }), {}, shell)
    expect(await two.beforeTool!(edit)).toMatchObject({ verdict: 'deny', reason: 'nope' })
    const post = make(config('PostToolUse', '*', { command: 'Write-Output "PS-OK"' }), {}, shell)
    const out = await post.afterTool({ tool: 'edit_file' }, { ok: true, content: 'edited' }, undefined, { name: 'edit_file', args: edit.args, raw: '{}' })
    expect(out.content).toBe('edited\n\n[hook plugin:alpha] PS-OK')
  })
})
