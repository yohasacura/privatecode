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
  test('it is registered, and worth what it costs, because the prompt routes to it', () => {
    // This flipped twice, both times on a measurement. The model never picks delegate by
    // judgement — 0 calls across 72 in two real turns — so it was unregistered rather than
    // spend ~1,020 prompt tokens on something never called. Then the owner insisted the
    // wording was the problem, and it was: of five system-prompt framings, a rule mapping
    // request-shape to FIRST call went 8/12 with 0/3 false positives while judgement, role
    // and cost framings went 0/6 (spike/delegate-prompt-probe.mts). The tool and its prompt
    // paragraph now arrive together: `delegation:` in buildSystemPrompt is computed from
    // this registration.
    expect(buildRegistry().schemas().map((s) => s.function.name)).toContain('delegate')
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
      { client: null as never, registry: null as never, context: { workspace: new Workspace(root) } },
      acting,
      'write something to a file in the workspace',
    )
    expect(out.problem).toContain('needs the permission engine')
    // Refused BEFORE anything ran: no client was even provided above, and a role that got
    // as far as building an Agent would have thrown on it.
    expect(out.steps).toBe(0)
    expect(out.text).toBe('')
  })

  test('a role is either narrowed to reading, or full-capability and therefore gated', () => {
    // Two shapes ship, and the invariant is that there is no third.
    //
    //   narrowed     plan mode, and every tool it names is read-only. Its job is to ANSWER,
    //                and a worker that could edit would be a second writer nobody asked for
    //   full         no `tools` and no `mode`: exactly what the caller has, trusted exactly
    //                as much. `runSubAgent` refuses to build one without the permission
    //                engine, so it cannot become an ungated writer by omission
    //
    // What this rules out is the middle: a role that names write tools AND a mode, which
    // would look deliberate and be ungated the moment somebody built it with the old deps.
    const registry = buildRegistry()
    for (const role of ROLES) {
      if (role.tools === undefined) {
        expect(role.mode, `${role.name} takes the caller's tools, so it must take its mode`)
          .toBeUndefined()
        continue
      }
      expect(role.mode, `${role.name} names its tools, so it must name plan mode`).toBe('plan')
      for (const tool of role.tools) {
        expect(registry.readOnlyNames(), `${role.name} may not offer ${tool}`).toContain(tool)
      }
    }
  })

  test('the full-capability role is refused when there is no engine to gate it', async () => {
    // Named rather than generic: `work` is the one that can write, and the guard existing is
    // no use if it stops applying to the role it was written for.
    const work = ROLES.find((r) => r.name === 'work')
    expect(work, 'a full-capability role should ship').toBeDefined()
    const out = await runSubAgent(
      { client: null as never, registry: null as never, context: { workspace: new Workspace(root) } },
      { ...work!, mode: 'normal' },
      'change something in the workspace and check it still builds',
    )
    expect(out.problem).toContain('needs the permission engine')
    expect(out.steps).toBe(0)
  })
})
