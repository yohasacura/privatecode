import { searchSessionsDetailed, type SearchOptions } from '../host/session-search.js'
import { SessionStore } from '../session/store.js'
import type { Tool } from './types.js'

export interface SearchHistoryArgs {
  query: string
  regex?: boolean
  speaker?: 'user' | 'assistant' | 'any'
  scope?: 'this' | 'others' | 'all'
  since?: string
  until?: string
  include_tool_results?: boolean
  limit?: number
}

/**
 * Searching the conversations themselves — the one thing that genuinely does not fit.
 *
 * Everything else the model wanted for "working with context" already existed: the plan is
 * `todo_write`, the notes are in message 0 and readable with `recall`, summarising is what
 * compaction does on its own, snapshots are checkpoints. This was the gap, and it is a real
 * one for two different reasons. Inside one session, compaction eventually replaces the
 * middle of the conversation with a summary, so "what did we decide about X twenty steps
 * ago" becomes unanswerable from context alone. Across sessions, yesterday's reasoning was
 * never in this context at all.
 *
 * Not a RAG, deliberately. The engine underneath is a substring scan over the stored
 * transcripts (`host/session-search.ts`) — a few hundred sessions is milliseconds, and an
 * embedding store would be a second model on a card with a gigabyte spare, indexing a
 * corpus to hand back a subset of what a scan already returns exactly.
 *
 * The parameters are the several ways the same scan gets asked. Each answers a question the
 * others cannot: `speaker` separates "where did I ask for this" from "where did I explain
 * it"; `scope` separates this conversation's forgotten middle from every other session;
 * `regex` reaches shapes a literal cannot; the dates cut the search to when you remember it
 * happening; `include_tool_results` opens the half that is deliberately shut.
 */
export const searchHistoryTool: Tool<SearchHistoryArgs> = {
  name: 'search_history',
  readOnly: true,
  description:
    'Search past conversations in this workspace — what was said and decided, including ' +
    'earlier in THIS session after the middle of it has been compacted away. Returns the ' +
    'matching sessions with passages around each match, most-discussed first. Use it before ' +
    're-deriving something that was already worked out, and to answer "what did we decide ' +
    'about X". Searches what people said, not tool output, unless you ask for both.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'What to look for. A literal by default — the file name, the error string, the ' +
          'command that finally worked.',
      },
      regex: {
        type: 'boolean',
        description:
          'Treat the query as a regular expression instead of a literal. Case-insensitive ' +
          'either way. Use it for shapes rather than words, e.g. "verify.*timeout".',
      },
      speaker: {
        type: 'string',
        enum: ['user', 'assistant', 'any'],
        description:
          'Whose words to search. "user" finds where something was ASKED for, "assistant" ' +
          'where it was explained or decided. Default: any.',
      },
      scope: {
        type: 'string',
        enum: ['this', 'others', 'all'],
        description:
          'Which conversations. "this" is the one you are in — use it to recover the part ' +
          'of it that compaction has already summarised away. "others" excludes it, for ' +
          '"where did I do this before". Default: all.',
      },
      since: {
        type: 'string',
        description: 'Only sessions last touched on or after this date, as YYYY-MM-DD.',
      },
      until: {
        type: 'string',
        description: 'Only sessions last touched on or before this date, as YYYY-MM-DD.',
      },
      include_tool_results: {
        type: 'boolean',
        description:
          'Also search tool OUTPUT — command output, file listings, diffs. Off by default ' +
          'because output is most of a transcript by volume and a common word then matches ' +
          'every session ever. Turn it on to find which session ran a command or saw an error.',
      },
      limit: {
        type: 'number',
        description: 'How many sessions to return. Default 8, maximum 30.',
      },
    },
    required: ['query'],
  },
  validate(raw) {
    const r = raw as Partial<SearchHistoryArgs>
    if (typeof r?.query !== 'string' || r.query.trim() === '') {
      return { ok: false, error: 'query must be a non-empty string' }
    }
    for (const key of ['since', 'until'] as const) {
      const v = r[key]
      // Checked here rather than passed through, because a date the model spelled wrong
      // would otherwise compare as a plain string and silently return nothing at all — a
      // wrong answer wearing the shape of a right one.
      if (v !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        return { ok: false, error: `${key} must be a date as YYYY-MM-DD, not "${String(v)}"` }
      }
    }
    if (r.speaker !== undefined && !['user', 'assistant', 'any'].includes(r.speaker)) {
      return { ok: false, error: 'speaker must be user, assistant or any' }
    }
    if (r.scope !== undefined && !['this', 'others', 'all'].includes(r.scope)) {
      return { ok: false, error: 'scope must be this, others or all' }
    }
    return {
      ok: true,
      args: {
        query: r.query.trim(),
        ...(r.regex !== undefined ? { regex: r.regex } : {}),
        ...(r.speaker !== undefined ? { speaker: r.speaker } : {}),
        ...(r.scope !== undefined ? { scope: r.scope } : {}),
        ...(r.since !== undefined ? { since: r.since } : {}),
        ...(r.until !== undefined ? { until: r.until } : {}),
        ...(r.include_tool_results !== undefined
          ? { include_tool_results: r.include_tool_results } : {}),
        ...(typeof r.limit === 'number' ? { limit: r.limit } : {}),
      },
    }
  },
  async execute(args, ctx) {
    const root = ctx.workspace.root
    const metas = new SessionStore(root).list()
    const scope = args.scope ?? 'all'

    if (scope !== 'all' && ctx.sessionId === undefined) {
      return {
        ok: false,
        content:
          'This caller does not know which session it is in, so "this" and "others" cannot ' +
          'be told apart. Search with scope "all".',
      }
    }
    const inScope = metas.filter((m) => (
      scope === 'this' ? m.id === ctx.sessionId
        : scope === 'others' ? m.id !== ctx.sessionId
          : true
    ))
    if (inScope.length === 0) {
      return { ok: true, content: 'There are no conversations in that scope to search.' }
    }

    const limit = Math.min(Math.max(args.limit ?? 8, 1), 30)
    const options: SearchOptions = {
      // Several passages and a wider window than the picker's: the caller is not choosing a
      // row to click, it is trying to remember what was decided, and a collapsed
      // 120-character line rarely carries a decision.
      snippets: 3,
      context: 200,
      ...(args.regex !== undefined ? { regex: args.regex } : {}),
      ...(args.speaker !== undefined ? { speaker: args.speaker } : {}),
      // Compared against `updatedAt`, which is a full ISO timestamp — a bare date would
      // sort before every time on that same day, so `until` is pushed to its end.
      ...(args.since !== undefined ? { since: `${args.since}T00:00:00.000Z` } : {}),
      ...(args.until !== undefined ? { until: `${args.until}T23:59:59.999Z` } : {}),
      ...(args.include_tool_results !== undefined
        ? { includeToolResults: args.include_tool_results } : {}),
    }

    const { hits, problem } = searchSessionsDetailed(root, inScope, args.query, limit, options)
    const caveat = problem !== undefined ? `\n\n(${problem})` : ''

    if (hits.length === 0) {
      return {
        ok: true,
        content:
          `Nothing in ${inScope.length} conversation${inScope.length === 1 ? '' : 's'} matches ` +
          `${args.regex === true ? 'the pattern' : ''} "${args.query}".${caveat}`,
      }
    }

    const blocks = hits.map((h) => {
      const here = h.sessionId === ctx.sessionId ? ' — this conversation' : ''
      const times = `${h.count} ${h.count === 1 ? 'mention' : 'mentions'}`
      const passages = h.snippets.map((s) => `  · ${s}`).join('\n')
      return `${h.title}${here}\n  ${h.updatedAt.slice(0, 10)}, ${times}\n${passages}`
    })
    return { ok: true, content: `${blocks.join('\n\n')}${caveat}` }
  },
}
