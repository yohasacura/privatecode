import { expect, test } from 'vitest'
import { PermissionEngine } from '../src/permissions/engine.js'

/**
 * A turn built in one mode meeting an engine that was switched to `plan` underneath it.
 *
 * `Agent` resolves its mode ONCE, in its constructor, and only then narrows
 * `allowedTools`; `PermissionEngine.mode` is a mutable field re-read on every `decide()`.
 * `Session.setMode` mutates it with no in-flight guard, and the desktop app leaves the
 * mode chips live during a turn. So a turn started in `normal` — `allowedTools` undefined,
 * which makes the loop's own refusal inert — could have `plan` applied to it mid-flight
 * and then meet a `modeDefault` that answered `allow` for everything.
 *
 * Clicking the mode labelled "Read-only. Investigates and proposes, changes nothing" made
 * the agent strictly MORE permissive than the `normal` it replaced: every remaining edit,
 * delete, move and shell command in that turn ran with no approval card at all.
 */
const root = 'C:\ws'

test('plan mode denies writes and commands even when the Agent was built in another mode', () => {
  const engine = new PermissionEngine({ layers: [], mode: 'normal', workspaceRoot: root })
  // Exactly what Session.setMode does mid-turn: mutate the live engine.
  engine.mode = 'plan'

  for (const tool of ['write_file', 'edit_file', 'delete_file', 'move_file']) {
    const d = engine.decide({ tool, paths: ['src/app.ts'] })
    expect(d.verdict, `${tool} must not be auto-allowed by plan mode`).toBe('deny')
  }
  for (const tool of ['run_command', 'background_task']) {
    const d = engine.decide({ tool, command: 'npm test' })
    expect(d.verdict, `${tool} must not be auto-allowed by plan mode`).toBe('deny')
  }
})

test('plan mode still allows read-only tools, and background_task control ops', () => {
  const engine = new PermissionEngine({ layers: [], mode: 'plan', workspaceRoot: root })
  expect(engine.decide({ tool: 'read_file', paths: ['a.ts'] }).verdict).toBe('allow')
  expect(engine.decide({ tool: 'search_code' }).verdict).toBe('allow')
  // Keyless EXEC key = poll/stop on a process whose start was already approved. It
  // short-circuits before the mode switch and must stay allowed.
  expect(engine.decide({ tool: 'background_task' }).verdict).toBe('allow')
})

test('normal mode still asks rather than denying, so the fix did not widen the deny tier', () => {
  const engine = new PermissionEngine({ layers: [], mode: 'normal', workspaceRoot: root })
  expect(engine.decide({ tool: 'write_file', paths: ['a.ts'] }).verdict).toBe('ask')
  expect(engine.decide({ tool: 'run_command', command: 'npm test' }).verdict).toBe('ask')
})

/**
 * `.privatecode/` holds the settings this run's own permission rules were loaded from,
 * plus its saved sessions and (soon) its hooks. A model able to write there could grant
 * itself permissions. It sits above the rule layers so no rule can unwrite it; reading
 * stays allowed, because the model is deliberately told to read back its own output logs.
 */
test('writes under .privatecode are denied in every mode', () => {
  for (const mode of ['normal', 'auto-edit', 'autopilot', 'plan'] as const) {
    const engine = new PermissionEngine({ layers: [], mode, workspaceRoot: root })
    // String.raw for the Windows separator: this is the spelling the tools actually
    // receive on this platform, and it must be caught as surely as the forward-slash one.
    for (const p of ['.privatecode/settings.json', '.privatecode', String.raw`.PrivateCode\hooks.json`,
                     'a/../.privatecode/settings.json']) {
      const d = engine.decide({ tool: 'write_file', paths: [p] })
      expect(d.verdict, `${mode}: ${p}`).toBe('deny')
      expect(d.source, `${mode}: ${p}`).toBe('builtin')
    }
  }
})

test('reading inside .privatecode stays allowed', () => {
  const engine = new PermissionEngine({ layers: [], mode: 'normal', workspaceRoot: root })
  expect(engine.decide({ tool: 'read_file', paths: ['.privatecode/state/logs/run.log'] }).verdict).toBe('allow')
})

test('a path that merely starts with the same letters is untouched', () => {
  const engine = new PermissionEngine({ layers: [], mode: 'auto-edit', workspaceRoot: root })
  expect(engine.decide({ tool: 'write_file', paths: ['privatecode.md'] }).verdict).toBe('allow')
  expect(engine.decide({ tool: 'write_file', paths: ['src/.privatecoded/a.ts'] }).verdict).toBe('allow')
})
