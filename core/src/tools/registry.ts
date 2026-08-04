import type { ToolSchema } from '../llama/types.js'
import type { Tool, ToolContext, ToolResult, Validation } from './types.js'

export type Prepared =
  | { ok: true; tool: Tool<any>; args: any }
  | { ok: false; content: string }

export class ToolRegistry {
  private readonly tools = new Map<string, Tool<any>>()

  register(tool: Tool<any>): void {
    if (this.tools.has(tool.name)) throw new Error(`tool already registered: ${tool.name}`)
    this.tools.set(tool.name, tool)
  }

  get(name: string): Tool<any> | undefined {
    return this.tools.get(name)
  }

  /** Every registered tool name, in registration order. */
  names(): string[] {
    return [...this.tools.keys()]
  }

  /**
   * Names of registered tools that declare `readOnly: true`. The sole basis `Agent` uses
   * to restrict plan mode: this reads the tools' own declarations rather than a parallel
   * list a caller has to keep in sync by hand.
   */
  readOnlyNames(): string[] {
    return [...this.tools.values()].filter((t) => t.readOnly).map((t) => t.name)
  }

  /**
   * Schemas to send to the model. Passing a subset is how modes are enforced: llama.cpp
   * builds its constraint grammar from exactly this list, so a tool that is not in it is
   * unreachable rather than merely discouraged.
   */
  schemas(names?: string[]): ToolSchema[] {
    const wanted = names ? names.filter((n) => this.tools.has(n)) : [...this.tools.keys()]
    return wanted.map((n) => {
      const t = this.tools.get(n)!
      return {
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }
    })
  }

  /**
   * Parse + validate a call without executing it; never throws. Split out of `run` so a
   * caller (the permission gate) can decide whether the call may proceed at all before
   * anything with a side effect happens — the tool is already resolved and its arguments
   * already validated by the time that decision is made, so approving it doesn't repeat
   * any of this work.
   */
  prepare(name: string, rawArgs: string): Prepared {
    const tool = this.tools.get(name)
    if (!tool) {
      return { ok: false, content: `Unknown tool "${name}".` }
    }
    let parsed: unknown
    try {
      parsed = rawArgs.trim() === '' ? {} : JSON.parse(rawArgs)
    } catch (e) {
      // Same shape as the other two catches in this function: interpolating `e` directly
      // renders "SyntaxError: ..." via toString, which is not what the other paths produce.
      return {
        ok: false,
        content: `Arguments for ${name} could not be parsed as JSON: ` +
          `${e instanceof Error ? e.message : String(e)}`,
      }
    }
    let validation: Validation<any>
    try {
      validation = tool.validate(parsed)
      if (!validation.ok) {
        return { ok: false, content: `Invalid arguments for ${name}: ${validation.error}` }
      }
    } catch (e) {
      return { ok: false, content: `Invalid arguments for ${name}: ${e instanceof Error ? e.message : String(e)}` }
    }
    return { ok: true, tool, args: validation.args }
  }

  /** Execute a Prepared that was ok; never throws. */
  async executePrepared(p: { tool: Tool<any>; args: any }, ctx: ToolContext): Promise<ToolResult> {
    try {
      return await p.tool.execute(p.args, ctx)
    } catch (e) {
      return { ok: false, content: `${p.tool.name} failed: ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  /** Never throws: a failure must reach the model as text it can act on. */
  async run(name: string, rawArgs: string, ctx: ToolContext): Promise<ToolResult> {
    const prepared = this.prepare(name, rawArgs)
    if (!prepared.ok) return { ok: false, content: prepared.content }
    return this.executePrepared(prepared, ctx)
  }
}
