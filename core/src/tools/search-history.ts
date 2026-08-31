import { searchSessionsDetailed, type SearchOptions } from '../host/session-search.js'
import { SessionStore } from '../session/store.js'
import type { Tool } from './types.js'

export interface SearchHistoryArgs {
  /** Absent means LIST rather than search — see the tool's doc comment. */
  query?: string
  regex?: boolean
  speaker?: 'user' | 'assistant' | 'any'
  scope?: 'this' | 'others' | 'all'
  since?: string
  until?: string
  include_tool_results?: boolean
  limit?: number
}

/** The period in words, for the one line a listing opens with. Ours, not the model's. */
function describePeriod(
  since: string | undefined, until: string | undefined, scope: 'this' | 'others' | 'all',
): string {
  const where = scope === 'this' ? 'This conversation'
    : scope === 'others' ? 'Other conversations'
      : 'Conversations'
  if (since !== undefined && until !== undefined) return `${where} from ${since} to ${until}`
  if (since !== undefined) return `${where} since ${since}`
  if (until !== undefined) return `${where} up to ${until}`
  // No dates at all: the caller wants "lately", which the limit already answers.
  return `${where}, the most recent`
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
 *
 * ============================================================================
 * WITHOUT A QUERY: LISTING
 * ============================================================================
 *
 * "What was I working on last Tuesday" is a question this could not answer, and the reason
 * is worth stating because it is the same mistake in a different place: a search needs a
 * word, and the whole point of asking about a DATE is that you have forgotten the word. The
 * owner asked for it in exactly those terms — *can I ask the agent to gather what I was
 * doing on certain dates* — and the honest answer was "only if you can guess a term that
 * appeared".
 *
 * So `query` is optional. Without one, the dates (and `scope`) select and the tool lists
 * what is there rather than searching inside it: one line per conversation, grouped by day.
 * That reads only the `.meta.json` files `list()` has already parsed — no transcript is
 * opened — so a listing over a month costs nothing, which is what makes it reasonable to
 * reach for before knowing whether there is anything to find.
 *
 * It is a different ANSWER, not a degraded search: a search says where a word appears, a
 * listing says what the days contained. The one thing it must not do is pretend to be the
 * other, so a listing says plainly that it did not look inside.
 */
export const searchHistoryTool: Tool<SearchHistoryArgs> = {
  name: 'search_history',
  readOnly: true,
  description:
    'Search past conversations in this workspace — what was said and decided, including ' +
    'earlier in THIS session after the middle of it has been compacted away. Returns the ' +
    'matching sessions with passages around each match, most-discussed first. Use it before ' +
    're-deriving something that was already worked out, and to answer "what did we decide ' +
    'about X". Searches what people said, not tool output, unless you ask for both. ' +
    'LEAVE query OUT to LIST conversations instead of searching them: with since/until and ' +
    'no query it returns what was worked on in that period, one line per conversation, ' +
    'grouped by day. That is the way to answer "what was I doing last Tuesday" or "what did ' +
    'I work on between these dates", where there is no word to search for.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'What to look for. A literal by default — the file name, the error string, the ' +
          'command that finally worked. OPTIONAL: leave it out to list the conversations ' +
          'in the period instead of searching inside them.',
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
        description:
          'Only sessions last touched on or after this date, as YYYY-MM-DD. With no query, ' +
          'this and until are what select the conversations to list.',
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
    required: [],
  },
  validate(raw) {
    const r = raw as Partial<SearchHistoryArgs>
    // An ABSENT query means "list"; an empty one means the model meant to search and had
    // nothing to search for. Told apart, because silently listing for the second would
    // answer a question that was not asked and look like it had been.
    if (r?.query !== undefined && (typeof r.query !== 'string' || r.query.trim() === '')) {
      return {
        ok: false,
        error: 'query must be a non-empty string, or left out entirely to list the ' +
          'conversations in a period instead of searching them',
      }
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
        ...(r.query !== undefined ? { query: r.query.trim() } : {}),
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

    // --- no query: list the period rather than search inside it ------------------------
    if (args.query === undefined) {
      const from = args.since !== undefined ? `${args.since}T00:00:00.000Z` : undefined
      const to = args.until !== undefined ? `${args.until}T23:59:59.999Z` : undefined
      const dated = inScope
        .filter((m) => (from === undefined || m.updatedAt >= from)
          && (to === undefined || m.updatedAt <= to))
      if (dated.length === 0) {
        return {
          ok: true,
          // The total is not padding. "Nothing that week" and "no history here at all" are
          // different answers, and a caller told only the first will go looking for a
          // workspace it is already in.
          content: `${describePeriod(args.since, args.until, scope)} — none. ` +
            `(${inScope.length} conversation${inScope.length === 1 ? '' : 's'} in this ` +
            'workspace overall.)',
        }
      }
      // The most recent `limit`, shown OLDEST FIRST. Both halves are deliberate: when a
      // period holds more than fits, the recent end is the half worth having, and once the
      // set is chosen a period reads forwards — it is being asked as "what happened", which
      // is a narrative, not a ranking.
      const sorted = [...dated].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      const shown = sorted.slice(-limit)
      const omitted = sorted.length - shown.length

      const byDay = new Map<string, typeof shown>()
      for (const m of shown) {
        const day = m.updatedAt.slice(0, 10)
        byDay.set(day, [...(byDay.get(day) ?? []), m])
      }
      const blocks = [...byDay.entries()].map(([day, ms]) => {
        const rows = ms.map((m) => {
          const here = m.id === ctx.sessionId ? ' — this conversation' : ''
          const mode = m.mode === 'normal' ? '' : ` [${m.mode}]`
          // The title is the person's own opening message, which is exactly what "what was
          // I doing" wants; `list()` has already read it, so this costs no I/O.
          return `  · ${m.title === '' ? '(untitled)' : m.title}${mode}${here}`
        })
        return `${day}\n${rows.join('\n')}`
      })

      const tail = omitted > 0
        ? `\n\n(${omitted} earlier conversation${omitted === 1 ? '' : 's'} in that period ` +
          'not shown — raise limit, or narrow the dates)'
        : ''
      return {
        ok: true,
        content:
          `${describePeriod(args.since, args.until, scope)}, ` +
          `${shown.length} conversation${shown.length === 1 ? '' : 's'}:\n\n` +
          `${blocks.join('\n\n')}${tail}\n\n` +
          // Said plainly: this is a different answer from a search, and a reader who thinks
          // it looked inside would take silence about a topic as evidence it never came up.
          'These are the conversations themselves, not their contents — nothing was read ' +
          'inside them. Search one of these dates with a query to see what was said.',
      }
    }

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
