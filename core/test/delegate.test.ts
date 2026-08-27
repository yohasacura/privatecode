import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ROLES, ROLE_NAMES, runSubAgent } from '../src/agent/subagent.js'
import { delegateTool } from '../src/tools/delegate.js'
import { buildRegistry } from '../src/tools/default-set.js'
import type { SubAgentOutcome } from '../src/agent/subagent.js'
import { Workspace } from '../src/workspace.js'

/**
 * Handing one narrow job to a worker with its own conversation.
 *
 * What is worth pinning here is not that the tool calls a function — it is the three
 * properties the feature exists for, each of which is easy to lose silently:
 *
 *  - the ROLE is a closed list, because a caller choosing from one is choosing something the
 *    harness can check, and a caller writing a brief for an improvised assistant is not
 *  - a worker's cost is REPORTED, so several steps hidden behind one call are still visible
 *  - a worker that fails costs the caller a message, never the turn
 *
 * The worker itself is exercised live in `spike/` — a real one needs a real model.
 */

let root: string
const call = (args: unknown, ctx: Partial<Parameters<typeof delegateTool.execute>[1]> = {}) => {
  const v = delegateTool.validate(args)
  if (!v.ok) throw new Error(`validate refused: ${v.error}`)
  return delegateTool.execute(v.args, { workspace: new Workspace(root), ...ctx })
}

const outcome = (over: Partial<SubAgentOutcome> = {}): SubAgentOutcome => ({
  role: 'investigate', text: 'It is in src/slug.ts:14.', steps: 3, ms: 4800, ...over,
})

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pc-delegate-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('what the caller may ask for', () => {
  test('the role is a closed list, not a description of a helper', () => {
    // This project's law, applied: instructions do not route behaviour on this model,
    // structure does. An enum is something the harness can check; a free-form brief for an
    // improvised assistant is prose nobody validates.
    expect(delegateTool.validate({ role: 'anything I like', task: 'a task long enough' }).ok)
      .toBe(false)
    for (const name of ROLE_NAMES) {
      expect(delegateTool.validate({ role: name, task: 'find where the slug helper lives' }).ok)
        .toBe(true)
    }
    const schema = delegateTool.parameters as {
      properties: { role: { enum?: string[] } }
    }
    expect(schema.properties.role.enum).toEqual([...ROLE_NAMES])
  })

  test('a task too short to stand on its own is refused', () => {
    // The worker cannot see the caller's conversation. "fix it" reaches it as "fix it", and
    // a worker that has to guess what was meant spends its whole budget guessing.
    const v = delegateTool.validate({ role: 'investigate', task: 'fix it' })
    expect(v.ok).toBe(false)
    expect(v.ok === false && v.error).toContain('cannot see this conversation')
  })
})

describe('what comes back', () => {
  test('the answer, with what it cost in front of it', async () => {
    // Several steps and several seconds hide behind one call. Unreported, a delegate call
    // looks free next to a read_file — and the whole reason to have it is that it is not.
    const r = await call(
      { role: 'investigate', task: 'where does the slug helper live' },
      { delegate: async () => outcome() },
    )
    expect(r.ok).toBe(true)
    expect(r.content).toContain('3 steps')
    expect(r.content).toContain('4.8s')
    expect(r.content).toContain('src/slug.ts:14')
  })

  test('a worker that fell over costs a message, not the turn', async () => {
    const r = await call(
      { role: 'investigate', task: 'where does the slug helper live' },
      { delegate: async () => outcome({ text: '', problem: 'stopped: timeout' }) },
    )
    expect(r.ok).toBe(false)
    expect(r.content).toContain('timeout')
  })

  test('a worker that stopped early still hands over what it got, labelled', async () => {
    // Partial reading is worth more than nothing and worth less than an answer, so it comes
    // back marked. Unmarked, a truncated look at half the callers of a function reads
    // exactly like a complete one.
    const r = await call(
      { role: 'critique', task: 'look at the change to the slug helper and its callers' },
      { delegate: async () => outcome({ text: 'One caller looks wrong.', problem: 'stopped: max_steps' }) },
    )
    expect(r.ok).toBe(true)
    expect(r.content).toContain('One caller looks wrong.')
    expect(r.content).toContain('partial')
  })

  test('a host with no worker says so instead of failing', async () => {
    // The one-shot CLI and most tests have no model to run one with. Saying so lets the
    // caller do the reading itself, which is what it would have done anyway.
    const r = await call({ role: 'investigate', task: 'where does the slug helper live' })
    expect(r.ok).toBe(false)
    expect(r.content).toContain('do the reading yourself')
  })
})

describe('the tool as the registry sees it', () => {
  test('it is NOT in the default set, and that is measured rather than an oversight', () => {
    // A worker answers well — 16.6 s and 13.6 s, three steps each, both right. The caller
    // never asks for one: 0/2 where delegating was the sensible move, and 0/3 again with a
    // line in the system prompt telling it to. Meanwhile the schema renders at the front of
    // every prompt at ~1,020 tokens, on every request, for something never called.
    //
    // Asserted so that re-registering it is a deliberate act with a failing test in front of
    // it, rather than something that looks like wiring somebody forgot.
    expect(buildRegistry().schemas().map((s) => s.function.name)).not.toContain('delegate')
  })

  test('its permission key names the role and the job', () => {
    const key = delegateTool.permissionKey!({ role: 'investigate', task: 'find the slug helper' })
    expect(key.tool).toBe('delegate')
    expect(key.command).toContain('investigate')
    expect(key.command).toContain('slug')
  })
})

describe('a worker that could act', () => {
  test('is refused when nothing was passed to gate it', async () => {
    // The loaded gun this closes: `Agent` gates a call only when it HAS an engine — with
    // none there is no gate at all, not a strict one. Today every role is plan-mode, and
    // plan mode intersects the tool list with the read-only names, so the missing engine
    // cannot bite. That safety lived in the role table, which is the wrong place for it: a
    // role added with `mode: 'normal'` and a write tool would have written with no gate, no
    // approval and no rules, and nothing about adding it would have looked wrong.
    const acting = {
      name: 'implement', purpose: 'x', brief: 'x',
      tools: ['write_file'], mode: 'normal' as const, maxSteps: 4,
    }
    const out = await runSubAgent(
      { client: null as never, registry: null as never, workspace: new Workspace(root) },
      acting,
      'write something to a file in the workspace',
    )
    expect(out.problem).toContain('needs the permission engine')
    // Refused BEFORE anything ran: no client was even provided above, and a role that got
    // as far as building an Agent would have thrown on it.
    expect(out.steps).toBe(0)
    expect(out.text).toBe('')
  })

  test('every role that ships today is read-only, so the guard is not load-bearing yet', () => {
    // Both statements are asserted because they protect each other: the guard above is the
    // net, and this is the floor. Losing either silently would leave the other looking
    // sufficient.
    for (const role of ROLES) {
      expect(role.mode, `${role.name} should be plan mode`).toBe('plan')
      const registry = buildRegistry()
      for (const tool of role.tools) {
        expect(registry.readOnlyNames(), `${role.name} may not offer ${tool}`).toContain(tool)
      }
    }
  })
})
