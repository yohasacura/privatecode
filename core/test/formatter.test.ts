import { afterAll, beforeEach, expect, test } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadFormatRules, ruleFor } from '../src/format/config.js'
import { createFormatRunner } from '../src/format/runner.js'
import { editFileTool } from '../src/tools/edit-file.js'
import { Workspace } from '../src/workspace.js'

/**
 * The auto-formatter. The one property worth the most tests is the reason it lives inside
 * the write tool at all: the diff `edit_file` returns must describe the file AFTER
 * formatting, because the model anchors its next SEARCH block on exactly that text.
 */

let root: string
const made: string[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-fmt-'))
  made.push(root)
  mkdirSync(join(root, '.privatecode'), { recursive: true })
})

afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})

function writeSettings(obj: unknown): void {
  writeFileSync(join(root, '.privatecode', 'settings.json'), JSON.stringify(obj, null, 2))
}

const noUserSettings = (): string => join(root, 'no-such-user-settings.json')

test('a workspace with no format key configures nothing', () => {
  writeSettings({ permissions: { allow: [], ask: [], deny: [] } })
  expect(loadFormatRules(root, noUserSettings())).toEqual({ rules: [], problems: [] })
})

test('a command that never mentions $FILE is refused, not run against the whole tree', () => {
  writeSettings({ format: [{ match: '**/*.ts', command: 'npx prettier --write .' }] })
  const { rules, problems } = loadFormatRules(root, noUserSettings())
  expect(rules).toEqual([])
  expect(problems[0]).toContain('$FILE')
})

test('the last matching rule wins, so local overrides project', () => {
  const rules = [
    { match: '**/*.ts', command: 'a $FILE', test: /.*\.ts$/, source: 'project' },
    { match: 'src/**/*.ts', command: 'b $FILE', test: /^src\/.*\.ts$/, source: 'local' },
  ]
  expect(ruleFor(rules, 'src/app.ts')?.command).toBe('b $FILE')
  expect(ruleFor(rules, 'other/app.ts')?.command).toBe('a $FILE')
  expect(ruleFor(rules, 'readme.md')).toBeNull()
})

test('edit_file renders its diff against the POST-format file', async () => {
  // This is the whole reason formatting is inside the tool. The formatter here uppercases
  // the file; if the diff were rendered before it ran, the model would be shown lowercase
  // text that is no longer on disk, and its next SEARCH anchor would miss.
  writeFileSync(join(root, 'a.txt'), 'hello\nworld\n')
  const workspace = new Workspace(root)
  const rules = [{
    match: '*.txt',
    command: '$FILE',
    test: /.*\.txt$/,
    source: 'test',
  }]
  // A stand-in for a real formatter: rewrites the file in place, uppercased.
  const runner = {
    async run(relativePath: string) {
      const abs = workspace.resolve(relativePath)
      const before = readFileSync(abs, 'utf8')
      const after = before.toUpperCase()
      writeFileSync(abs, after)
      return { ran: true, changed: after !== before, text: after, note: 'the project formatter reformatted this file; the diff below is the result' }
    },
  }
  void rules

  const result = await editFileTool.execute(
    { path: 'a.txt', search_text: 'world', replace_text: 'there' },
    { workspace, format: runner },
  )

  expect(result.ok).toBe(true)
  // The diff shows what is actually on disk now...
  expect(result.content).toContain('+HELLO')
  expect(result.content).toContain('+THERE')
  // ...and says why it does not look like what was asked for.
  expect(result.content).toContain('the project formatter reformatted this file')
  expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('HELLO\nTHERE\n')
})

test('a formatter that fails names the failure instead of swallowing it', async () => {
  writeFileSync(join(root, 'b.txt'), 'one\ntwo\n')
  const workspace = new Workspace(root)
  const runner = createFormatRunner(
    [{ match: '*.txt', command: 'exit 3 # $FILE', test: /.*\.txt$/, source: 'test' }],
    workspace,
  )
  const result = await editFileTool.execute(
    { path: 'b.txt', search_text: 'two', replace_text: 'three' },
    { workspace, format: runner },
  )
  // The edit still applied -- a broken formatter must not lose the user's change.
  expect(result.ok).toBe(true)
  expect(readFileSync(join(root, 'b.txt'), 'utf8')).toContain('three')
  // But the model is told, because a formatter rejecting the file usually means the edit
  // produced something that does not parse.
  expect(result.content).toContain('formatter')
})

test('with no formatter configured, edit_file behaves exactly as before', async () => {
  writeFileSync(join(root, 'c.txt'), 'alpha\nbeta\n')
  const workspace = new Workspace(root)
  const result = await editFileTool.execute(
    { path: 'c.txt', search_text: 'beta', replace_text: 'gamma' },
    { workspace },
  )
  expect(result.ok).toBe(true)
  expect(result.content).toContain('+gamma')
  expect(result.content).not.toContain('formatter')
})
