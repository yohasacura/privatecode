import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { loadLayers, settingsText } from '../src/permissions/settings.js'
import { loadVerify } from '../src/verify/config.js'
import { loadDatabaseSettings } from '../src/sql/settings.js'
import { loadBrowserSettings } from '../src/browser/settings.js'
import { PRIVATE_DIR } from '../src/private-dir.js'

/**
 * A settings file written the way Windows writes files.
 *
 * `JSON.parse` on a string beginning with U+FEFF throws, and every one of the six loaders
 * that read these files parsed the raw string. So a `settings.json` saved by PowerShell's
 * `Out-File -Encoding utf8` — which writes a BOM by default — or by any of several editors
 * was silently ignored IN FULL: permissions, the project check, the database, the browser,
 * hooks and formatting, all at once, with nothing reported and the file looking perfect in
 * every editor that opened it.
 *
 * Found while running a measurement: the arm of an experiment simply behaved like the
 * control, because the settings file that was supposed to distinguish them had a BOM.
 */

let root: string
const roots: string[] = []
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-bom-'))
  roots.push(root)
  mkdirSync(join(root, PRIVATE_DIR), { recursive: true })
})
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Exactly what `Out-File -Encoding utf8` produces on Windows PowerShell. */
const writeWithBom = (body: unknown): void => {
  writeFileSync(join(root, PRIVATE_DIR, 'settings.json'), `﻿${JSON.stringify(body)}`, 'utf8')
}

describe('a settings file with a byte-order mark', () => {
  test('the raw text really does break JSON.parse — this is not hypothetical', () => {
    expect(() => JSON.parse('﻿{"a":1}')).toThrow()
    expect(JSON.parse(settingsText('﻿{"a":1}'))).toEqual({ a: 1 })
  })

  test('settingsText leaves an ordinary file untouched', () => {
    expect(settingsText('{"a":1}')).toBe('{"a":1}')
    expect(settingsText('')).toBe('')
  })

  test('the project check is found', () => {
    writeWithBom({ verify: { command: 'dotnet build' } })
    expect(loadVerify(root).verify?.command).toBe('dotnet build')
  })

  test('the database is found', () => {
    writeWithBom({ database: { connectionString: 'Server=x;Database=Crm' } })
    expect(loadDatabaseSettings(root, {}).database?.connectionString).toContain('Crm')
  })

  test('permission rules are found, and not reported as malformed', () => {
    writeWithBom({ permissions: { allow: ['read_file'], ask: [], deny: [] } })
    const { layers, problems } = loadLayers(root)
    expect(layers.find((l) => l.scope === 'project')?.permissions.allow).toEqual(['read_file'])
    expect(problems).toEqual([])
  })

  test('browser settings are found', () => {
    writeWithBom({ browser: { headless: true } })
    expect(loadBrowserSettings(root).options.headless).toBe(true)
  })

  test('a file that is genuinely malformed is still reported', () => {
    // The fix must not turn a real syntax error into silence.
    writeFileSync(join(root, PRIVATE_DIR, 'settings.json'), '﻿{ not json', 'utf8')
    expect(loadLayers(root).problems.join(' ')).toContain('malformed JSON')
  })
})
