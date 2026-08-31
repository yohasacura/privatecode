import { readStoredSession } from '../host/session-read.js'
import { searchSessionsDetailed, type SearchOptions } from '../host/session-search.js'
import { splitUserMessage } from '../host/replay.js'
import { SessionStore, type SessionMeta } from '../session/store.js'
import type { Tool } from './types.js'

export interface SessionsArgs {
  action: 'list' | 'search' | 'read'
  query?: string
  id?: string
  regex?: boolean
  speaker?: 'user' | 'assistant' | 'any'
  scope?: 'this' | 'others' | 'all'
  since?: string
  until?: string
  include_tool_results?: boolean
  limit?: number
}

/**
 * The stored conversations, as three named things you can do with them.
 *
 * This replaces `search_history`, and the reason is a measured failure rather than tidiness.
 *
 * ============================================================================
 * WHY AN ACTION AND NOT AN ABSENT PARAMETER
 * ============================================================================
 *
 * `search_history` grew a second mode: leave `query` out and it lists a period instead of
 * searching inside it. That was the right ANSWER and the wrong STRUCTURE, and the first real
 * use proved it. Asked "give me a short description of what we did in all the past
 * sessions", the model searched seven guessed words in a row — `что делали`, `session`,
 * `project`, `Task`, `изучали`, `создали` — none of which could match, because the question
 * contained no word to search for. It then reported ONE past session where there were
 * three, and said so with confidence.
 *
 * The listing mode was in the description. It was read and it did not route, which is this
 * project's own measurement (0 of 703) arriving on schedule. A mode you enter by OMITTING an
 * argument is invisible in a schema: there is nothing to see, and nothing that fails if you
 * do not see it.
 *
 * So the mode is an enum member. `action` is required, its three values are in the schema
 * where the model reads the arguments rather than in prose it read twenty thousand tokens
 * earlier, and asking for a search with no query is now a validation error that says what to
 * do instead — the wrong thing made inexpressible rather than discouraged, which is the only
 * lever this codebase has found that works.
 *
 * ============================================================================
 * READ, WHICH DID NOT EXIST
 * ============================================================================
 *
 * The other half of that failure: having got three titles, the model had no way to OPEN one.
 * There was no operation that returns a past conversation, so the only route to "what
 * happened in that session" was to guess words that might be inside it — which is how a
 * question with a known answer became six guesses and a wrong summary.
 *
 * `read` is that operation. It goes through `readStoredSession`, so it sees exactly what the
 * diagnosis sees — the swap's re-appended tails removed — because a person reading their own
 * history and the report about it disagreeing on what happened would be the worst available
 * bug in a tool built to be trusted.
 */

/** Everything printed as a label here is written in this file. */
const ROLE_LABEL: Record<string, string> = {
  user: 'you  ',
  assistant: 'model',
  tool: '     ',
  system: 'setup',
}

/** How much of one message survives into a `read`. Long enough for a decision, short enough
 * that one pasted file does not become the whole answer. */
const MESSAGE_CLIP = 1200
/** The whole rendered conversation's budget, before head-and-tail clipping. */
const READ_BUDGET = 14_000

function clip(text: string, max: number): string {
  const t = text.trim()
  return t.length <= max ? t : `${t.slice(0, max)}\n      … (${t.length - max} more characters)`
}

/**
 * The day a conversation belongs to, in the PERSON'S timezone — not UTC.
 *
 * `updatedAt` is an ISO instant, and slicing ten characters off it gives the UTC day. That
 * is wrong for the one question this tool exists to answer. Measured on the owner's own
 * history: a session worked on at 00:20 on the 29th was stored as `...T21:20Z` on the 28th
 * and listed under the 28th, while its id — which is stamped in local time — said the 29th.
 * "What was I doing on the 29th" would have answered with the wrong day's work, and the id
 * sitting next to the date would have said so.
 *
 * The sidecar runs on the same machine as the person, so local IS their timezone. Used for
 * grouping AND for `since`/`until`, so the two cannot mean different things — the filter
 * and the heading disagreeing about which day a conversation is on is the same defect a
 * second time.
 */
function localDay(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** The period in words, for the line a listing opens with. */
function describePeriod(
  since: string | undefined, until: string | undefined, scope: 'this' | 'others' | 'all',
): string {
  const where = scope === 'this' ? 'This conversation'
    : scope === 'others' ? 'Other conversations'
      : 'Conversations'
  if (since !== undefined && until !== undefined) return `${where} from ${since} to ${until}`
  if (since !== undefined) return `${where} since ${since}`
  if (until !== undefined) return `${where} up to ${until}`
  return `${where}, the most recent`
}

function inScopeOf(
  metas: readonly SessionMeta[], scope: 'this' | 'others' | 'all', sessionId: string | undefined,
): SessionMeta[] {
  return metas.filter((m) => (
    scope === 'this' ? m.id === sessionId : scope === 'others' ? m.id !== sessionId : true
  ))
}

/** Plain date-string comparison on the LOCAL day, which is what the caller meant. */
function withinDates(
  metas: readonly SessionMeta[], since: string | undefined, until: string | undefined,
): SessionMeta[] {
  return metas.filter((m) => {
    const day = localDay(m.updatedAt)
    return (since === undefined || day >= since) && (until === undefined || day <= until)
  })
}

export const sessionsTool: Tool<SessionsArgs> = {
  name: 'sessions',
  readOnly: true,
  description:
    'The stored conversations in this workspace — your own history and the person\'s. Three ' +
    'actions. LIST: what conversations exist, one line each with an id, grouped by day; ' +
    'optionally narrowed by date. This is what answers "what have we worked on" and "what ' +
    'was I doing last Tuesday", where there is no word to search for. READ: open one ' +
    'conversation by its id and see what was actually said in it. SEARCH: find where ' +
    'something was said across conversations, with passages around each match — including ' +
    'earlier in THIS session, after compaction has summarised its middle away. Reach for ' +
    'list-then-read when the question is about a time, and search when it is about a topic; ' +
    'guessing words and finding none does not mean nothing happened.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'search', 'read'],
        description:
          '"list" for what conversations exist (no query needed), "read" for one ' +
          'conversation in full (needs id), "search" for where a word appears (needs query).',
      },
      query: {
        type: 'string',
        description:
          'search only. What to look for — a literal by default: the file name, the error ' +
          'string, the command that finally worked.',
      },
      id: {
        type: 'string',
        description: 'read only. The conversation id, as returned by list or search.',
      },
      regex: {
        type: 'boolean',
        description:
          'search only. Treat the query as a regular expression. Case-insensitive either ' +
          'way. Use it for shapes rather than words, e.g. "verify.*timeout".',
      },
      speaker: {
        type: 'string',
        enum: ['user', 'assistant', 'any'],
        description:
          'search only. Whose words. "user" finds where something was ASKED for, ' +
          '"assistant" where it was explained or decided. Default: any.',
      },
      scope: {
        type: 'string',
        enum: ['this', 'others', 'all'],
        description:
          'list and search. "this" is the conversation you are in — use it to recover the ' +
          'part of it compaction has summarised away. "others" excludes it. Default: all.',
      },
      since: {
        type: 'string',
        description: 'list and search. Only conversations last touched on or after this ' +
          'date, as YYYY-MM-DD.',
      },
      until: {
        type: 'string',
        description: 'list and search. Only conversations last touched on or before this ' +
          'date, as YYYY-MM-DD.',
      },
      include_tool_results: {
        type: 'boolean',
        description:
          'search and read. Also take in tool OUTPUT — command output, file listings, ' +
          'diffs. Off by default because output is most of a transcript by volume: in ' +
          'search a common word then matches everything, and in read it buries what was ' +
          'said under what was printed. Turn it on to find which session saw an error.',
      },
      limit: {
        type: 'number',
        description: 'list and search. How many conversations. Default 8, maximum 30.',
      },
    },
    required: ['action'],
  },
  validate(raw) {
    const r = raw as Partial<SessionsArgs>
    if (r?.action !== 'list' && r?.action !== 'search' && r?.action !== 'read') {
      return { ok: false, error: 'action must be one of: list, search, read' }
    }
    // Each action's own requirement, refused by NAME with the alternative attached. The
    // whole point of the enum is that a wrong call fails here, saying what to do, rather
    // than succeeding at something else.
    if (r.action === 'search' && (typeof r.query !== 'string' || r.query.trim() === '')) {
      return {
        ok: false,
        error: 'search needs a query. If there is no word to search for — a question about ' +
          'a date, or about what has been worked on — use action "list" instead.',
      }
    }
    if (r.action === 'read' && (typeof r.id !== 'string' || r.id.trim() === '')) {
      return {
        ok: false,
        error: 'read needs the id of one conversation. Use action "list" to get ids.',
      }
    }
    if (r.action !== 'search' && r.query !== undefined) {
      return {
        ok: false,
        error: `query only applies to action "search"; "${r.action}" ignores it, so it was ` +
          'refused rather than silently dropped',
      }
    }
    for (const key of ['since', 'until'] as const) {
      const v = r[key]
      // Checked rather than passed through: a date spelled wrong compares as a plain string
      // and selects nothing at all — a wrong answer wearing the shape of a right one.
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
        action: r.action,
        ...(r.query !== undefined ? { query: r.query.trim() } : {}),
        ...(r.id !== undefined ? { id: r.id.trim() } : {}),
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
        content: 'This caller does not know which conversation it is in, so "this" and ' +
          '"others" cannot be told apart. Use scope "all".',
      }
    }
    const inScope = inScopeOf(metas, scope, ctx.sessionId)
    const limit = Math.min(Math.max(args.limit ?? 8, 1), 30)

    // --- read ---------------------------------------------------------------------------
    if (args.action === 'read') {
      const meta = metas.find((m) => m.id === args.id)
      if (meta === undefined) {
        return {
          ok: false,
          content: `No conversation here has that id. There ${metas.length === 1 ? 'is' : 'are'} ` +
            `${metas.length}; use action "list" to see them with their ids.`,
        }
      }
      return { ok: true, content: renderRead(root, meta, args, ctx.sessionId) }
    }

    // --- list ---------------------------------------------------------------------------
    if (args.action === 'list') {
      const dated = withinDates(inScope, args.since, args.until)
      if (dated.length === 0) {
        return {
          ok: true,
          // "Nothing that week" and "no history here at all" are different answers, and a
          // caller told only the first goes looking for a workspace it is already in.
          content: `${describePeriod(args.since, args.until, scope)} — none. ` +
            `(${inScope.length} conversation${inScope.length === 1 ? '' : 's'} in this ` +
            'workspace overall.)',
        }
      }
      // The most recent `limit`, shown OLDEST FIRST: when a period holds more than fits the
      // recent end is the half worth having, and once the set is chosen a period reads
      // forwards — it is asked as "what happened", a narrative rather than a ranking.
      const sorted = [...dated].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      const shown = sorted.slice(-limit)
      const omitted = sorted.length - shown.length

      const byDay = new Map<string, SessionMeta[]>()
      for (const m of shown) {
        const day = localDay(m.updatedAt)
        byDay.set(day, [...(byDay.get(day) ?? []), m])
      }
      const blocks = [...byDay.entries()].map(([day, ms]) => {
        const rows = ms.map((m) => {
          const here = m.id === ctx.sessionId ? '  ← this conversation' : ''
          const mode = m.mode === 'normal' ? '' : ` [${m.mode}]`
          return `  ${m.id}  ${m.title === '' ? '(untitled)' : m.title}${mode}${here}`
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
          'Titles only — nothing was read inside them. Use action "read" with an id above ' +
          'to see what was actually said.',
      }
    }

    // --- search -------------------------------------------------------------------------
    if (inScope.length === 0) {
      return { ok: true, content: 'There are no conversations in that scope to search.' }
    }
    const options: SearchOptions = {
      // Several passages and a wide window: the caller is not choosing a row to click, it is
      // trying to remember what was decided, and a collapsed line rarely carries a decision.
      snippets: 3,
      context: 200,
      ...(args.regex !== undefined ? { regex: args.regex } : {}),
      ...(args.speaker !== undefined ? { speaker: args.speaker } : {}),
      ...(args.include_tool_results !== undefined
        ? { includeToolResults: args.include_tool_results } : {}),
    }
    // Dated HERE rather than by the search engine, which compares ISO instants. Both actions
    // then mean the same thing by a date — the person's own day — and "list 29 August" and
    // "search 29 August" cannot return conversations from different sets.
    const { hits, problem } = searchSessionsDetailed(
      root, withinDates(inScope, args.since, args.until), args.query ?? '', limit, options,
    )
    const caveat = problem !== undefined ? `\n\n(${problem})` : ''

    if (hits.length === 0) {
      // The way out, said at the moment of failure rather than only in a description read
      // twenty thousand tokens ago. Seven fruitless searches in a row is what this exists
      // to end, and the seventh had exactly as much reason to stop as the first.
      return {
        ok: true,
        content:
          `Nothing in ${inScope.length} conversation${inScope.length === 1 ? '' : 's'} ` +
          `matches ${args.regex === true ? 'the pattern' : ''} "${args.query}".${caveat}\n\n` +
          'Finding nothing is not evidence that nothing happened — the word may simply not ' +
          `be the one used. Try action "list" to see the ${inScope.length} ` +
          `conversation${inScope.length === 1 ? '' : 's'} and "read" one of them.`,
      }
    }
    const blocks = hits.map((h) => {
      const here = h.sessionId === ctx.sessionId ? ' — this conversation' : ''
      const times = `${h.count} ${h.count === 1 ? 'mention' : 'mentions'}`
      const passages = h.snippets.map((s) => `  · ${s}`).join('\n')
      return `${h.sessionId}  ${h.title}${here}\n  ${h.updatedAt.slice(0, 10)}, ${times}\n${passages}`
    })
    return {
      ok: true,
      content: `${blocks.join('\n\n')}${caveat}\n\nUse action "read" with one of those ids ` +
        'to see the whole conversation.',
    }
  },
}

/**
 * One conversation as something a person can read.
 *
 * Tool RESULTS are left out by default and the calls are kept: what the model asked for is
 * the story, what came back is the evidence, and the evidence is most of a transcript by
 * volume. A session that reads as forty file listings with three sentences between them
 * answers "what happened here" worse than one that reads as the three sentences.
 */
function renderRead(
  root: string, meta: SessionMeta, args: SessionsArgs, currentId: string | undefined,
): string {
  const stored = readStoredSession(root, meta.id)
  const lines: string[] = []

  for (const m of stored.messages) {
    if (m.role === 'system') continue
    if (m.synthetic === true) {
      lines.push('  ~ (the earlier part of this conversation was compacted away here)')
      continue
    }
    if (m.role === 'tool') {
      if (args.include_tool_results !== true) continue
      lines.push(`       ${clip(m.content ?? '', 400)}`)
      continue
    }
    if (m.role === 'user' && typeof m.content === 'string') {
      // The harness talks in the person's role. Marked rather than hidden: a build failure
      // that drove the next three turns is part of what happened, and reading it as
      // something the person asked for is how a session gets misremembered.
      const split = splitUserMessage(m.content)
      const label = split.harness === true ? `[${split.harnessKind ?? 'harness'}]` : ROLE_LABEL.user
      lines.push(`${label} ${clip(split.text, MESSAGE_CLIP)}`)
      continue
    }
    if (m.role === 'assistant') {
      if (typeof m.content === 'string' && m.content.trim() !== '') {
        lines.push(`${ROLE_LABEL.assistant} ${clip(m.content, MESSAGE_CLIP)}`)
      }
      for (const call of m.tool_calls ?? []) {
        lines.push(`  → ${call.function.name} ${clip(call.function.arguments, 160)}`)
      }
    }
  }

  const head = `${localDay(meta.updatedAt)}  ${meta.id}` +
    `${meta.id === currentId ? '  ← this conversation' : ''}\n` +
    `"${meta.title === '' ? '(untitled)' : meta.title}"` +
    `${meta.mode === 'normal' ? '' : `  [${meta.mode}]`}` +
    `${stored.compactions > 0 ? `  · compacted ${stored.compactions}×` : ''}\n`

  let body = lines.join('\n')
  if (body.length > READ_BUDGET) {
    // Head AND tail, not the first N. A conversation's opening is what was asked and its
    // ending is what came of it; the middle is the working, and it is the half a reader
    // asking "what happened here" can most afford to lose.
    const half = Math.floor(READ_BUDGET / 2)
    const dropped = body.length - READ_BUDGET
    body = `${body.slice(0, half)}\n\n  … (${dropped} characters of the middle left out — ` +
      'narrow with search, or turn include_tool_results off if it is on)\n\n' +
      `${body.slice(-half)}`
  }
  const notes = stored.problems.length > 0 ? `\n\n(${stored.problems.join('; ')})` : ''
  const nothing = lines.length === 0 ? '\n(nothing was said in this conversation)' : ''
  return `${head}\n${body}${nothing}${notes}`
}
