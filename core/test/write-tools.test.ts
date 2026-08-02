import { beforeEach, expect, test } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../src/workspace.js'
import { editFileTool } from '../src/tools/edit-file.js'
import { writeFileTool } from '../src/tools/write-file.js'

let root: string
let ctx: { workspace: Workspace }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-write-'))
  writeFileSync(join(root, 'a.ts'), 'const x = 1\nconst y = 2\n')
  ctx = { workspace: new Workspace(root) }
})

test('edit_file applies a unique anchor and reports a diff', async () => {
  const r = await editFileTool.execute(
    { path: 'a.ts', search_text: 'const y = 2', replace_text: 'const y = 3' }, ctx)
  expect(r.ok).toBe(true)
  expect(readFileSync(join(root, 'a.ts'), 'utf8')).toContain('const y = 3')
  expect(r.content).toContain('-const y = 2')
  expect(r.content).toContain('+const y = 3')
})

test('edit_file returns an actionable message when the anchor is missing', async () => {
  const r = await editFileTool.execute(
    { path: 'a.ts', search_text: 'const z = 9', replace_text: 'x' }, ctx)
  expect(r.ok).toBe(false)
  expect(r.content).toMatch(/not found/i)
  // The file must be untouched after a failed edit.
  expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('const x = 1\nconst y = 2\n')
})

test('edit_file rejects an empty search_text before touching the disk', () => {
  const v = editFileTool.validate({ path: 'a.ts', search_text: '', replace_text: 'x' })
  expect(v.ok).toBe(false)
  if (v.ok) return
  expect(v.error).toMatch(/search_text/)
})

test('edit_file rejects a no-op edit', () => {
  const v = editFileTool.validate({ path: 'a.ts', search_text: 'same', replace_text: 'same' })
  expect(v.ok).toBe(false)
})

test('write_file creates a new file and reports the byte count', async () => {
  const r = await writeFileTool.execute({ path: 'sub/new.ts', content: 'export const n = 1\n' }, ctx)
  expect(r.ok).toBe(true)
  expect(readFileSync(join(root, 'sub', 'new.ts'), 'utf8')).toBe('export const n = 1\n')
  expect(r.content).toMatch(/19 bytes/)
})

test('write_file refuses to leave the workspace', async () => {
  const r = await writeFileTool.execute({ path: '../evil.ts', content: 'x' }, ctx)
  expect(r.ok).toBe(false)
  expect(r.content).toMatch(/escapes the workspace/)
})
