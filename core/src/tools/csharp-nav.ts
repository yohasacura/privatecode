import { readdirSync } from 'node:fs'
import { navProcess, toWorkspacePath } from '../csharp/nav-process.js'
import type { Tool } from './types.js'

/**
 * Which folder the C# index is built over.
 *
 * The helper takes ONE root, so a multi-folder workspace has to choose. The solution file is
 * the honest signal — a `.sln` or `.csproj` is what makes a folder a C# project — and the
 * primary folder is only the fallback for when nothing says otherwise, which is also the
 * single-folder case. Checked shallowly on purpose: a solution lives at the top of its
 * project, and walking every mount deeply on each call would cost more than the answer.
 */
function csharpRoot(workspace: { mounts: readonly { root: string }[]; root: string }): string {
  for (const mount of workspace.mounts) {
    let entries: string[]
    try {
      entries = readdirSync(mount.root)
    } catch {
      continue
    }
    if (entries.some((e) => e.toLowerCase().endsWith('.sln') || e.toLowerCase().endsWith('.csproj'))) {
      return mount.root
    }
  }
  return workspace.root
}

export interface CsharpNavArgs {
  action: 'definition' | 'references' | 'implementations' | 'members'
  symbol: string
  limit?: number
}

const ACTIONS: readonly CsharpNavArgs['action'][] = ['definition', 'references', 'implementations', 'members']

/**
 * What a C# symbol IS, rather than where its name appears.
 *
 * This exists because of a measurement, not a wish. Over a 27-minute run on a real backend
 * the model prefilled 394k tokens and generated 29k — two thirds of the wall clock spent
 * re-ingesting context, most of it file contents read in order to work out what calls what.
 * `search_code` finds a string and `symbol_outline` describes one file; neither can answer
 * "who calls this" without the model reading the callers and deciding for itself.
 *
 * One question here replaces that reading. Measured against the same project: `references`
 * on an interface returned the implementing class, the field that holds it, the constructor
 * that takes it and the line that registers it in DI — five files, as four lines.
 *
 * `readOnly`, and meant literally: it parses and answers. It is available in plan mode for
 * the same reason `use_skill` is — understanding the code is most of what planning is.
 */
export const csharpNavTool: Tool<CsharpNavArgs> = {
  name: 'csharp_nav',
  readOnly: true,
  // Leads with the questions rather than the category, and names Roslyn. The old wording
  // opened with "answer a semantic question", never used the word, and argued only against
  // reading files -- so when the user asked for Roslyn by name the model had to reason its
  // way here from "csharp_nav (likely powered by Roslyn)". Naming the engine costs nothing:
  // the schema ships every turn regardless of what it says.
  description:
    'Answers "who calls this?", "what implements this?", "where is this defined?" and "what ' +
    'does this type expose?" for C#, from the compiler (Roslyn) rather than from text. ' +
    'Reach for it before opening a .cs file: one call replaces reading every file that ' +
    'mentions the name, it finds a class that inherits an implementation without naming it, ' +
    'and it tells a real use apart from a comment, a string, or a same-named member of ' +
    'another type. C# only — for other languages use search_code.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...ACTIONS],
        description:
          'definition = where it is declared, with its doc comment. references = every use. ' +
          'implementations = classes implementing an interface, or overrides of a member. ' +
          'members = the public surface of a type.',
      },
      symbol: {
        type: 'string',
        description:
          'A type, method, property or field name. `Save`, `IInvoiceRepository.Save` and the ' +
          'fully qualified name all work.',
      },
      limit: { type: 'number', description: 'Maximum rows for `references` (default 60).' },
    },
    required: ['action', 'symbol'],
  },
  validate(raw) {
    const r = raw as Partial<CsharpNavArgs>
    if (typeof r?.action !== 'string' || !ACTIONS.includes(r.action as CsharpNavArgs['action'])) {
      return { ok: false, error: `action must be one of: ${ACTIONS.join(', ')}` }
    }
    if (typeof r.symbol !== 'string' || r.symbol.trim() === '') {
      return { ok: false, error: 'symbol must be a non-empty name' }
    }
    const args: CsharpNavArgs = { action: r.action as CsharpNavArgs['action'], symbol: r.symbol.trim() }
    if (typeof r.limit === 'number' && Number.isFinite(r.limit) && r.limit > 0) {
      args.limit = Math.min(Math.floor(r.limit), 200)
    }
    return { ok: true, args }
  },
  permissionKey(args) {
    return { tool: 'csharp_nav', target: args.symbol }
  },
  async execute(args, ctx) {
    const nav = navProcess()
    if (nav === null) {
      return {
        ok: false,
        content:
          'C# navigation is not available in this build (the helper binary is not installed). ' +
          'Use search_code and symbol_outline instead.',
      }
    }

    // The folder that actually holds the C#, not `mounts[0]`.
    //
    // `workspace.root` is the PRIMARY folder. With a primary that contains no C# (a web
    // front-end, say) and the solution in an attached one, the index was built over the
    // wrong tree and every question came back `ok: true` with `no symbol named "X"` — a
    // confident denial, stable for the whole session because the helper caches by root. The
    // rows it does return are relativised against the same root, so out-of-root hits came
    // back as raw absolute paths no other tool could address.
    const root = csharpRoot(ctx.workspace)
    let loaded: Record<string, unknown>
    try {
      loaded = await nav.ensureLoaded(root)
    } catch (e) {
      return { ok: false, content: `the C# index could not be built: ${(e as Error).message}` }
    }
    if (loaded['ok'] !== true) {
      return { ok: false, content: `the C# index could not be built: ${String(loaded['error'] ?? 'unknown')}` }
    }

    let reply: Record<string, unknown>
    try {
      reply = await nav.ask(args.action, {
        symbol: args.symbol,
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      })
    } catch (e) {
      return { ok: false, content: `${args.action} failed: ${(e as Error).message}` }
    }
    if (reply['ok'] !== true) {
      return { ok: false, content: `${args.action} failed: ${String(reply['error'] ?? 'unknown')}` }
    }

    const rel = (p: unknown): string =>
      typeof p === 'string' ? toWorkspacePath(p, root) : '?'
    const rows = Array.isArray(reply['results']) ? reply['results'] as Record<string, unknown>[] : []
    const note = typeof reply['note'] === 'string' ? reply['note'] : null
    if (rows.length === 0) {
      // Which folder was searched, when there is more than one. A bare "not found" over a
      // multi-folder workspace is the shape of a false denial: the model cannot tell "it is
      // not there" from "you looked in the wrong project".
      const where = ctx.workspace.multi ? ` in ${ctx.workspace.display(root)}` : ''
      return {
        ok: true,
        content: note ??
          `No ${args.action} found for "${args.symbol}"${where}. If it is not C#, or lives ` +
          'outside the folder that was indexed, use search_code instead.',
      }
    }

    const lines: string[] = []
    if (args.action === 'definition') {
      for (const r of rows) {
        const loc = (r['located'] ?? {}) as Record<string, unknown>
        lines.push(`${rel(loc['file'])}:${String(loc['line'])}  ${String(r['signature'])}`)
        if (typeof r['docs'] === 'string' && r['docs'] !== '') lines.push(`    ${r['docs']}`)
      }
    } else if (args.action === 'references') {
      for (const r of rows) lines.push(`${rel(r['file'])}:${String(r['line'])}  ${String(r['text'])}`)
    } else if (args.action === 'implementations') {
      for (const r of rows) {
        lines.push(`${rel(r['file'])}:${String(r['line'])}  ${String(r['name'])} (${String(r['containing'])})`)
      }
    } else {
      const type = (reply['type'] ?? {}) as Record<string, unknown>
      const ifaces = Array.isArray(reply['interfaces']) ? reply['interfaces'] as string[] : []
      lines.push(`${rel(type['file'])}:${String(type['line'])}  ${String(type['name'])}` +
        (ifaces.length > 0 ? ` : ${ifaces.join(', ')}` : ''))
      for (const r of rows) lines.push(`    :${String(r['line'])}  ${String(r['signature'])}`)
    }

    const truncated = typeof reply['truncated'] === 'number' ? reply['truncated'] : null
    const header = `${args.action} of ${args.symbol} — ${rows.length} result${rows.length === 1 ? '' : 's'}` +
      (truncated !== null ? ` (${truncated} more not shown; raise limit or narrow the symbol)` : '')
    // The index's own caveat, carried through: a project that has never been built resolves
    // its own symbols and not its packages, and the model has to know which answer it got.
    const problems = Array.isArray(loaded['problems']) ? loaded['problems'] as string[] : []
    const caveat = problems.length > 0 ? `\n\nNote: ${problems.join(' ')}` : ''
    return { ok: true, content: `${header}\n${lines.join('\n')}${caveat}` }
  },
}
