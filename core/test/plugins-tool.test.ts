import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { PermissionEngine } from '../src/permissions/engine.js'
import { pluginsTool } from '../src/tools/plugins.js'
import type { ToolContext } from '../src/tools/types.js'
import { Workspace } from '../src/workspace.js'

/**
 * The model's `/plugin …`: the same line the composer runs, behind the permission gate.
 * The runner itself is the host's and is tested with the host; here is what the tool
 * refuses, what it hands over, and how the engine treats it — like a command.
 */

let root: string
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'pc-plugins-tool-')) })
afterAll(() => { try { rmSync(root, { recursive: true, force: true }) } catch { /* Windows */ } })

test('only a /plugin line is accepted, trimmed', () => {
  expect(pluginsTool.validate({ line: '  /plugin install commit-commands@claude-code-plugins ' })).toEqual({ ok: true, args: { line: '/plugin install commit-commands@claude-code-plugins' } })
  expect(pluginsTool.validate({ line: '/plugins' }).ok).toBe(true)
  expect(pluginsTool.validate({ line: 'install x@y' }).ok).toBe(false)
  expect(pluginsTool.validate({ line: '' }).ok).toBe(false)
  expect(pluginsTool.validate({}).ok).toBe(false)
})

test('the line is the permission key, and the preview says what an install does', () => {
  const args = { line: '/plugin marketplace add anthropics/claude-code' }
  expect(pluginsTool.permissionKey!(args)).toEqual({ tool: 'plugins', command: args.line })
  const ctx: ToolContext = { workspace: new Workspace(root) }
  const preview = pluginsTool.approvalPreview!(args, ctx)
  expect(preview.summary).toBe(args.line)
  expect(preview.detail).toContain('Fetches and enables code')
  expect(pluginsTool.approvalPreview!({ line: '/plugin disable x@y' }, ctx).detail).toContain('nothing outside the plugin store')
})

test('without a host runner it says so; with one it hands the line over verbatim', async () => {
  const none = await pluginsTool.execute({ line: '/plugin list' }, { workspace: new Workspace(root) })
  expect(none.ok).toBe(false)
  expect(none.content).toContain('no plugin store')

  const seen: string[] = []
  const ctx: ToolContext = {
    workspace: new Workspace(root),
    plugins: { run: async (line) => { seen.push(line); return { ok: true, text: `ran ${line}` } } },
  }
  const r = await pluginsTool.execute({ line: '/plugin install x@y' }, ctx)
  expect(seen).toEqual(['/plugin install x@y'])
  expect(r).toEqual({ ok: true, content: 'ran /plugin install x@y' })
})

test('the engine gates it like a command: ask in normal, allow in autopilot, deny in plan, deny by rule', () => {
  const key = pluginsTool.permissionKey!({ line: '/plugin install x@y' })
  const at = (mode: 'normal' | 'auto-edit' | 'autopilot' | 'plan') => new PermissionEngine({ mode, workspaceRoot: root, layers: [] }).decide(key).verdict
  expect(at('normal')).toBe('ask')
  expect(at('auto-edit')).toBe('ask')
  expect(at('autopilot')).toBe('allow')
  expect(at('plan')).toBe('deny')
  const denied = new PermissionEngine({
    mode: 'autopilot', workspaceRoot: root,
    layers: [{ scope: 'project', path: join(root, '.privatecode', 'settings.json'), permissions: { allow: [], ask: [], deny: ['plugins'] } }],
  })
  expect(denied.decide(key).verdict).toBe('deny')
})
