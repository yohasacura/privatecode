import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { materializeEmbeddedSkills } from '../src/skills/skills.js'

/**
 * The skills the agent carries are written beside it on start — but only when the stamp
 * there is not this build's, and then wholesale, so a file the previous version shipped does
 * not survive beside the new one. The placeholder module carries nothing; the payload here
 * stands in for what bundle.mjs generates.
 */

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
const payload = {
  stamp: 'abc123',
  files: {
    'pptx/SKILL.md': b64('---\ndescription: decks\n---\nBuild decks.'),
    'pptx/pptx.cjs': b64('console.log("tool")'),
    'pptx/examples/sample.json': b64('{"slides":[]}'),
    'mermaid/SKILL.md': b64('---\ndescription: diagrams\n---\nDraw.'),
  },
}

let tmp: string
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'pc-embedded-')) })
afterAll(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* Windows */ } })

test('a placeholder payload writes nothing', () => {
  const dir = join(tmp, 'none')
  expect(materializeEmbeddedSkills(dir, { stamp: '', files: {} })).toBe('nothing-carried')
  expect(existsSync(dir)).toBe(false)
})

test('a missing or different stamp writes every carried skill and stamps the folder', () => {
  const dir = join(tmp, 'skills')
  // What an older sidecar left: the python scripts the pptx skill used to ship, and a
  // skill of the user's own that is NOT carried and must be left alone.
  mkdirSync(join(dir, 'pptx'), { recursive: true })
  writeFileSync(join(dir, 'pptx', 'pptx_build.py'), 'old')
  writeFileSync(join(dir, 'pptx', 'SKILL.md'), 'old skill')
  mkdirSync(join(dir, 'mine'), { recursive: true })
  writeFileSync(join(dir, 'mine', 'SKILL.md'), 'hand-made')

  expect(materializeEmbeddedSkills(dir, payload)).toBe('written')
  expect(readFileSync(join(dir, 'pptx', 'SKILL.md'), 'utf8')).toContain('Build decks.')
  expect(readFileSync(join(dir, 'pptx', 'examples', 'sample.json'), 'utf8')).toBe('{"slides":[]}')
  expect(readFileSync(join(dir, 'mermaid', 'SKILL.md'), 'utf8')).toContain('Draw.')
  expect(existsSync(join(dir, 'pptx', 'pptx_build.py'))).toBe(false)
  expect(readFileSync(join(dir, 'mine', 'SKILL.md'), 'utf8')).toBe('hand-made')
  expect(readFileSync(join(dir, '.stamp'), 'utf8').trim()).toBe('abc123')

  // Current: nothing is touched on the next start.
  const before = statSync(join(dir, 'pptx', 'pptx.cjs')).mtimeMs
  expect(materializeEmbeddedSkills(dir, payload)).toBe('current')
  expect(statSync(join(dir, 'pptx', 'pptx.cjs')).mtimeMs).toBe(before)

  // A new build: written again, whatever was there.
  writeFileSync(join(dir, 'pptx', 'stray.txt'), 'x')
  expect(materializeEmbeddedSkills(dir, { ...payload, stamp: 'def456' })).toBe('written')
  expect(existsSync(join(dir, 'pptx', 'stray.txt'))).toBe(false)
  expect(readFileSync(join(dir, '.stamp'), 'utf8').trim()).toBe('def456')
})
