import { afterAll, beforeAll, expect, test } from 'vitest'
import { ToolRegistry } from '../src/tools/registry.js'
import type { Tool } from '../src/tools/types.js'
import { Workspace } from '../src/workspace.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Created in a hook, not at module scope: at module scope there is no hook that owns it,
// and this file leaked one `pc-reg-*` directory into %TEMP% per run — 23 had accumulated.
// Nothing here actually touches the filesystem; the workspace exists only because
// ToolContext requires one.
let root: string
let ctx: { workspace: Workspace }

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-reg-'))
  ctx = { workspace: new Workspace(root) }
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const echo: Tool<{ text: string }> = {
  name: 'echo',
  readOnly: true,
  description: 'Echo text back.',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  validate(raw) {
    const r = raw as { text?: unknown }
    if (typeof r?.text !== 'string' || r.text.trim() === '') {
      return { ok: false, error: 'text must be a non-empty string' }
    }
    return { ok: true, args: { text: r.text } }
  },
  async execute(args) {
    return { ok: true, content: args.text }
  },
}

test('emits OpenAI-shaped schemas', () => {
  const reg = new ToolRegistry()
  reg.register(echo)
  expect(reg.schemas()).toEqual([{
    type: 'function',
    function: { name: 'echo', description: 'Echo text back.', parameters: echo.parameters },
  }])
})

// Plan mode works by handing the model a smaller tool list; nothing else enforces it.
test('can emit a subset of schemas', () => {
  const reg = new ToolRegistry()
  reg.register(echo)
  reg.register({ ...echo, name: 'echo2' })
  expect(reg.schemas(['echo2']).map((s) => s.function.name)).toEqual(['echo2'])
})

// readOnlyNames() is the sole basis Agent uses to derive plan mode's tool list, so it
// must reflect exactly what each tool declares about itself, not registration order or
// count.
test('readOnlyNames reports only tools that declare readOnly: true', () => {
  const reg = new ToolRegistry()
  reg.register(echo)
  reg.register({ ...echo, name: 'writer', readOnly: false })
  reg.register({ ...echo, name: 'echo2' })
  expect(reg.readOnlyNames().sort()).toEqual(['echo', 'echo2'])
})

test('runs a valid call', async () => {
  const reg = new ToolRegistry()
  reg.register(echo)
  const out = await reg.run('echo', '{"text":"hi"}', ctx)
  expect(out).toEqual({ ok: true, content: 'hi' })
})

// Schema-valid but meaningless arguments were observed in 2 of 5 runs.
test('rejects semantically empty arguments with a usable message', async () => {
  const reg = new ToolRegistry()
  reg.register(echo)
  const out = await reg.run('echo', '{"text":"   "}', ctx)
  expect(out.ok).toBe(false)
  expect(out.content).toMatch(/non-empty string/)
})

test('reports unparseable argument JSON without throwing', async () => {
  const reg = new ToolRegistry()
  reg.register(echo)
  const out = await reg.run('echo', '{not json', ctx)
  expect(out.ok).toBe(false)
  expect(out.content).toMatch(/could not be parsed/i)
})

test('reports an unknown tool without throwing', async () => {
  const reg = new ToolRegistry()
  const out = await reg.run('nope', '{}', ctx)
  expect(out.ok).toBe(false)
  expect(out.content).toMatch(/unknown tool/i)
})

test('converts a throwing validate() to a failed ToolResult', async () => {
  const reg = new ToolRegistry()
  const throwingTool: Tool<{ value: string }> = {
    name: 'thrower',
    readOnly: true,
    description: 'A tool whose validate() throws.',
    parameters: { type: 'object', properties: { value: { type: 'string' } } },
    validate(raw) {
      // Simulate the defect: accessing a field without checking it exists first.
      // If the model omits 'options', this dereferences undefined and throws.
      const r = raw as { options?: { flags?: string[] } }
      const flagCount = r.options!.flags!.length // throws: Cannot read properties of undefined
      if (flagCount === 0) {
        return { ok: false, error: 'at least one flag required' }
      }
      return { ok: true, args: { value: String(flagCount) } }
    },
    async execute(args) {
      return { ok: true, content: args.value }
    },
  }
  reg.register(throwingTool)
  // The model sends arguments that omit 'options', triggering the throw.
  const out = await reg.run('thrower', '{}', ctx)
  // Must resolve (not reject) with a failed ToolResult.
  expect(out.ok).toBe(false)
  // Message should name the tool and indicate invalid arguments.
  expect(out.content).toMatch(/invalid arguments for thrower/i)
})

test('handles validate() returning undefined without throwing', async () => {
  const reg = new ToolRegistry()
  // This tool's validate() can return undefined on one branch, simulating the defect
  // where a missing return statement causes the function to fall through.
  const undefinedReturnerTool = {
    name: 'undefReturner',
    readOnly: true,
    description: 'A tool whose validate() returns undefined on one branch.',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    validate(raw: unknown) {
      const r = raw as { text?: unknown }
      if (typeof r?.text === 'string' && r.text.trim() !== '') {
        return { ok: true, args: { text: r.text } }
      }
      // BUG: missing return statement on error branch, falls through to undefined
    },
    async execute(args: { text: string }) {
      return { ok: true, content: args.text }
    },
  } as Tool<{ text: string }>
  reg.register(undefinedReturnerTool)
  // Call with invalid arguments to trigger the missing return.
  const out = await reg.run('undefReturner', '{}', ctx)
  // Must resolve (not reject) with a failed ToolResult, not throw TypeError on .ok access.
  expect(out.ok).toBe(false)
  // Message should name the tool and indicate invalid arguments.
  expect(out.content).toMatch(/invalid arguments for undefReturner/i)
})
