import { expect, test } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { Workspace, WorkspaceViolation } from '../src/workspace.js'

const root = mkdtempSync(join(tmpdir(), 'pc-ws-'))

test('resolves a relative path inside the root', () => {
  const ws = new Workspace(root)
  expect(ws.resolve('src/a.ts')).toBe(join(root, 'src', 'a.ts'))
})

test('rejects traversal out of the root', () => {
  const ws = new Workspace(root)
  expect(() => ws.resolve('../outside.txt')).toThrow(WorkspaceViolation)
  expect(() => ws.resolve('src/../../outside.txt')).toThrow(WorkspaceViolation)
})

test('rejects absolute paths outside the root', () => {
  const ws = new Workspace(root)
  expect(() => ws.resolve('C:\\Windows\\System32\\drivers\\etc\\hosts'))
    .toThrow(WorkspaceViolation)
})

test('rejects secrets even inside the root', () => {
  const ws = new Workspace(root)
  for (const p of ['.env', 'config/.env.local', 'certs/server.pem', '.ssh/id_rsa']) {
    expect(() => ws.resolve(p), p).toThrow(/denied/i)
  }
})

test('allows a file that merely contains the word env', () => {
  const ws = new Workspace(root)
  expect(() => ws.resolve('src/environment.ts')).not.toThrow()
})

test('reports paths relative to the root', () => {
  const ws = new Workspace(root)
  expect(ws.relative(join(root, 'src', 'a.ts'))).toBe(`src${sep}a.ts`)
})
