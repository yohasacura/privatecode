import { afterAll, beforeEach, expect, test } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

test('a filename is an argument, never syntax: a `;` in it cannot run a second command', async () => {
  // The command comes from a settings file the model cannot write. The PATH substituted
  // into it is the model's own `args.path`, and `;` separates statements in PowerShell --
  // so text substitution made `write_file` a way to run anything, ungated, because the
  // formatter runs inside the write tool after the permission gate has already decided.
  const name = 'a;New-Item -ItemType File -Name pwned.txt;b.txt'
  writeFileSync(join(root, name), 'before', 'utf8')
  const workspace = new Workspace(root)
  const runner = createFormatRunner(
    [{ match: '*.txt', command: "Set-Content -LiteralPath $FILE -Value 'ok' -NoNewline", test: /.*\.txt$/, source: 'test' }],
    workspace,
  )

  const outcome = await runner.run(name)

  expect(existsSync(join(root, 'pwned.txt'))).toBe(false)
  // ...and the formatter still did its actual job on the real file.
  expect(outcome.ran).toBe(true)
  expect(readFileSync(join(root, name), 'utf8')).toBe('ok')
}, 30_000)

test('a space in a filename no longer breaks the command, three times over', async () => {
  // The benign half of the same bug, and the common one: an unquoted path with a space
  // split into two arguments, the formatter exited non-zero, and MAX_FAILURES then
  // switched formatting off for the rest of the session -- for every file.
  writeFileSync(join(root, 'my file.txt'), 'before', 'utf8')
  const workspace = new Workspace(root)
  const runner = createFormatRunner(
    [{ match: '*.txt', command: "Set-Content -LiteralPath $FILE -Value 'ok' -NoNewline", test: /.*\.txt$/, source: 'test' }],
    workspace,
  )

  const outcome = await runner.run('my file.txt')

  expect(outcome.note ?? '').not.toContain('exited')
  expect(readFileSync(join(root, 'my file.txt'), 'utf8')).toBe('ok')
}, 30_000)

test('the formatter runs in the folder the file is in, not the primary one', async () => {
  // `workspace.root` is mounts[0].root, while a multi-folder workspace addresses files as
  // `<mountName>/rest` -- and mounts never overlap, so that path never existed under the
  // primary root. Every edit in an attached folder used to come back "exited 1", and three
  // of them disabled the formatter for the primary folder too.
  const app = join(root, 'app')
  const engine = join(root, 'engine')
  mkdirSync(app, { recursive: true })
  mkdirSync(engine, { recursive: true })
  writeFileSync(join(engine, 'lib.txt'), 'before', 'utf8')
  const workspace = new Workspace([
    { name: 'app', root: app, access: 'write', primary: true },
    { name: 'engine', root: engine, access: 'write', primary: false },
  ])
  const runner = createFormatRunner(
    [{ match: '**/*.txt', command: "Set-Content -LiteralPath $FILE -Value 'ok' -NoNewline", test: /.*\.txt$/, source: 'test' }],
    workspace,
  )

  const outcome = await runner.run('engine/lib.txt')

  expect(outcome.note ?? '').not.toContain('exited')
  expect(outcome.ran).toBe(true)
  expect(readFileSync(join(engine, 'lib.txt'), 'utf8')).toBe('ok')
}, 30_000)

test("a rule that quotes '$FILE' still formats the file, not a file called $FILE", async () => {
  // Binding $FILE as a PowerShell variable closed the injection and quietly changed what a
  // rule may SAY: single quotes suppress expansion, so `--write '$FILE'` started running
  // against the literal string. Every write then came back "exited 1" and three of them
  // switched formatting off for the session, with nothing on screen to say so.
  writeFileSync(join(root, 'q.txt'), 'before', 'utf8')
  const workspace = new Workspace(root)
  const runner = createFormatRunner(
    [{ match: '*.txt', command: "Set-Content -LiteralPath '$FILE' -Value 'ok' -NoNewline", test: /.*\.txt$/, source: 'test' }],
    workspace,
  )

  const outcome = await runner.run('q.txt')

  expect(outcome.note ?? '').not.toContain('exited')
  expect(readFileSync(join(root, 'q.txt'), 'utf8')).toBe('ok')
}, 30_000)

test('and the double-quoted form keeps working too', async () => {
  writeFileSync(join(root, 'd.txt'), 'before', 'utf8')
  const workspace = new Workspace(root)
  const runner = createFormatRunner(
    [{ match: '*.txt', command: 'Set-Content -LiteralPath "$FILE" -Value \'ok\' -NoNewline', test: /.*\.txt$/, source: 'test' }],
    workspace,
  )
  const outcome = await runner.run('d.txt')
  expect(outcome.note ?? '').not.toContain('exited')
  expect(readFileSync(join(root, 'd.txt'), 'utf8')).toBe('ok')
}, 30_000)

test('a $FILE glued to another character is refused at load, by name', () => {
  // PowerShell reads `$FILE.bak` as a property access and `$FILEX` as a different variable;
  // both expand to nothing. There is no safe rewrite, so the rule is refused where the
  // message can still name it rather than failing silently on every edit.
  writeSettings({ format: [{ match: '**/*.ts', command: 'npx prettier --write $FILE.bak' }] })
  const { rules, problems } = loadFormatRules(root, noUserSettings())
  expect(rules).toEqual([])
  expect(problems[0]).toContain('${FILE}')
})

test('${FILE} is accepted, since PowerShell expands it unambiguously', () => {
  writeSettings({ format: [{ match: '**/*.ts', command: 'npx prettier --write ${FILE}' }] })
  const { rules, problems } = loadFormatRules(root, noUserSettings())
  expect(problems).toEqual([])
  expect(rules).toHaveLength(1)
})

test('a formatter that rewrites the file AND exits non-zero still yields the post-format diff', async () => {
  // A fixer-linter with one finding it cannot fix does exactly this. The failure path used
  // to return `text: null, changed: false`, so edit_file kept its pre-format bytes and
  // rendered a diff of text no longer on disk — breaking the anchoring property that is the
  // entire reason formatting lives inside the write tool.
  writeFileSync(join(root, 'f.txt'), 'hello\nworld\n', 'utf8')
  const workspace = new Workspace(root)
  const runner = createFormatRunner(
    [{
      match: '*.txt',
      // Rewrites the file, then reports it still has a problem.
      command: "Set-Content -LiteralPath $FILE -Value 'FORMATTED' -NoNewline; exit 3",
      test: /.*\.txt$/,
      source: 'test',
    }],
    workspace,
  )

  const outcome = await runner.run('f.txt')

  expect(outcome.ran).toBe(true)
  expect(outcome.changed).toBe(true)
  expect(outcome.text).toBe('FORMATTED')
  expect(outcome.note).toContain('exited 3')
}, 30_000)

test('a formatter that legitimately reports problems is not switched off by a later success', async () => {
  // MAX_FAILURES exists so a BROKEN command costs a few seconds once. A linter that exits
  // non-zero on a red file is not broken, and counting those cumulatively disabled
  // formatting for the whole session after the third one.
  writeFileSync(join(root, 'g.txt'), 'x', 'utf8')
  const workspace = new Workspace(root)
  let call = 0
  const rules = [{
    match: '*.txt',
    // Fails, fails, succeeds, then fails twice more: cumulative counting would have hit the
    // cap; consecutive counting has not.
    command: 'if ($env:PC_FMT_FAIL -eq "1") { exit 2 } else { exit 0 }',
    test: /.*\.txt$/,
    source: 'test',
  }]
  const runner = createFormatRunner(rules, workspace)

  const run = async (fail: boolean) => {
    process.env['PC_FMT_FAIL'] = fail ? '1' : '0'
    call++
    return runner.run('g.txt')
  }
  await run(true)
  await run(true)
  await run(false)
  await run(true)
  const last = await run(true)
  delete process.env['PC_FMT_FAIL']

  // Still running after five calls, three of which exited non-zero.
  expect(call).toBe(5)
  expect(last.ran).toBe(true)
  expect(last.note).toContain('exited 2')
  expect(last.note).not.toContain('will not be run again')
}, 60_000)
