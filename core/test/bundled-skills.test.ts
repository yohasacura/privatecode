import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { listCommands } from '../src/commands/custom.js'
import { bundledSkillSources, bundledSkillsDir, loadSkills, readSkillText } from '../src/skills/skills.js'

/**
 * The four skills PrivateCode ships (`core/skills/`): found from a checkout, loaded with
 * the descriptions the catalogue needs, reachable as slash commands, and replaceable by a
 * skill of the same name in the user's own folder.
 */

const SHIPPED = ['grill-me', 'mermaid', 'pptx', 'skill-creator']

let tmp: string
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'pc-bundled-')) })
afterAll(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* Windows */ } })

test('the bundled folder is found from a checkout and holds the four skills', () => {
  const dir = bundledSkillsDir()
  expect(dir).not.toBeNull()
  expect(bundledSkillSources()).toEqual([{ scope: 'bundled', dir, label: 'bundled skills' }])
  const loaded = loadSkills(tmp, join(tmp, 'user-skills'), bundledSkillSources())
  expect(loaded.problems).toEqual([])
  expect(loaded.skills.map((s) => s.name)).toEqual(SHIPPED)
  for (const s of loaded.skills) {
    expect(s.scope).toBe('bundled')
    expect(s.description.length).toBeLessThanOrEqual(400)
    expect(s.description.length).toBeGreaterThan(60)
    expect(loaded.catalogue).toContain(s.name)
    // The body reads back without its frontmatter and is a real procedure, not a stub.
    expect(readSkillText(s).length).toBeGreaterThan(1_000)
  }
  // pptx ships its scripts beside it, and the tool can read them by name.
  const pptx = loaded.skills.find((s) => s.name === 'pptx')!
  expect(pptx.files).toEqual(['pptx_build.py', 'pptx_outline.py', 'pptx_replace.py'])
  expect(readSkillText(pptx, 'pptx_outline.py')).toContain('from pptx import Presentation')
})

test('every bundled skill is a slash command, and the user folder wins a clash', () => {
  const sources = bundledSkillSources().map((s) => ({ dir: s.dir, kind: 'skills' as const, label: 'bundled skills' }))
  const { commands } = listCommands(tmp, sources)
  expect(commands.map((c) => c.name)).toEqual(SHIPPED)
  expect(commands.find((c) => c.name === 'grill-me')?.argumentHint).toBe('[the plan, or a file that holds it]')
  // The user's own `mermaid` replaces the bundled one, and the shadowing is reported.
  const userDir = join(tmp, 'user-skills')
  const { mkdirSync, writeFileSync } = require('node:fs') as typeof import('node:fs')
  mkdirSync(join(userDir, 'mermaid'), { recursive: true })
  writeFileSync(join(userDir, 'mermaid', 'SKILL.md'), '---\ndescription: My own mermaid rules\n---\nMine.\n')
  const loaded = loadSkills(tmp, userDir, bundledSkillSources())
  expect(loaded.skills.find((s) => s.name === 'mermaid')?.scope).toBe('user')
  expect(loaded.problems).toEqual([expect.stringContaining('"mermaid" is defined twice')])
  expect(readFileSync(loaded.skills.find((s) => s.name === 'mermaid')!.path, 'utf8')).toContain('My own mermaid rules')
})
