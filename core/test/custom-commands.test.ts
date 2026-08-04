import { afterAll, beforeEach, expect, test } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expandCommand, listCommands } from '../src/commands/custom.js'

/**
 * Custom slash commands. A command is DATA, never behaviour: expansion produces text that
 * goes through the same turn as anything typed by hand, so the tests care about what the
 * expansion says and about refusing anything that could shadow a built-in.
 */

let root: string
let dir: string
const made: string[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-cmd-'))
  made.push(root)
  dir = join(root, '.privatecode', 'commands')
  mkdirSync(dir, { recursive: true })
})

afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})

test('a workspace with no commands directory is silent, not a problem', () => {
  const bare = mkdtempSync(join(tmpdir(), 'pc-cmd-none-'))
  made.push(bare)
  expect(listCommands(bare)).toEqual({ commands: [], problems: [] })
})

test('$ARGUMENTS is substituted everywhere it appears', () => {
  writeFileSync(join(dir, 'review.md'), 'Review $ARGUMENTS carefully. Focus on $ARGUMENTS only.')
  const out = expandCommand(root, '/review src/auth.ts')
  expect(out?.text).toBe('Review src/auth.ts carefully. Focus on src/auth.ts only.')
})

test('a template without the placeholder still receives the arguments', () => {
  // Otherwise typing arguments would silently do nothing, which is worse than appending.
  writeFileSync(join(dir, 'audit.md'), 'Audit this project for unused exports.')
  expect(expandCommand(root, '/audit src/')?.text)
    .toBe('Audit this project for unused exports.\n\nsrc/')
  expect(expandCommand(root, '/audit')?.text).toBe('Audit this project for unused exports.')
})

test('an unknown /name expands to nothing, so it is sent as ordinary text', () => {
  // Most lines starting with `/` are a path. Refusing them would be worse than sending
  // them, and the model can read `/etc/hosts` as a subject just fine.
  expect(expandCommand(root, '/nope')).toBeNull()
  expect(expandCommand(root, '/usr/local/bin')).toBeNull()
  expect(expandCommand(root, 'not a command at all')).toBeNull()
})

test('a file named after a built-in is refused rather than silently shadowed', () => {
  writeFileSync(join(dir, 'compact.md'), 'this could never run')
  const { commands, problems } = listCommands(root)
  expect(commands).toEqual([])
  expect(problems[0]).toContain('built-in')
})

test('an oversized or empty template is refused with a reason', () => {
  writeFileSync(join(dir, 'huge.md'), 'x'.repeat(9000))
  writeFileSync(join(dir, 'blank.md'), '   \n  ')
  const { commands, problems } = listCommands(root)
  expect(commands).toEqual([])
  expect(problems.join(' ')).toContain('over the 8000')
  expect(problems.join(' ')).toContain('empty')
})

test('the description comes from the first heading, for a menu', () => {
  writeFileSync(join(dir, 'ship.md'), '# Run the release checks\n\nDo the following...')
  expect(listCommands(root).commands[0]?.description).toBe('Run the release checks')
})

test('a name with characters that would not survive being typed is refused', () => {
  writeFileSync(join(dir, 'My Command.md'), 'x')
  const { commands, problems } = listCommands(root)
  expect(commands).toEqual([])
  expect(problems[0]).toContain('lowercase letters, digits and dashes')
})
