import { describe, expect, test } from 'vitest'
import { PermissionEngine, isExternalTool } from '../src/permissions/engine.js'
import { ruleMatches, parseRule, suggestRules } from '../src/permissions/rules.js'
import type { PermissionKey } from '../src/tools/types.js'

/**
 * The third permission family.
 *
 * `modeDefault` knew exactly two grantable acts — writing files and running commands — and
 * everything else fell through to `allow`. That was fine while every tool in the process
 * was one of the fourteen built-ins, all of them jailed to the workspace. It stops being
 * fine the moment a tool can be contributed by a third-party MCP server or can drive a
 * browser at an arbitrary origin: those are the LEAST trustworthy tools in the process and
 * they would have been the ONLY ungated ones. `docs/DESIGN.md` §6 recorded this as the
 * reason MCP was cut; these tests are what let it back in.
 */

const root = 'C:\\ws'
const engineIn = (mode: 'normal' | 'plan' | 'auto-edit' | 'autopilot') =>
  new PermissionEngine({ layers: [], mode, workspaceRoot: root })

const BROWSER: PermissionKey = { tool: 'browser', target: 'https://example.dev/app' }
const MCP: PermissionKey = { tool: 'mcp__github__create_issue' }

describe('the external family is gated, not auto-allowed', () => {
  test('normal mode asks for a browser call and for an MCP tool', () => {
    const engine = engineIn('normal')
    expect(engine.decide(BROWSER).verdict).toBe('ask')
    expect(engine.decide(MCP).verdict).toBe('ask')
  })

  test('auto-edit auto-approves edits, not reaching outside the machine', () => {
    const engine = engineIn('auto-edit')
    expect(engine.decide({ tool: 'edit_file', paths: ['a.ts'] }).verdict).toBe('allow')
    expect(engine.decide(BROWSER).verdict).toBe('ask')
    expect(engine.decide(MCP).verdict).toBe('ask')
  })

  test('autopilot allows them, which is what autopilot means', () => {
    const engine = engineIn('autopilot')
    expect(engine.decide(BROWSER).verdict).toBe('allow')
    expect(engine.decide(MCP).verdict).toBe('allow')
  })

  test('plan mode denies them even when the engine was switched mid-turn', () => {
    // Same desync plan-mode-desync.test.ts covers for writes and commands: the Agent
    // resolved its tool list in another mode, so `allowedTools` never narrowed.
    const engine = engineIn('normal')
    engine.mode = 'plan'
    expect(engine.decide(BROWSER).verdict).toBe('deny')
    expect(engine.decide(MCP).verdict).toBe('deny')
  })

  test('the predicate covers the browser and the mcp namespace, and nothing else', () => {
    expect(isExternalTool('browser')).toBe(true)
    expect(isExternalTool('mcp__github__create_issue')).toBe(true)
    expect(isExternalTool('read_file')).toBe(false)
    expect(isExternalTool('run_command')).toBe(false)
    // Near-misses: a built-in whose name merely starts the same way is not external.
    expect(isExternalTool('browser_history_reader')).toBe(false)
    expect(isExternalTool('mcp_thing')).toBe(false)
  })
})

describe('rules for the external family', () => {
  const matches = (rule: string, key: PermissionKey): boolean => {
    const parsed = parseRule(rule)
    expect(parsed, `"${rule}" must parse`).not.toBeNull()
    return ruleMatches(parsed!, key)
  }

  test('a target rule matches exactly', () => {
    expect(matches('browser(https://example.dev/app)', BROWSER)).toBe(true)
    expect(matches('browser(https://example.dev/other)', BROWSER)).toBe(false)
  })

  test('a :* target rule matches everything under the prefix, with a boundary', () => {
    expect(matches('browser(http://localhost:5173:*)',
      { tool: 'browser', target: 'http://localhost:5173' })).toBe(true)
    expect(matches('browser(http://localhost:5173:*)',
      { tool: 'browser', target: 'http://localhost:5173/admin' })).toBe(true)
    // The boundary that keeps `:*` from being a bare substring test: port 51730 is a
    // different server, and a rule for 5173 must not authorize it.
    expect(matches('browser(http://localhost:5173:*)',
      { tool: 'browser', target: 'http://localhost:51730/' })).toBe(false)
  })

  test('a host rule never reaches a different host that starts the same way', () => {
    // The over-grant that would actually matter, and the reason the boundary exists.
    expect(matches('browser(https://example.dev:*)',
      { tool: 'browser', target: 'https://example.dev.evil.com/x' })).toBe(false)
    expect(matches('browser(http://localhost:*)',
      { tool: 'browser', target: 'http://localhostevil.com/x' })).toBe(false)
  })

  test('a host rule does cover that host\'s other ports, which is what makes it writable', () => {
    // `:*` consumes a colon, so `http://localhost:*` has the prefix `http://localhost`.
    // Excluding `:` from the boundary would make "any port on localhost" unspellable.
    expect(matches('browser(http://localhost:*)',
      { tool: 'browser', target: 'http://localhost:5173/x' })).toBe(true)
    expect(matches('browser(http://localhost:*)',
      { tool: 'browser', target: 'http://localhost:8080/' })).toBe(true)
  })

  test('a trailing-slash prefix covers everything below that path', () => {
    expect(matches('browser(http://localhost:5173/admin/:*)',
      { tool: 'browser', target: 'http://localhost:5173/admin/users' })).toBe(true)
    expect(matches('browser(http://localhost:5173/admin/:*)',
      { tool: 'browser', target: 'http://localhost:5173/public' })).toBe(false)
  })

  test('an empty prefix authorizes nothing', () => {
    expect(matches('browser(:*)', BROWSER)).toBe(false)
  })

  test('a bare browser rule matches every browser call', () => {
    expect(matches('browser', BROWSER)).toBe(true)
    expect(matches('browser', { tool: 'browser' })).toBe(true)
  })

  test('an mcp server rule covers that server\'s tools', () => {
    expect(matches('mcp__github', MCP)).toBe(true)
    expect(matches('mcp__github__create_issue', MCP)).toBe(true)
  })

  test('a shorter server name does not cover a longer one', () => {
    // `mcp__git__` is not a prefix of `mcp__github__create_issue`. Without an explicit
    // separator check this is exactly the rule that would silently over-grant.
    expect(matches('mcp__git', MCP)).toBe(false)
    expect(matches('mcp__githu', MCP)).toBe(false)
  })

  test('prefix semantics belong to the mcp namespace alone', () => {
    // No built-in tool name may acquire them by accident.
    expect(matches('edit', { tool: 'edit_file', paths: ['a.ts'] })).toBe(false)
    expect(matches('browser', { tool: 'browser_thing' })).toBe(false)
  })

  test('a target key is never satisfied by a path-shaped rule and vice versa', () => {
    expect(matches('browser(src/**)', BROWSER)).toBe(false)
    expect(matches('edit_file(https://x:*)', { tool: 'edit_file', paths: ['a.ts'] })).toBe(false)
  })
})

describe('what the approval dialog offers', () => {
  test('a browser call offers this URL and this origin', () => {
    expect(suggestRules(BROWSER)).toEqual([
      'browser(https://example.dev/app)',
      'browser(https://example.dev:*)',
    ])
  })

  test('a target that is not a URL offers only the exact rule', () => {
    expect(suggestRules({ tool: 'browser', target: 'about:blank' }))
      .toEqual(['browser(about:blank)'])
  })

  test('an MCP call offers this tool and this whole server', () => {
    expect(suggestRules(MCP)).toEqual(['mcp__github__create_issue', 'mcp__github'])
  })

  test('a malformed mcp name offers only itself', () => {
    expect(suggestRules({ tool: 'mcp__lonely' })).toEqual(['mcp__lonely'])
  })
})

describe('rules the engine must stop calling broken', () => {
  const problemsFor = (rule: string): string[] =>
    new PermissionEngine({
      layers: [{ scope: 'project', path: 'p', permissions: { allow: [rule], ask: [], deny: [] } }],
      mode: 'normal',
      workspaceRoot: root,
    }).problems

  test('a URL spec on the browser is legitimate, not a settings problem', () => {
    // Every URL contains `//`, which `specHasNonCanonicalSyntax` flags for path rules. The
    // browser is target-keyed, so that check does not apply to it — exactly as it already
    // does not apply to `run_command(git clone https://...)`.
    expect(problemsFor('browser(http://localhost:5173:*)')).toEqual([])
    expect(problemsFor('browser(https://example.dev/app)')).toEqual([])
  })

  test('a spec on an MCP tool is still nonsense and still reported', () => {
    // An MCP key carries neither command, target nor paths: there is nothing for a spec to
    // match, so the rule could never fire. Naming the server is the right granularity.
    const problems = problemsFor('mcp__github__create_issue(anything)')
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('can never fire')
  })

  test('the old reports for path rules are unchanged', () => {
    expect(problemsFor('read_file(docs/**)')[0]).toContain('can never fire')
    expect(problemsFor('edit_file(./src/**)')[0]).toContain('non-canonical syntax')
  })
})

describe('rules still win over mode defaults for the new family', () => {
  const withLayer = (
    list: 'allow' | 'ask' | 'deny',
    rules: string[],
    mode: 'normal' | 'autopilot' = 'normal',
  ) =>
    new PermissionEngine({
      layers: [{
        scope: 'project',
        path: 'p',
        permissions: { allow: [], ask: [], deny: [], [list]: rules },
      }],
      mode,
      workspaceRoot: root,
    })

  test('an allow rule for one origin does not leak to another', () => {
    const engine = withLayer('allow', ['browser(http://localhost:*)'])
    expect(engine.decide({ tool: 'browser', target: 'http://localhost:5173/x' }).verdict).toBe('allow')
    expect(engine.decide({ tool: 'browser', target: 'https://evil.example/x' }).verdict).toBe('ask')
  })

  test('a deny rule for a server beats autopilot', () => {
    const engine = withLayer('deny', ['mcp__github'], 'autopilot')
    expect(engine.decide(MCP).verdict).toBe('deny')
    expect(engine.decide({ tool: 'mcp__sqlite__query' }).verdict).toBe('allow')
  })

  test('an always-allow from an approval takes effect immediately', () => {
    const engine = engineIn('normal')
    engine.addSessionRule('browser(http://localhost:5173:*)')
    expect(engine.problems).toEqual([])
    expect(engine.decide({ tool: 'browser', target: 'http://localhost:5173/admin' }).verdict)
      .toBe('allow')
  })
})
