import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { PermissionEngine } from '../src/permissions/engine.js'
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
