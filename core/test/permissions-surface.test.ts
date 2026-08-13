import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { PermissionEngine } from '../src/permissions/engine.js'
import { parseRule, ruleMatches, suggestRules } from '../src/permissions/rules.js'
import {
  addRuleToSettings, loadLayers, projectSettingsPath, removeRuleFromSettings,
} from '../src/permissions/settings.js'
import { PRIVATE_DIR } from '../src/private-dir.js'

/**
 * Being able to take a permission back.
 *
 * The window could grant a standing permission from two places — an approval card's "Allow
 * always" and the decision queue — and had nowhere to show what had been granted, let alone
 * withdraw it. On a tool whose whole premise is that it runs on your own machine, the one
 * subject you most need to audit was the one the interface never displayed.
 */

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-perm-'))
  mkdirSync(join(root, PRIVATE_DIR), { recursive: true })
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const rulesOf = (list: 'allow' | 'ask' | 'deny'): string[] =>
  loadLayers(root).layers.find((l) => l.scope === 'project')!.permissions[list]

describe('withdrawing a rule', () => {
  test('takes it out, and says it was there', () => {
    const path = projectSettingsPath(root)
    addRuleToSettings(path, 'allow', 'run_command(npm test:*)')
    addRuleToSettings(path, 'allow', 'edit_file(src/**)')

    expect(removeRuleFromSettings(path, 'allow', 'run_command(npm test:*)')).toBe(true)
    expect(rulesOf('allow')).toEqual(['edit_file(src/**)'])
  })

  test('a rule that is not there is reported, not silently succeeded', () => {
    // A revocation that raced another window, or a file edited by hand between the list and
    // the click. Saying so is what stops the screen showing a rule as gone while it is not.
    const path = projectSettingsPath(root)
    addRuleToSettings(path, 'allow', 'edit_file(src/**)')
    expect(removeRuleFromSettings(path, 'allow', 'run_command(rm:*)')).toBe(false)
    expect(rulesOf('allow')).toEqual(['edit_file(src/**)'])
  })

  test('only the named list loses it, so an allow cannot delete a deny', () => {
    // `deny` is the list a user writes to protect themselves. The same rule text can sit in
    // two lists at once, and revoking the permissive one must not touch the protective one.
    const path = projectSettingsPath(root)
    addRuleToSettings(path, 'allow', 'run_command(git push:*)')
    addRuleToSettings(path, 'deny', 'run_command(git push:*)')

    removeRuleFromSettings(path, 'allow', 'run_command(git push:*)')

    expect(rulesOf('allow')).toEqual([])
    expect(rulesOf('deny')).toEqual(['run_command(git push:*)'])
  })

  test('and a deny can be lifted without the allow list leaking into it', () => {
    // The mirror of the case above, and the one that actually has teeth. Two earlier versions
    // did not:
    //   - removing from `allow` passes even if the `list` argument is ignored entirely;
    //   - removing from `deny` with BOTH lists holding the same rule also passes, because
    //     filtering the wrong list produced the same answer.
    // The lists have to hold DIFFERENT things for the wrong one to be visible. Here `allow`
    // keeps an extra rule, so filtering it instead of `deny` would move `edit_file(src/**)`
    // into the deny list — which is not a subtle failure, it is the agent forbidden from
    // doing the thing you allowed.
    const path = projectSettingsPath(root)
    addRuleToSettings(path, 'allow', 'run_command(git push:*)')
    addRuleToSettings(path, 'allow', 'edit_file(src/**)')
    addRuleToSettings(path, 'deny', 'run_command(git push:*)')

    expect(removeRuleFromSettings(path, 'deny', 'run_command(git push:*)')).toBe(true)

    expect(rulesOf('deny')).toEqual([])
    expect(rulesOf('allow')).toEqual(['run_command(git push:*)', 'edit_file(src/**)'])
  })

  test('everything else in the file survives', () => {
    // The settings file is hand-edited and holds more than permissions. A revocation that
    // dropped a `verify` command or an MCP block would be a far worse outcome than the one
    // it was asked to produce.
    const path = projectSettingsPath(root)
    writeFileSync(path, JSON.stringify({
      verify: 'npm test',
      mcpServers: { docs: { command: 'node', args: ['docs.js'] } },
      permissions: { allow: ['edit_file(**)'], deny: ['run_command(rm:*)'] },
    }, null, 2), 'utf8')

    removeRuleFromSettings(path, 'allow', 'edit_file(**)')

    const doc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    expect(doc['verify']).toBe('npm test')
    expect(doc['mcpServers']).toEqual({ docs: { command: 'node', args: ['docs.js'] } })
    expect(rulesOf('deny')).toEqual(['run_command(rm:*)'])
  })

  test('a file that does not exist is not created by revoking from it', () => {
    // The layer holds no rules, so there is nothing to remove — and writing an empty settings
    // file as the side effect of a no-op revocation would leave the workspace changed by an
    // action that did nothing.
    const path = projectSettingsPath(root)
    expect(existsSync(path)).toBe(false)
    expect(removeRuleFromSettings(path, 'allow', 'anything')).toBe(false)
    expect(existsSync(path)).toBe(false)
  })

  test('revoking reaches the LIVE engine, not only the file', () => {
    // The audit's highest finding, verified live before the fix: a grant applies to the
    // running engine the moment it is made (`engine.remember` patches the in-memory layers),
    // but revocation edited only the file — so the screen showed the rule gone while
    // `decide()` kept auto-allowing on the in-memory copy, citing a settings file that no
    // longer contained the rule. Until the next session build, which mid-overnight-run is
    // never, the revocation was a decoration.
    const engine = new PermissionEngine({
      layers: [
        { scope: 'project', path: projectSettingsPath(root), permissions: { allow: [], ask: [], deny: [] } },
      ],
      mode: 'normal',
      workspaceRoot: root,
    })
    engine.remember('run_command(npm test:*)', 'project')
    expect(engine.decide({ tool: 'run_command', command: 'npm test --watch' }).verdict).toBe('allow')

    engine.forget('project', 'allow', 'run_command(npm test:*)')

    // The same key now falls through to the mode default — asked, not auto-allowed.
    expect(engine.decide({ tool: 'run_command', command: 'npm test --watch' }).verdict).toBe('ask')
  })

  test('lifting a deny reaches the live engine the same way', () => {
    // The mirror: a lifted restriction that the engine kept enforcing would be the same
    // asymmetry pointing the other direction — safer, but still a screen showing one thing
    // while the gate does another.
    const engine = new PermissionEngine({
      layers: [
        {
          scope: 'project', path: projectSettingsPath(root),
          permissions: { allow: [], ask: [], deny: ['run_command(npm publish:*)'] },
        },
      ],
      mode: 'autopilot',
      workspaceRoot: root,
    })
    expect(engine.decide({ tool: 'run_command', command: 'npm publish --tag next' }).verdict).toBe('deny')

    engine.forget('project', 'deny', 'run_command(npm publish:*)')

    expect(engine.decide({ tool: 'run_command', command: 'npm publish --tag next' }).verdict).toBe('allow')
  })

  test('a written rule applies to the live engine immediately, in any list', () => {
    // `adopt` is `remember`'s generalisation, and the deny case is the one with teeth: a
    // deny typed into the permissions screen that did not bite until the next session build
    // would be the revoke hole again, pointed the more dangerous way — the user believes a
    // protection is standing and it is not.
    const engine = new PermissionEngine({
      layers: [
        { scope: 'project', path: projectSettingsPath(root), permissions: { allow: [], ask: [], deny: [] } },
      ],
      mode: 'autopilot',
      workspaceRoot: root,
    })
    expect(engine.decide({ tool: 'run_command', command: 'npm publish' }).verdict).toBe('allow')

    expect(engine.adopt('project', 'deny', 'run_command(npm publish:*)')).toBeNull()

    expect(engine.decide({ tool: 'run_command', command: 'npm publish' }).verdict).toBe('deny')
  })

  test('a malformed rule is refused with a reason and adopts nothing', () => {
    const engine = new PermissionEngine({
      layers: [
        { scope: 'project', path: projectSettingsPath(root), permissions: { allow: [], ask: [], deny: [] } },
      ],
      mode: 'normal',
      workspaceRoot: root,
    })
    const problem = engine.adopt('project', 'deny', '!!not a rule!!')
    expect(problem).toMatch(/not a valid rule/)
    expect(engine.decide({ tool: 'run_command', command: 'anything' }).verdict).toBe('ask')
  })

  test('a broken file is refused rather than overwritten', () => {
    // The same protection the writer already had: a file that cannot be parsed may hold deny
    // rules being relied on right now, and replacing it with a fresh document would erase
    // them. Revoking is not a reason to lower that bar.
    const path = projectSettingsPath(root)
    writeFileSync(path, '{ this is not json', 'utf8')
    expect(() => removeRuleFromSettings(path, 'allow', 'x')).toThrow(/not valid JSON/)
    expect(readFileSync(path, 'utf8')).toBe('{ this is not json')
  })
})

describe('what an approval offers to remember', () => {
  /**
   * The default offer has to be a rule that will still match tomorrow.
   *
   * Reported from a real session: "Allow for this session" was pressed and the same prompt
   * came back immediately. The cause was the ORDER of the offers — the exact command line
   * led the list and was therefore preselected, and the model rewrites the tail of a command
   * between calls. These three are one decision to a person and three different keys to the
   * engine:
   *
   *     dotnet build x.csproj 2>&1 | Select-Object -Last 30
   *     dotnet build x.csproj 2>&1 | Select-Object -Last 20
   *     dotnet build x.csproj 2>&1 | Select-Object -Last 20
   */
  const BUILD_30 = 'dotnet build src/W.csproj 2>&1 | Select-Object -Last 30'
  const BUILD_20 = 'dotnet build src/W.csproj 2>&1 | Select-Object -Last 20'

  test('the verb-plus-subcommand rule leads, and it survives the tail changing', () => {
    const offers = suggestRules({ tool: 'run_command', command: BUILD_30 })
    expect(offers[0]).toBe('run_command(dotnet build:*)')

    // The property the ordering exists for: what the user accepted still covers the NEXT
    // call. Asserted through the matcher, not by eyeballing the string.
    const rule = parseRule(offers[0]!)
    expect(rule).not.toBeNull()
    expect(ruleMatches(rule!, { tool: 'run_command', command: BUILD_20 })).toBe(true)
  })

  test('the exact command is still offered, and it is the one that does NOT survive', () => {
    const offers = suggestRules({ tool: 'run_command', command: BUILD_30 })
    // Lowercased: `normalizeCommand` folds case, which is why a rule matches `GIT.EXE PUSH`
    // as well as `git push`.
    const exact = offers.find((o) => o.includes('last 30'))
    expect(exact).toBeDefined()
    const rule = parseRule(exact!)
    expect(ruleMatches(rule!, { tool: 'run_command', command: BUILD_30 })).toBe(true)
    expect(ruleMatches(rule!, { tool: 'run_command', command: BUILD_20 })).toBe(false)
  })

  test('a one-word command has no subcommand to generalise, so the exact rule leads', () => {
    expect(suggestRules({ tool: 'run_command', command: 'ls' }))
      .toEqual(['run_command(ls)', 'run_command(ls:*)'])
  })

  test('a session grant made from the leading offer stops the second prompt', () => {
    // End to end through the engine, because that is where the user's complaint lives:
    // ask once, remember, and the next variant must not ask again.
    const engine = new PermissionEngine({ layers: [], mode: 'normal', workspaceRoot: root })
    expect(engine.decide({ tool: 'run_command', command: BUILD_30 }).verdict).toBe('ask')
    engine.addSessionRule(suggestRules({ tool: 'run_command', command: BUILD_30 })[0]!)
    expect(engine.decide({ tool: 'run_command', command: BUILD_20 }).verdict).toBe('allow')
  })
})
