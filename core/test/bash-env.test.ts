import { dirname } from 'node:path'
import { expect, test } from 'vitest'
import { bashEnv } from '../src/bash.js'
import { bundledSkillsDir } from '../src/skills/skills.js'

/**
 * What the `Bash` tool's environment carries beyond the machine's own: the running node on
 * PATH, so a script skill works where node was never installed, and the bundled skills
 * folder as a variable the model can write literally.
 */

const fake = { exe: 'C:\\nowhere\\bash.exe', binDir: 'C:\\nowhere', source: 'env' as const }

test('the running node is on the PATH, after bash and the extra folders', () => {
  const env = bashEnv(fake, ['C:\\plugin\\bin'])
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')!
  const parts = env[key]!.split(';')
  expect(parts[0]).toBe('C:\\nowhere')
  expect(parts[1]).toBe('C:\\plugin\\bin')
  expect(parts[2]).toBe(dirname(process.execPath))
})

test('PRIVATECODE_SKILLS names the bundled skills folder, where a checkout has one', () => {
  const env = bashEnv(fake)
  const dir = bundledSkillsDir()
  expect(dir).not.toBeNull()
  expect(env['PRIVATECODE_SKILLS']).toBe(dir)
  expect(env['PRIVATECODE_SKILLS']).toMatch(/skills$/)
})
