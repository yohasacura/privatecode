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
  expect(p).toMatch(/do not deliberate at length.*do not re-check a decision/is)
})

test('plan mode says no changes will be made', () => {
  const p = buildSystemPrompt({ workspaceRoot: '/w', mode: 'plan' })
  expect(p).toMatch(/you are in plan mode.*no editing tools.*investigate.*concrete plan/is)
})

test('stays small enough not to crowd the context', () => {
  const p = buildSystemPrompt({ workspaceRoot: '/w', mode: 'normal' })
  // Actual: ~620 chars. Headroom: 2x. Increasing this is a deliberate budget change.
  expect(p.length).toBeLessThan(1400)
})
