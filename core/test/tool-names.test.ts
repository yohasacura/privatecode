import { describe, expect, test } from 'vitest'
import { LEGACY_TOOL_NAMES, parseRule } from '../src/permissions/rules.js'
import { BUILT_IN_TOOL_NAMES, CLAUDE_CODE_OLD_NAMES, EDITING_TOOL_NAMES, READ_ONLY_TOOL_NAMES } from '../src/tools/built-in-names.js'
import { buildRegistry } from '../src/tools/default-set.js'

/**
 * The tools carry Claude Code's names, all of them — and every name they carried before
 * still resolves, so a rule in a settings file written last week and a session recorded
 * last week mean today what they meant then.
 */

const registered = new Set(buildRegistry().schemas().map((s) => s.function.name))

describe('the names the model sees', () => {
  test('are all PascalCase now — no snake_case, no lowercase, Claude Code style', () => {
    for (const name of registered) {
      expect(name, name).toMatch(/^[A-Z][A-Za-z]*$/)
    }
    expect([...registered].sort()).toEqual([
      'Agent', 'AskUserQuestion', 'Bash', 'Browser', 'CSharpNav', 'Database', 'DeleteFile', 'Edit', 'GitStatus', 'Glob',
      'Grep', 'LS', 'MoveFile', 'Plugin', 'Read', 'Recall', 'Remember', 'Sessions', 'Skill', 'SqlDeploy', 'SymbolOutline',
      'TaskOutput', 'TaskStop', 'TodoWrite', 'WebFetch', 'WebSearch', 'Write',
    ])
  })

  test('the read-only and editing families name only live tools, and never the same one', () => {
    for (const name of READ_ONLY_TOOL_NAMES) expect(registered.has(name), name).toBe(true)
    for (const name of EDITING_TOOL_NAMES) expect(registered.has(name), name).toBe(true)
    for (const name of READ_ONLY_TOOL_NAMES) expect(EDITING_TOOL_NAMES.has(name), name).toBe(false)
  })

  test("Claude Code's own retired names point at live tools", () => {
    expect(CLAUDE_CODE_OLD_NAMES).toEqual({ Task: 'Agent', MultiEdit: 'Edit', BashOutput: 'TaskOutput', KillShell: 'TaskStop', KillBash: 'TaskStop' })
    for (const to of Object.values(CLAUDE_CODE_OLD_NAMES)) expect(registered.has(to), to).toBe(true)
  })
})

describe('the names they had before', () => {
  test('are retired — reserved so a plugin cannot take them — and each maps to a live tool', () => {
    for (const [old, now] of Object.entries(LEGACY_TOOL_NAMES)) {
      expect(BUILT_IN_TOOL_NAMES.has(old), `${old} is reserved`).toBe(true)
      expect(registered.has(old), `${old} is not offered`).toBe(false)
      expect(registered.has(now), `${old} -> ${now}`).toBe(true)
    }
  })

  test('a permission rule written with an old name binds to the tool it became', () => {
    expect(parseRule('list_dir')?.tool).toBe('LS')
    expect(parseRule('delete_file(src/**)')?.tool).toBe('DeleteFile')
    expect(parseRule('background_task')?.tool).toBe('TaskOutput')
    expect(parseRule('browser(http://localhost:5173:*)')?.tool).toBe('Browser')
    expect(parseRule('sql_deploy(script)')?.tool).toBe('SqlDeploy')
    expect(parseRule('plugins')?.tool).toBe('Plugin')
    expect(parseRule('remember')?.tool).toBe('Remember')
    // And a rule written with the new name is itself.
    expect(parseRule('TaskStop')?.tool).toBe('TaskStop')
    expect(parseRule('LS')?.tool).toBe('LS')
  })
})
