import { afterAll, beforeAll, expect, test } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../src/workspace.js'
import { readFileTool } from '../src/tools/read-file.js'
import { listDirTool } from '../src/tools/list-dir.js'
import { findFilesTool } from '../src/tools/find-files.js'

let ctx: { workspace: Workspace }
let tempRoot: string

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'pc-read-'))
  mkdirSync(join(tempRoot, 'src'))
  writeFileSync(join(tempRoot, 'src', 'a.ts'), 'one\ntwo\nthree\nfour\nfive\n')
  writeFileSync(join(tempRoot, 'src', 'b.ts'), 'export const b = 1\n')
  writeFileSync(join(tempRoot, 'README.md'), '# hi\n')
  ctx = { workspace: new Workspace(tempRoot) }
})

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true })
})

test('read_file numbers lines', async () => {
  const r = await readFileTool.execute({ path: 'src/a.ts' }, ctx)
  expect(r.ok).toBe(true)
  expect(r.content).toContain('1\tone')
  expect(r.content).toContain('5\tfive')
})

test('read_file honours a line range', async () => {
  const r = await readFileTool.execute({ path: 'src/a.ts', start_line: 2, end_line: 3 }, ctx)
  expect(r.content).toContain('2\ttwo')
  expect(r.content).toContain('3\tthree')
  expect(r.content).not.toContain('1\tone')
  expect(r.content).not.toContain('4\tfour')
})

test('read_file reports a missing file as a tool failure, not an exception', async () => {
  const r = await readFileTool.execute({ path: 'src/nope.ts' }, ctx)
  expect(r.ok).toBe(false)
  expect(r.content).toMatch(/not found|ENOENT/i)
})

test('read_file refuses to leave the workspace', async () => {
  const r = await readFileTool.execute({ path: '../escape.txt' }, ctx)
  expect(r.ok).toBe(false)
  expect(r.content).toMatch(/escapes the workspace/)
})

test('read_file rejects an empty path at validation time', () => {
  const v = readFileTool.validate({ path: '  ' })
  expect(v.ok).toBe(false)
})

test('list_dir lists entries and marks directories', async () => {
  const r = await listDirTool.execute({ path: '.' }, ctx)
  expect(r.content).toContain('src/')
  expect(r.content).toContain('README.md')
})

test('find_files matches a glob', async () => {
  const r = await findFilesTool.execute({ glob: 'src/*.ts' }, ctx)
  expect(r.content).toContain('src/a.ts')
  expect(r.content).toContain('src/b.ts')
  expect(r.content).not.toContain('README.md')
})
