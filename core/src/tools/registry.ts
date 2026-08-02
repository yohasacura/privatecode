import type { ToolSchema } from '../llama/types.js'
import type { Tool, ToolContext, ToolResult, Validation } from './types.js'

export class ToolRegistry {
  private readonly tools = new Map<string, Tool<any>>()

  register(tool: Tool<any>): void {
    if (this.tools.has(tool.name)) throw new Error(`tool already registered: ${tool.name}`)
    this.tools.set(tool.name, tool)
  }

  get(name: string): Tool<any> | undefined {
    return this.tools.get(name)
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

  /** Never throws: a failure must reach the model as text it can act on. */
  async run(name: string, rawArgs: string, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) {
      return { ok: false, content: `Unknown tool "${name}".` }
    }
    let parsed: unknown
    try {
      parsed = rawArgs.trim() === '' ? {} : JSON.parse(rawArgs)
    } catch (e) {
      return { ok: false, content: `Arguments for ${name} could not be parsed as JSON: ${e}` }
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
    try {
      return await tool.execute(validation.args, ctx)
    } catch (e) {
      return { ok: false, content: `${name} failed: ${e instanceof Error ? e.message : String(e)}` }
    }
  }
}
