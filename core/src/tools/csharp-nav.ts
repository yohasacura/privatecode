import { csharpRoot, navProcess, toWorkspacePath } from '../csharp/nav-process.js'
import type { Tool } from './types.js'

export interface CsharpNavArgs {
  action: 'definition' | 'references' | 'implementations' | 'members' | 'hierarchy' | 'errors'
  symbol: string
  limit?: number
}

const ACTIONS: readonly CsharpNavArgs['action'][] = ['definition', 'references', 'implementations', 'members', 'hierarchy', 'errors']

/** How many compile errors `errors` shows; the count says how many there were. */
const MAX_ERRORS_SHOWN = 30

/**
 * What a C# symbol IS, rather than where its name appears.
 *
 * This exists because of a measurement, not a wish. Over a 27-minute run on a real backend
 * the model prefilled 394k tokens and generated 29k — two thirds of the wall clock spent
 * re-ingesting context, most of it file contents read in order to work out what calls what.
 * `Grep` finds a string and `SymbolOutline` describes one file; neither can answer
 * "who calls this" without the model reading the callers and deciding for itself.
 *
 * One question here replaces that reading. Measured against the same project: `references`
 * on an interface returned the implementing class, the field that holds it, the constructor
 * that takes it and the line that registers it in DI — five files, as four lines.
 *
 * `readOnly`, and meant literally: it parses and answers. It is available in plan mode for
 * the same reason `Skill` is — understanding the code is most of what planning is.
 */
export const csharpNavTool: Tool<CsharpNavArgs> = {
  name: 'CSharpNav',
  readOnly: true,
  // Leads with the questions rather than the category, and names Roslyn. The old wording
  // opened with "answer a semantic question", never used the word, and argued only against
  // reading files -- so when the user asked for Roslyn by name the model had to reason its
  // way here from "CSharpNav (likely powered by Roslyn)". Naming the engine costs nothing:
  // the schema ships every turn regardless of what it says.
  description:
    'Answers "who calls this?", "what implements this?", "where is this defined?", "what ' +
    'does this type expose?", "what extends it?" and "does it compile?" for C#, from the ' +
    'compiler (Roslyn) rather than from text. Reach for it before opening a .cs file: one ' +
    'call replaces reading every file that mentions the name, it finds a class that inherits ' +
    'an implementation without naming it, and it tells a real use apart from a comment, a ' +
    'string, or a same-named member of another type. A definition comes with its source; a ' +
    'reference names the member it sits in; a name it does not know is answered with the ' +
    'closest ones, and `*` in a name matches by pattern. C# only — for other languages use Grep.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...ACTIONS],
        description:
          'definition = where it is declared, with its doc comment and its source. ' +
          'references = every use, each with the member it is in. ' +
          'implementations = classes implementing an interface, or overrides of a member. ' +
          'members = the public surface of a type. hierarchy = a type\'s base types, ' +
          'interfaces and everything that extends or implements it. errors = the compile ' +
          'errors the whole tree has now (symbol optional: a .cs path to check just that file).',
      },
      symbol: {
        type: 'string',
        description:
          'A type, method, property or field name. `Save`, `IInvoiceRepository.Save` and the ' +
          'fully qualified name all work; `*Repository` or `Get*Async` searches by pattern.',
      },
      limit: { type: 'number', description: 'Maximum rows for `references` and pattern searches (default 60).' },
    },
    required: ['action'],
  },
  validate(raw) {
    const r = raw as Partial<CsharpNavArgs>
    if (typeof r?.action !== 'string' || !ACTIONS.includes(r.action as CsharpNavArgs['action'])) {
      return { ok: false, error: `action must be one of: ${ACTIONS.join(', ')}` }
    }
    const symbol = typeof r.symbol === 'string' ? r.symbol.trim() : ''
    if (symbol === '' && r.action !== 'errors') {
      return { ok: false, error: 'symbol must be a non-empty name' }
    }
    const args: CsharpNavArgs = { action: r.action as CsharpNavArgs['action'], symbol }
    if (typeof r.limit === 'number' && Number.isFinite(r.limit) && r.limit > 0) {
      args.limit = Math.min(Math.floor(r.limit), 200)
    }
    return { ok: true, args }
  },
  permissionKey(args) {
    return { tool: 'CSharpNav', target: args.symbol }
  },
  async execute(args, ctx) {
    const nav = navProcess()
    if (nav === null) {
      return {
        ok: false,
        content:
          'C# navigation is not available in this build (the helper binary is not installed). ' +
          'Use Grep and SymbolOutline instead.',
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
    const rel = (p: unknown): string => (typeof p === 'string' ? toWorkspacePath(p, root) : '?')
    // The index's own caveat, carried through: a project that has never been built resolves
    // its own symbols and not its packages, and the model has to know which answer it got.
    const problems = Array.isArray(loaded['problems']) ? loaded['problems'] as string[] : []
    const caveat = problems.length > 0 ? `\n\nNote: ${problems.join(' ')}` : ''

    if (args.action === 'errors') {
      // A .cs path narrows the check to that file (synced from disk first); nothing given
      // binds the whole tree — the question is "does it compile now?".
      const files: string[] = []
      if (args.symbol !== '' && args.symbol.toLowerCase().endsWith('.cs')) {
        try {
          files.push(ctx.workspace.resolve(args.symbol))
        } catch (e) {
          return { ok: false, content: (e as Error).message }
        }
      }
      const result = await nav.diagnostics(root, files, { everything: files.length === 0 })
      if (result === null) return { ok: false, content: 'the compiler check could not run; use the project\'s build instead' }
      const where = files.length === 0 ? `${result.bound} of ${result.trees} files bound` : `${args.symbol} and what it touches, ${result.bound} files bound`
      const pre = result.baseline > 0
        ? ` ${result.suppressed} pre-existing error${result.suppressed === 1 ? '' : 's'} this compilation cannot resolve (source generators, packages) are not counted.`
        : ''
      if (result.reported === 0) {
        return { ok: true, content: `No compile errors — ${where}, ${(result.ms / 1000).toFixed(1)}s.${pre}${caveat}` }
      }
      const lines = result.errors.slice(0, MAX_ERRORS_SHOWN).map((e) =>
        `${e.file === '' ? '(no file)' : ctx.workspace.display(e.file)}:${e.line}:${e.column}: ${e.code} ${e.message}`)
      const more = result.reported > lines.length ? `\n… and ${result.reported - lines.length} more` : ''
      return {
        ok: true,
        content: `${result.reported} compile error${result.reported === 1 ? '' : 's'} — ${where}, ${(result.ms / 1000).toFixed(1)}s:\n${lines.join('\n')}${more}${pre}${caveat}`,
      }
    }

    // `*Repository` on a definition is a search by pattern: names the model only half knows.
    const op = args.action === 'definition' && args.symbol.includes('*') ? 'search' : args.action
    let reply: Record<string, unknown>
    try {
      reply = await nav.ask(op, {
        symbol: args.symbol,
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      })
    } catch (e) {
      return { ok: false, content: `${args.action} failed: ${(e as Error).message}` }
    }
    if (reply['ok'] !== true) {
      return { ok: false, content: `${args.action} failed: ${String(reply['error'] ?? 'unknown')}` }
    }

    const rows = Array.isArray(reply['results']) ? reply['results'] as Record<string, unknown>[] : []
    const note = typeof reply['note'] === 'string' ? reply['note'] : null
    const suggestions = Array.isArray(reply['suggestions']) ? reply['suggestions'] as Record<string, unknown>[] : []
    const locatedLine = (r: Record<string, unknown>): string => {
      const loc = (r['located'] ?? r) as Record<string, unknown>
      return `${rel(loc['file'])}:${String(loc['line'])}  ${String(r['signature'] ?? loc['name'])}`
    }
    if (rows.length === 0 && (args.action !== 'hierarchy' || reply['type'] === undefined)) {
      // Which folder was searched, when there is more than one. A bare "not found" over a
      // multi-folder workspace is the shape of a false denial: the model cannot tell "it is
      // not there" from "you looked in the wrong project".
      const where = ctx.workspace.multi ? ` in ${ctx.workspace.display(root)}` : ''
      const close = suggestions.length > 0
        ? `\nClose names:\n${suggestions.map((s) => `  ${locatedLine(s)}`).join('\n')}`
        : ''
      const hint = suggestions.length > 0
        ? ''
        : ' If it is not C#, or lives outside the folder that was indexed, use Grep instead.'
      return {
        ok: true,
        content: `${note ?? `No ${args.action} found for "${args.symbol}"${where}.`}${hint}${close}${caveat}`,
      }
    }

    const lines: string[] = []
    if (op === 'search') {
      for (const r of rows) lines.push(locatedLine(r))
    } else if (args.action === 'definition') {
      for (const r of rows) {
        lines.push(locatedLine(r))
        if (typeof r['docs'] === 'string' && r['docs'] !== '') lines.push(`    ${r['docs']}`)
        if (typeof r['source'] === 'string' && r['source'] !== '') {
          lines.push(...r['source'].split('\n').map((l) => `    ${l}`))
        }
      }
    } else if (args.action === 'references') {
      for (const r of rows) {
        const within = typeof r['in'] === 'string' && r['in'] !== '' ? `  [${r['in']}]` : ''
        lines.push(`${rel(r['file'])}:${String(r['line'])}${within}  ${String(r['text'])}`)
      }
    } else if (args.action === 'implementations') {
      for (const r of rows) {
        lines.push(`${rel(r['file'])}:${String(r['line'])}  ${String(r['name'])} (${String(r['containing'])})`)
      }
    } else if (args.action === 'hierarchy') {
      const type = (reply['type'] ?? {}) as Record<string, unknown>
      const bases = Array.isArray(reply['bases']) ? reply['bases'] as Record<string, unknown>[] : []
      const ifaces = Array.isArray(reply['interfaces']) ? reply['interfaces'] as Record<string, unknown>[] : []
      const flags = [reply['abstract'] === true ? 'abstract' : '', reply['sealed'] === true ? 'sealed' : ''].filter((f) => f !== '')
      lines.push(`${rel(type['file'])}:${String(type['line'])}  ${flags.length > 0 ? `${flags.join(' ')} ` : ''}${String(reply['kind'] ?? 'type')} ${String(type['name'])}`)
      lines.push(`  extends: ${bases.length === 0 ? 'nothing (object)' : bases.map((b) => `${String(b['name'])} (${rel(b['file'])}:${String(b['line'])})`).join(' → ')}`)
      lines.push(`  implements: ${ifaces.length === 0 ? 'nothing' : ifaces.map((i) => String(i['name'])).join(', ')}`)
      const external = typeof reply['external'] === 'number' ? reply['external'] : 0
      const verb = String(reply['kind']) === 'interface' ? 'implemented or extended by' : 'extended by'
      lines.push(`  ${verb}: ${rows.length === 0 ? 'nothing in this workspace' : ''}`)
      for (const r of rows) lines.push(`    ${rel(r['file'])}:${String(r['line'])}  ${String(r['name'])} (${String(r['containing'])})`)
      if (external > 0) lines.push(`    … and ${external} in referenced assemblies`)
    } else {
      const type = (reply['type'] ?? {}) as Record<string, unknown>
      const ifaces = Array.isArray(reply['interfaces']) ? reply['interfaces'] as string[] : []
      const base = typeof reply['baseType'] === 'string' && reply['baseType'] !== 'object' ? reply['baseType'] : null
      const heritage = [...(base !== null ? [base] : []), ...ifaces]
      lines.push(`${rel(type['file'])}:${String(type['line'])}  ${String(type['name'])}` +
        (heritage.length > 0 ? ` : ${heritage.join(', ')}` : ''))
      for (const r of rows) lines.push(`    :${String(r['line'])}  ${String(r['signature'])}`)
    }

    const truncated = typeof reply['truncated'] === 'number' ? reply['truncated'] : null
    const what = op === 'search' ? `names matching ${args.symbol}` : `${args.action} of ${args.symbol}`
    const count = args.action === 'hierarchy' ? '' : ` — ${rows.length} result${rows.length === 1 ? '' : 's'}`
    const header = `${what}${count}` +
      (truncated !== null ? ` (${truncated} more not shown; raise limit or narrow the symbol)` : '')
    return { ok: true, content: `${header}\n${lines.join('\n')}${caveat}` }
  },
}
