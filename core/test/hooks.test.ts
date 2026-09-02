import { afterAll, beforeEach, expect, test } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHookRunner, loadHooks } from '../src/hooks/hooks.js'
import { Workspace } from '../src/workspace.js'

/**
 * After-tool hooks. A hook OBSERVES: the tool has already run by the time one fires, so
 * these check that its output reaches the model and that a broken one degrades quietly
 * rather than costing something on every call.
 */

let root: string
const made: string[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-hook-'))
  made.push(root)
  mkdirSync(join(root, '.privatecode'), { recursive: true })
})

afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }) })

const noUser = (): string => join(root, 'no-user-settings.json')

function writeSettings(obj: unknown): void {
  writeFileSync(join(root, '.privatecode', 'settings.json'), JSON.stringify(obj))
}

test('hooks reuse the permission rule syntax, introducing none of their own', () => {
  writeSettings({ hooks: [{ after: 'Edit(src/**)', command: 'echo hi' }] })
  const { hooks, problems } = loadHooks(root, noUser())
  expect(problems).toEqual([])
  expect(hooks).toHaveLength(1)
  // The same parser the allow/deny lists use, so `Edit(src/**)` means one thing here.
  expect(hooks[0]?.rule.tool).toBe('Edit')
})

test('an unparseable trigger is reported and skipped, not guessed at', () => {
  writeSettings({ hooks: [{ after: '((((', command: 'echo hi' }, { after: 'Read', command: '' }] })
  const { hooks, problems } = loadHooks(root, noUser())
  expect(hooks).toEqual([])
  expect(problems).toHaveLength(2)
})

test('a matching hook appends its output to what the model sees', async () => {
  const runner = createHookRunner(loadHooksFor('Edit(src/**)', 'echo LINT-OK'), new Workspace(root))
  const out = await runner.afterTool(
    { tool: 'Edit', paths: ['src/app.ts'] },
    { ok: true, content: 'the diff' },
  )
  expect(out.content).toContain('the diff')
  expect(out.content).toContain('LINT-OK')
})

test('a hook whose trigger does not match leaves the result untouched', async () => {
  const runner = createHookRunner(loadHooksFor('Edit(src/**)', 'echo NOPE'), new Workspace(root))
  const original = { ok: true, content: 'the diff' }
  const out = await runner.afterTool({ tool: 'Edit', paths: ['docs/readme.md'] }, original)
  expect(out).toBe(original)
})

test('a failing hook is reported once per call and gives up after three', async () => {
  const runner = createHookRunner(loadHooksFor('Read', 'exit 9'), new Workspace(root))
  const call = async () => runner.afterTool({ tool: 'Read', paths: ['a.ts'] }, { ok: true, content: 'x' })
  expect((await call()).content).toContain('exited 9')
  await call()
  await call()
  // Circuit breaker: a broken command costs time three times, not on every tool call.
  expect((await call()).content).toBe('x')
})

function loadHooksFor(after: string, command: string) {
  writeSettings({ hooks: [{ after, command }] })
  return loadHooks(root, noUser()).hooks
}
