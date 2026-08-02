import { beforeAll, expect, test } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../src/workspace.js'
import { searchCodeTool } from '../src/tools/search-code.js'

let ctx: { workspace: Workspace }

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), 'pc-rg-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'auth.ts'), 'export function validateToken(t: string) {\n  return t.length > 0\n}\n')
  writeFileSync(join(root, 'src', 'ui.tsx'), 'export const Button = () => null\n')
  ctx = { workspace: new Workspace(root) }
})

test('finds matches with file and line number', async () => {
  const r = await searchCodeTool.execute({ pattern: 'validateToken' }, ctx)
  expect(r.ok).toBe(true)
  expect(r.content).toMatch(/src[\\/]auth\.ts:1/)
  expect(r.content).toContain('validateToken')
})

test('respects a glob filter', async () => {
  const r = await searchCodeTool.execute({ pattern: 'export', glob: '*.tsx' }, ctx)
  expect(r.content).toContain('ui.tsx')
  expect(r.content).not.toContain('auth.ts')
})

test('reports no matches as a successful, explicit result', async () => {
  const r = await searchCodeTool.execute({ pattern: 'zzz_nothing_zzz' }, ctx)
  expect(r.ok).toBe(true)
  expect(r.content).toMatch(/no matches/i)
})

test('rejects an empty pattern', () => {
  expect(searchCodeTool.validate({ pattern: '' }).ok).toBe(false)
})

test('reports an invalid regex as a tool failure', async () => {
  const r = await searchCodeTool.execute({ pattern: '(' }, ctx)
  expect(r.ok).toBe(false)
  expect(r.content).toMatch(/regex|parse/i)
})
