import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { loadUiConfig, saveUiConfig } from '../src/host/ui-config.js'

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pc-ui-config-'))
  path = join(dir, 'PrivateCode', 'ui.json')
  mkdirSync(join(dir, 'PrivateCode'), { recursive: true }) // saveUiConfig also does this itself; tests that write raw files need it done up front
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

test('a missing file loads as empty config with no problems reported', () => {
  const { config, problems } = loadUiConfig(path)
  expect(config).toEqual({ recentWorkspaces: [] })
  expect(problems).toEqual([])
})

test('save then load round-trips serverUrl', () => {
  saveUiConfig({ serverUrl: 'http://127.0.0.1:8080' }, path)
  const { config, problems } = loadUiConfig(path)
  expect(config.serverUrl).toBe('http://127.0.0.1:8080')
  expect(problems).toEqual([])
})

test('recentWorkspace is added most-recent-first and deduplicated', () => {
  saveUiConfig({ recentWorkspace: 'C:/a' }, path)
  saveUiConfig({ recentWorkspace: 'C:/b' }, path)
  saveUiConfig({ recentWorkspace: 'C:/a' }, path) // re-visiting C:/a moves it back to front
  const { config } = loadUiConfig(path)
  expect(config.recentWorkspaces).toEqual(['C:/a', 'C:/b'])
})

test('recentWorkspaces is capped at 8, oldest dropped first', () => {
  for (let i = 0; i < 10; i++) saveUiConfig({ recentWorkspace: `C:/ws${i}` }, path)
  const { config } = loadUiConfig(path)
  expect(config.recentWorkspaces).toHaveLength(8)
  expect(config.recentWorkspaces[0]).toBe('C:/ws9') // most recent
  expect(config.recentWorkspaces).not.toContain('C:/ws0') // oldest, evicted
  expect(config.recentWorkspaces).not.toContain('C:/ws1')
})

test('saving serverUrl and recentWorkspace independently does not clobber the other', () => {
  saveUiConfig({ serverUrl: 'http://127.0.0.1:8080' }, path)
  saveUiConfig({ recentWorkspace: 'C:/proj' }, path)
  const { config } = loadUiConfig(path)
  expect(config.serverUrl).toBe('http://127.0.0.1:8080')
  expect(config.recentWorkspaces).toEqual(['C:/proj'])
})

// --- Corrupt-file tolerance (the settings.ts precedent: loud problem, safe defaults) ---

test('malformed JSON loads as empty config with a loud problem, not a thrown exception', () => {
  writeFileSync(path, '{not valid json', 'utf8')

  const { config, problems } = loadUiConfig(path)
  expect(config).toEqual({ recentWorkspaces: [] })
  expect(problems).toHaveLength(1)
  expect(problems[0]).toMatch(/malformed JSON/i)
})

test('a JSON root that is not an object loads as empty config with a loud problem', () => {
  writeFileSync(path, JSON.stringify(['not', 'an', 'object']), 'utf8')

  const { config, problems } = loadUiConfig(path)
  expect(config).toEqual({ recentWorkspaces: [] })
  expect(problems).toHaveLength(1)
  expect(problems[0]).toMatch(/must be a JSON object/i)
})

test('a wrong-typed serverUrl is ignored with a problem, but a valid recentWorkspaces survives', () => {
  writeFileSync(path, JSON.stringify({ serverUrl: 12345, recentWorkspaces: ['C:/ok'] }), 'utf8')

  const { config, problems } = loadUiConfig(path)
  expect(config.serverUrl).toBeUndefined()
  expect(config.recentWorkspaces).toEqual(['C:/ok'])
  expect(problems).toHaveLength(1)
  expect(problems[0]).toMatch(/"serverUrl".*not a string/i)
})

test('a non-array recentWorkspaces is ignored with a problem', () => {
  writeFileSync(path, JSON.stringify({ recentWorkspaces: 'not-an-array' }), 'utf8')

  const { config, problems } = loadUiConfig(path)
  expect(config.recentWorkspaces).toEqual([])
  expect(problems).toHaveLength(1)
  expect(problems[0]).toMatch(/"recentWorkspaces".*not an array/i)
})

test('a non-string entry in recentWorkspaces is dropped, its string siblings kept', () => {
  writeFileSync(path, JSON.stringify({ recentWorkspaces: ['C:/a', 42, 'C:/b'] }), 'utf8')

  const { config, problems } = loadUiConfig(path)
  expect(config.recentWorkspaces).toEqual(['C:/a', 'C:/b'])
  expect(problems).toHaveLength(1)
})

test('saveUiConfig on top of a corrupt existing file does not throw, and writes a fresh valid document', () => {
  writeFileSync(path, '{not valid json', 'utf8')

  expect(() => saveUiConfig({ serverUrl: 'http://127.0.0.1:9090' }, path)).not.toThrow()
  const { config, problems } = loadUiConfig(path)
  expect(config.serverUrl).toBe('http://127.0.0.1:9090')
  expect(problems).toEqual([])
})

test('the theme setting round-trips, and a value that is not one of the three is reported and dropped', () => {
  const path = join(dir, 'ui.json')
  saveUiConfig({ theme: 'light' }, path)
  expect(loadUiConfig(path).config.theme).toBe('light')
  // Saving something else leaves the theme alone.
  saveUiConfig({ serverUrl: 'http://127.0.0.1:1' }, path)
  expect(loadUiConfig(path).config.theme).toBe('light')
  writeFileSync(path, JSON.stringify({ theme: 'sepia', recentWorkspaces: [] }), 'utf8')
  const loaded = loadUiConfig(path)
  expect(loaded.config.theme).toBeUndefined()
  expect(loaded.problems.join(' ')).toContain('"theme"')
})

test('motion and ligatures round-trip, and a wrong value is reported and dropped', () => {
  const path = join(dir, 'ui.json')
  saveUiConfig({ motion: 'reduce', ligatures: false }, path)
  expect(loadUiConfig(path).config).toMatchObject({ motion: 'reduce', ligatures: false })
  // Saving something else leaves them alone.
  saveUiConfig({ theme: 'dark' }, path)
  expect(loadUiConfig(path).config).toMatchObject({ motion: 'reduce', ligatures: false, theme: 'dark' })
  writeFileSync(path, JSON.stringify({ motion: 'sometimes', ligatures: 'yes', recentWorkspaces: [] }), 'utf8')
  const loaded = loadUiConfig(path)
  expect(loaded.config.motion).toBeUndefined()
  expect(loaded.config.ligatures).toBeUndefined()
  expect(loaded.problems.join(' ')).toContain('"motion"')
  expect(loaded.problems.join(' ')).toContain('"ligatures"')
})
