import { expect, test } from 'vitest'
import { buildSystemPrompt } from '../src/agent/prompt.js'

test('names the workspace root', () => {
  const p = buildSystemPrompt({ workspaceRoot: 'D:\\Projects\\small-crm', mode: 'normal' })
  expect(p).toContain('D:\\Projects\\small-crm')
})

// Measured: an anti-deliberation instruction is one of the two levers that suppress the
// thinking runaway (docs/SPIKE-TEMPERATURE.md, arm T3).
test('tells the model to commit rather than re-check', () => {
  const p = buildSystemPrompt({ workspaceRoot: '/w', mode: 'normal' })
  expect(p).toMatch(/re-check|deliberat/i)
})

test('plan mode says no changes will be made', () => {
  const p = buildSystemPrompt({ workspaceRoot: '/w', mode: 'plan' })
  expect(p).toMatch(/plan/i)
  expect(p).toMatch(/cannot (modify|change)/i)
})

test('stays small enough not to crowd the context', () => {
  const p = buildSystemPrompt({ workspaceRoot: '/w', mode: 'normal' })
  expect(p.length).toBeLessThan(3000)
})
