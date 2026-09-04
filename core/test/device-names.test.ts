import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { bashArgs, findBash, removeDeviceNamedFiles, rewriteDeviceRedirects } from '../src/bash.js'
import { isWindowsDeviceName } from '../src/device-names.js'
import { runCommandTool } from '../src/tools/run-command.js'
import { Workspace } from '../src/workspace.js'

/**
 * The `nul` file. Git Bash's MSYS runtime opens paths through the NT API, so a cmd.exe-style
 * `2>nul` in the `Bash` tool creates a REAL file called `nul` — one that Explorer, `del` and
 * Node's plain `fs` can neither open nor delete, because to Win32 that name is the device.
 * Watched on the owner's other machine: the model wrote exactly that, and the workspace
 * root gained a file nothing could remove.
 *
 * Three guards, in the order they meet a command: the redirect is rewritten to `/dev/null`
 * before bash sees it; whatever still created such a file is removed after the command and
 * the result says so; and the file tools refuse the name outright, since a `Write` to it
 * would land on the device and report success.
 */

const windows = process.platform === 'win32'
const root = mkdtempSync(join(tmpdir(), 'pc-nul-'))
afterAll(() => {
  removeDeviceNamedFiles(root)
  rmSync(root, { recursive: true, force: true })
})

/** The one way to address such a file through Win32: the prefix turns the name rules off. */
const nt = (dir: string, name: string): string => `\\\\?\\${resolve(dir, name)}`

describe('the names Win32 reserves', () => {
  test.each(['nul', 'NUL', 'Nul', 'nul.txt', 'nul.tar.gz', 'nul ', 'nul.', 'con', 'prn', 'aux', 'com1', 'COM9', 'lpt1', 'con.d'])(
    '%j is a device name', (name) => { expect(isWindowsDeviceName(name)).toBe(true) },
  )
  test.each(['null', 'null.txt', 'nulx', 'console.ts', 'com10', 'com', 'lpt', 'aux2', '.nul', 'nul-file', 'conf'])(
    '%j is an ordinary file', (name) => { expect(isWindowsDeviceName(name)).toBe(false) },
  )
})

describe('a redirect to nul is read as /dev/null', () => {
  test.each([
    ['dotnet build 2>nul', 'dotnet build 2>/dev/null'],
    ['cmd >nul 2>&1', 'cmd >/dev/null 2>&1'],
    ['cmd > NUL', 'cmd > /dev/null'],
    ['cmd >>nul', 'cmd >>/dev/null'],
    ['cmd &>nul', 'cmd &>/dev/null'],
    ['cat <nul', 'cat </dev/null'],
    ['echo x 2> "nul"; echo y', 'echo x 2> /dev/null; echo y'],
    ['(cmd >nul) && next', '(cmd >/dev/null) && next'],
    ['>nul echo leading', '>/dev/null echo leading'],
  ])('%s', (input, expected) => {
    expect(rewriteDeviceRedirects(input)).toEqual({ command: expected, rewritten: true })
    expect(bashArgs(input)).toEqual(['-c', expected])
  })

  test.each([
    'grep -c nul file.txt',
    'echo nul',
    'cmd > null.txt',
    'cmd > nulx',
    'cmd 2>/dev/null',
    'cmd > dir/nul',
    'cmd > nul.txt',
  ])('%s is left alone', (input) => {
    expect(rewriteDeviceRedirects(input)).toEqual({ command: input, rewritten: false })
  })
})

describe.skipIf(!windows)('a file with a device name is removed from the folder', () => {
  test('the ones that exist go, the ordinary neighbours stay, and the names come back sorted', () => {
    const dir = join(root, 'sweep')
    mkdirSync(dir)
    writeFileSync(nt(dir, 'nul'), 'six\n')
    writeFileSync(nt(dir, 'con.txt'), '')
    writeFileSync(join(dir, 'null.txt'), '')
    expect(readdirSync(dir).sort()).toEqual(['con.txt', 'nul', 'null.txt'])

    expect(removeDeviceNamedFiles(dir)).toEqual(['con.txt', 'nul'])
    expect(readdirSync(dir)).toEqual(['null.txt'])
    expect(existsSync(nt(dir, 'nul'))).toBe(false)
  })

  test('a folder that cannot be listed removes nothing and says so quietly', () => {
    expect(removeDeviceNamedFiles(join(root, 'no-such-folder'))).toEqual([])
  })
})

describe.skipIf(!windows || findBash() === null)('through the Bash tool, against the real Git Bash', () => {
  const ctx = { workspace: new Workspace(root) }
  const run = async (command: string) => {
    const v = runCommandTool.validate({ command })
    if (!v.ok) throw new Error(v.error)
    return runCommandTool.execute(v.args, ctx)
  }

  test('a cmd.exe-style redirect creates nothing, and the result explains the rewrite', async () => {
    const r = await run('echo hello 2>nul >nul; echo done')
    expect(r.ok).toBe(true)
    expect(r.content).toContain('done')
    expect(r.content).toContain('read as `/dev/null`')
    expect(readdirSync(root)).not.toContain('nul')
  })

  test('a file the rewrite could not see is gone before the model reads the result', async () => {
    // Not a redirect, so it reaches bash as typed, and MSYS creates the real file.
    const r = await run('touch nul; touch prn.log; echo made')
    expect(r.ok).toBe(true)
    expect(r.content).toContain('made')
    expect(r.content).toContain('Removed `nul`, `prn.log`')
    expect(readdirSync(root)).not.toContain('nul')
    expect(readdirSync(root)).not.toContain('prn.log')
  })

  test('an ordinary command carries no note', async () => {
    const r = await run('echo plain')
    expect(r.content).not.toContain('/dev/null')
    expect(r.content).not.toContain('Removed')
  })
})

describe.skipIf(!windows)('the file tools refuse the name', () => {
  const ws = new Workspace(root)
  test.each(['nul', 'NUL', 'nul.txt', 'src/con.txt', 'sub/dir/com1', 'aux'])('%s is refused', (path) => {
    expect(() => ws.resolve(path)).toThrow(/Windows device name/)
    expect(() => ws.resolveForWrite(path)).toThrow(/Windows device name/)
  })
  test.each(['null.txt', 'console.ts', 'src/com10', 'nul-file.md', 'conf/app.json'])('%s is fine', (path) => {
    expect(() => ws.resolve(path)).not.toThrow()
  })
})
