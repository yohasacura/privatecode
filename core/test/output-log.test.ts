import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { Mount } from '../src/mounts.js'
import { countLines, headLines, overflowNotice, pruneLogs, spillToLog } from '../src/tools/output-log.js'
import { Workspace } from '../src/workspace.js'

/**
 * Overflow logs, on a real directory.
 *
 * Two properties matter more than anything else here, because the notice handed to the
 * model says "Do NOT re-run the command to see what was cut": the file has to be WRITTEN,
 * and the path advertised for it has to be one the model's own Read can open.
 */

let base: string

function dir(...parts: string[]): string {
  const path = join(base, ...parts)
  mkdirSync(path, { recursive: true })
  return path
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'pc-log-'))
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('spillToLog', () => {
  test('writes the log and hands back a path the workspace can resolve', async () => {
    const ws = new Workspace(dir('solo'))
    const log = await spillToLog(ws, 'run', 'one\ntwo\nthree\n')
    expect(log).not.toBeNull()
    // Forward slashes: the model's tools take those on every platform, backslashes are a
    // JSON-escaping trap in the argument it writes back.
    expect(log!.path).not.toContain('\\')
    expect(log!.path).toMatch(/^\.privatecode\/state\/logs\/run-\d{8}-\d{6}-\d{3}\.log$/)
    expect(log!.lines).toBe(3)
    expect(existsSync(ws.resolve(log!.path))).toBe(true)
  })

  test('works in a multi-folder workspace, and names the folder so Read can open it', async () => {
    const app = dir('app')
    const engine = dir('engine')
    const mounts: Mount[] = [
      { name: 'app', root: app, access: 'write', primary: true },
      { name: 'engine', root: engine, access: 'write', primary: false },
    ]
    const ws = new Workspace(mounts)
    expect(ws.multi).toBe(true)

    const log = await spillToLog(ws, 'run', 'x'.repeat(40))
    // Before: the path was assembled as `.privatecode/state/logs/…`, whose first segment
    // names no folder, so resolve() threw and spilling returned null — every oversized
    // output in a two-folder workspace fell back to middle-elided text.
    expect(log).not.toBeNull()
    expect(log!.path.startsWith('app/')).toBe(true)
    expect(existsSync(ws.resolve(log!.path))).toBe(true)
    expect(existsSync(join(app, '.privatecode', 'state', 'logs'))).toBe(true)
  })
})

describe('pruneLogs', () => {
  const logs = (folder: string, prefix: string): string[] =>
    readdirSync(folder).filter((n) => n.startsWith(`${prefix}-`))

  test('never touches another prefix, however full the folder is', async () => {
    const folder = dir('logs')
    for (let i = 0; i < 24; i++) {
      writeFileSync(join(folder, `run-20260819-0000${String(i).padStart(2, '0')}-000.log`), 'x')
    }
    const fresh = join(folder, 'browser-20260819-235959-000.log')
    writeFileSync(fresh, 'the page the model was just told to read')

    // 'browser' sorts before 'run', so the directory-wide sort put the newest file first
    // and unlinked it while its path was already in the model's transcript.
    await pruneLogs(folder, 'browser')
    expect(existsSync(fresh)).toBe(true)
    expect(logs(folder, 'run')).toHaveLength(24)
  })

  test('keeps the newest 20 of its own prefix and sheds the rest', async () => {
    const folder = dir('logs')
    for (let i = 0; i < 25; i++) {
      writeFileSync(join(folder, `run-20260819-0000${String(i).padStart(2, '0')}-000.log`), 'x')
    }
    writeFileSync(join(folder, 'web-20260819-000000-000.log'), 'x')

    await pruneLogs(folder, 'run')
    const kept = logs(folder, 'run').sort()
    expect(kept).toHaveLength(20)
    expect(kept[0]).toBe('run-20260819-000005-000.log')
    expect(kept[19]).toBe('run-20260819-000024-000.log')
    expect(logs(folder, 'web')).toHaveLength(1)
  })

  test('a missing directory is a no-op, not a throw', async () => {
    await expect(pruneLogs(join(base, 'nope'), 'run')).resolves.toBeUndefined()
  })
})

describe('the notice', () => {
  test('counts lines the way Read does and names both ways to page', () => {
    expect(countLines('')).toBe(0)
    expect(countLines('a\nb\n')).toBe(2)
    expect(countLines('a\r\nb')).toBe(2)
    expect(headLines('a\nb\nc', 2)).toBe('a\nb')
    const notice = overflowNotice({ path: 'app/.privatecode/state/logs/run-1.log', lines: 900 }, 60)
    expect(notice).toContain('840 more lines')
    expect(notice).toContain('app/.privatecode/state/logs/run-1.log')
    expect(notice).toMatch(/Read\(/)
    expect(notice).toMatch(/Grep\(/)
  })
})
