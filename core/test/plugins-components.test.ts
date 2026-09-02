import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  addMarketplace, installPlugin, loadPluginComponents, mergeServers, parseAgentMarkdown, PluginStore, readToolList,
  substitutePluginVars, type PluginComponents,
} from '../src/plugins/index.js'
import { matcherCovers } from '../src/hooks/engine.js'
import { loadSkills } from '../src/skills/skills.js'
import { expandCommand, listCommands, substituteArguments } from '../src/commands/custom.js'
import { createDelegateTool } from '../src/tools/delegate.js'
import { ROLES } from '../src/agent/subagent.js'
import { writeMarketplace } from './plugins-fixture.js'

let tmp: string
let ws: string
let store: PluginStore
let userPath: string
let userSkills: string
let comps: PluginComponents

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'pc-plugins-comp-'))
  ws = join(tmp, 'ws')
  mkdirSync(ws, { recursive: true })
  userPath = join(tmp, 'user', 'settings.json')
  userSkills = join(tmp, 'user', 'skills')
  store = new PluginStore(join(tmp, 'store'))
  const mkt = join(tmp, 'mkt')
  writeMarketplace(mkt, 'fixture-market')
  const alpha = join(mkt, 'plugins', 'alpha')
  mkdirSync(join(alpha, 'bin'), { recursive: true })
  writeFileSync(join(alpha, 'bin', 'hello.cmd'), '@echo hello\n')
  writeFileSync(join(alpha, '.mcp.json'), JSON.stringify({
    mcpServers: { memory: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.js'], env: { TOKEN: '${FIXTURE_TOKEN_UNSET:-none}' } } },
  }))
  writeFileSync(join(alpha, 'agents', 'reviewer.md'), [
    '---', 'name: reviewer', 'description: Reviews code for defects', 'tools: Read, Grep, Bash(git *), Task, NotebookEdit',
    'permissionMode: plan', 'maxTurns: 6', 'model: opus', '---', 'You review carefully.', '',
  ].join('\n'))
  writeFileSync(join(alpha, 'commands', 'status.md'), '---\ndescription: Repo status\n---\nCurrent status: !`git status`\nThen $1 and $2.\n')
  mkdirSync(join(alpha, 'skills', 'hidden'), { recursive: true })
  writeFileSync(join(alpha, 'skills', 'hidden', 'SKILL.md'), '---\nname: hidden\ndescription: For people only\ndisable-model-invocation: true\n---\nSecret steps.\n')
  const added = await addMarketplace(store, mkt, { userPath })
  if ('error' in added) throw new Error(added.error)
  for (const id of ['alpha@fixture-market', 'beta@fixture-market', 'gamma@fixture-market']) {
    const r = await installPlugin(store, id, { userPath })
    if ('error' in r) throw new Error(r.error)
  }
  comps = loadPluginComponents(store, ws, { userPath })
})
afterAll(() => {
  try { rmSync(tmp, { recursive: true, force: true }) } catch { /* a handle still open on Windows */ }
})

describe('what enabled plugins contribute', () => {
  it('loads the enabled plugins and skips the disabled one', () => {
    expect(comps.plugins.map((p) => p.id)).toEqual(['alpha@fixture-market', 'beta@fixture-market'])
    expect(comps.problems.filter((p) => p.includes('gamma'))).toEqual([])
  })

  it('names skills plugin:skill, and a single-skill plugin after itself', () => {
    const loaded = loadSkills(ws, userSkills, comps.skillSources)
    expect(loaded.skills.map((s) => s.name)).toEqual(['alpha:greet', 'alpha:hidden', 'beta'])
    expect(loaded.skills.find((s) => s.name === 'beta')?.plugin).toBe('beta')
    expect(loaded.skills.find((s) => s.name === 'alpha:greet')?.scope).toBe('plugin')
    expect(loaded.catalogue).toContain('alpha:greet')
    // `disable-model-invocation: true` keeps it out of the prompt, not out of the list.
    expect(loaded.catalogue).not.toContain('alpha:hidden')
    expect(loaded.skills.find((s) => s.name === 'alpha:hidden')?.modelInvocable).toBe(false)
  })

  it('makes commands of commands/ files, namespaced, and of skills', () => {
    const { commands, problems } = listCommands(ws, comps.commandSources)
    expect(commands.map((c) => c.name)).toEqual(['alpha:greet', 'alpha:hello', 'alpha:hidden', 'alpha:review:security', 'alpha:status', 'beta'])
    expect(problems).toEqual([])
    const hello = commands.find((c) => c.name === 'alpha:hello')
    expect(hello?.description).toBe('Greets')
    expect(hello?.argumentHint).toBe('[name]')
    expect(hello?.template).toBe('Hello $ARGUMENTS')
    expect(expandCommand(ws, '/alpha:hello Bob', comps.commandSources)).toEqual({ name: 'alpha:hello', text: 'Hello Bob' })
    expect(expandCommand(ws, '/beta', comps.commandSources)?.text).toContain('# beta')
    expect(expandCommand(ws, '/alpha:nothing', comps.commandSources)).toBeNull()
  })

  it('substitutes positional arguments and never runs a shell line', () => {
    const status = expandCommand(ws, '/alpha:status one two', comps.commandSources)
    expect(status?.text).toContain('`git status` (not run: PrivateCode does not execute commands from a template)')
    expect(status?.text).toContain('Then one and two.')
    expect(substituteArguments('Fix $1 in $2', 'bug src/x.ts')).toBe('Fix bug in src/x.ts')
    expect(substituteArguments('No placeholder', 'extra words')).toBe('No placeholder\n\nextra words')
    expect(substituteArguments('All: $ARGUMENTS', 'a b')).toBe('All: a b')
    expect(substituteArguments('Only $1', '')).toBe('Only ')
  })

  it("reads an agent as an Agent role the tool can name — the tools' names are Claude Code's, taken as written", () => {
    const reviewer = comps.agents.find((r) => r.name === 'alpha:reviewer')
    expect(reviewer).toBeDefined()
    expect(reviewer?.purpose).toBe('Reviews code for defects')
    expect(reviewer?.brief).toBe('You review carefully.')
    expect(reviewer?.tools).toEqual(['Read', 'Grep', 'Bash', 'Agent'])
    expect(reviewer?.mode).toBe('plan')
    expect(reviewer?.maxSteps).toBe(6)
    expect(comps.problems).toEqual(expect.arrayContaining([
      expect.stringContaining('the pattern in "Bash(git *)" is not applied'),
      expect.stringContaining('"NotebookEdit" is not a tool PrivateCode has'),
      expect.stringContaining('model is not acted on'),
    ]))
    const tool = createDelegateTool([...ROLES, ...comps.agents])
    const schema = tool.parameters['properties'] as Record<string, { enum: string[] }>
    expect(schema['role']!.enum).toEqual(['investigate', 'critique', 'work', 'alpha:reviewer'])
    expect(tool.validate({ role: 'alpha:reviewer', task: 'Review src/index.ts for null handling defects' })).toMatchObject({ ok: true })
    expect(tool.validate({ role: 'nobody', task: 'Review src/index.ts for null handling defects' })).toMatchObject({ ok: false })
  })

  it('registers MCP servers as plugin:<plugin>:<server> with ${CLAUDE_PLUGIN_ROOT} substituted', () => {
    expect(comps.mcpServers.map((s) => s.name)).toEqual(['plugin:alpha:memory'])
    const memory = comps.mcpServers[0]!
    const root = comps.plugins.find((p) => p.name === 'alpha')!.root
    expect(memory.spec.kind).toBe('stdio')
    if (memory.spec.kind === 'stdio') {
      expect(memory.spec.args).toEqual([`${root}/server.js`])
      expect(memory.spec.env?.['TOKEN']).toBe('none')
      expect(memory.spec.env?.['CLAUDE_PLUGIN_ROOT']).toBe(root)
    }
    expect(mergeServers(comps.mcpServers, [{ name: 'plugin:alpha:memory', spec: { kind: 'stdio', command: 'ours' }, source: 'ours', trustReadOnlyHints: false }]).map((s) => s.source)).toEqual(['ours'])
  })

  it('collects hooks and bin/ for the engine and PATH', () => {
    expect(comps.hookSources.map((h) => h.owner)).toEqual(['plugin:alpha'])
    expect(Object.keys(comps.hookSources[0]!.config)).toEqual(['PreToolUse'])
    expect(comps.hookSources[0]!.root).toBe(comps.plugins[0]!.root)
    expect(comps.binDirs).toEqual([join(comps.plugins[0]!.root, 'bin')])
  })

  it('substitutes the three plugin variables', () => {
    expect(substitutePluginVars('${CLAUDE_PLUGIN_ROOT}/x ${CLAUDE_PLUGIN_DATA} ${CLAUDE_PROJECT_DIR}', { root: 'R', data: 'D', project: 'P' })).toBe('R/x D P')
  })
})

describe('tool names, as Claude Code writes them', () => {
  it('a tools: line is taken as written; the three names Claude Code retired are read as what they became', () => {
    const problems: string[] = []
    expect(readToolList('Read, Write, Task, MultiEdit, LS, mcp__github__issues, NotebookEdit, Frobnicate', 'x', problems))
      .toEqual(['Read', 'Write', 'Agent', 'Edit', 'list_dir', 'mcp__github__issues'])
    expect(problems).toEqual([expect.stringContaining('"NotebookEdit"'), expect.stringContaining('"Frobnicate"')])
    expect(readToolList('["Bash", "Grep"]', 'x', [])).toEqual(['Bash', 'Grep'])
  })

  it('a hook matcher names the tool itself', () => {
    expect(matcherCovers('Edit|Write', 'Edit')).toBe(true)
    expect(matcherCovers('Edit|Write', 'Read')).toBe(false)
    expect(matcherCovers('*', 'anything')).toBe(true)
    expect(matcherCovers(undefined, 'anything')).toBe(true)
    expect(matcherCovers('^(Read|Grep)$', 'Grep')).toBe(true)
    expect(matcherCovers('Task', 'Agent')).toBe(true)
    expect(matcherCovers('Bash', 'background_task')).toBe(false)
    expect(matcherCovers('mcp__.*', 'mcp__github__issues')).toBe(true)
  })
})

describe('agent files', () => {
  it('maps permission modes, reads limits, and says what it ignores', () => {
    const problems: string[] = []
    const role = parseAgentMarkdown('---\ndescription: X\npermissionMode: bypassPermissions\nmaxTurns: 99\ndisallowedTools: Write, Edit\ncolor: red\n---\nDo X.\n', 'x', 'p', 'p/x.md', problems)
    expect(role).toMatchObject({ name: 'p:x', mode: 'autopilot', maxSteps: 40, disallowedTools: ['Write', 'Edit'] })
    expect(problems).toEqual([expect.stringContaining('color is not acted on')])
    const bare = parseAgentMarkdown('# Just a heading\nBody.\n', 'bare', null, 'bare.md', problems)
    expect(bare).toMatchObject({ name: 'bare', purpose: 'Just a heading', maxSteps: 12 })
    expect(parseAgentMarkdown('---\ndescription: Bad\n---\n', 'Bad Name', null, 'x', problems)).toBeNull()
  })
})
