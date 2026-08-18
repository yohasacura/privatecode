import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LlamaClient } from '../llama/client.js'
import type { ChatMessage, ChatRequest } from '../llama/types.js'

export interface CompactionInput {
  messages: readonly ChatMessage[] // the full current transcript
  workspaceRoot: string
  /**
   * How many tokens of transcript this request may carry. Absent (or 0) sends all of it,
   * which is what every caller did before a session was found that no longer fit — see
   * `fitForSummary`.
   */
  budgetTokens?: number
}
export interface CompactionResult {
  /** The summary text the new transcript opens with. */
  summary: string
  promptTokens?: number
  completionTokens?: number
  wallSeconds: number
}

/** First attempt's budget for the briefing. */
const MAX_TOKENS = 3000
/** Retry budget after a `length` finish -- see `generateCompaction`. */
const RETRY_MAX_TOKENS = 4500

/**
 * The five required sections, in the order the model must produce them. Kept as a
 * standalone list (rather than only inline in the prose below) so the exact header
 * wording used here is the one thing a smoke check greps for.
 */
const REQUIRED_SECTIONS = [
  'Task state',
  'Files touched',
  'Decisions and constraints',
  'Open todos',
  'Next step',
] as const

const COMPACTION_INSTRUCTION = `The conversation above is about to be compacted to free up context space. \
Write a continuation briefing for the session to resume from. Write it for yourself: you \
will continue this session with ONLY this briefing and the last few messages.

Cover exactly these five sections, in this order:

1. ${REQUIRED_SECTIONS[0]}: what was asked, what is done, what remains.
2. ${REQUIRED_SECTIONS[1]}: every path touched so far, one line each on what changed and why.
3. ${REQUIRED_SECTIONS[2]}: anything agreed with the user that must not be silently revisited.
4. ${REQUIRED_SECTIONS[3]}: verbatim, in the user's or your own original wording -- do not \
summarize or drop any of them.
5. ${REQUIRED_SECTIONS[4]}: the single next action to take.

Be concrete: exact file paths, exact function/variable names, exact remaining steps. Omit \
nothing a continuation would need and add nothing it would not.`

/** The same chars-per-token estimate `Transcript.approxTokens` uses, per message. */
/**
 * Drops the BODIES of reads that later tail messages supersede — the safe subset of the
 * collapse-swap idea, running only where the cache is being rebuilt anyway.
 *
 * A `read_file` result whose path is read AGAIN later in the tail, or edited later in the
 * tail, is dead weight: the model's current belief about that file comes from the later
 * message, and the earlier bytes only pad the window. Measured motivation: superseded
 * reads were ~30% of peak prompt on long recorded sessions. This runs at a compaction
 * swap ONLY — mid-session it would invalidate the server's prefix cache; at a swap the
 * prefix is being rewritten regardless.
 *
 * The stub SAYS what happened and where the truth now lives, per the rule that the model
 * must never receive silently truncated data.
 */
export function collapseSupersededReads(tail: ChatMessage[]): ChatMessage[] {
  // Pair tool results to their calls: id -> {name, path}.
  const calls = new Map<string, { name: string; path: string | null }>()
  for (const m of tail) {
    for (const c of m.tool_calls ?? []) {
      let path: string | null = null
      try {
        const args = JSON.parse(c.function.arguments) as { path?: unknown; to?: unknown }
        path = typeof args.path === 'string' ? args.path : typeof args.to === 'string' ? args.to : null
      } catch { /* unparseable arguments never produced a read worth collapsing */ }
      calls.set(c.id, { name: c.function.name, path })
    }
  }
  // For each path: the index of its LAST read result, and whether a write touches it later.
  const lastReadAt = new Map<string, number>()
  const writtenAfter = new Map<string, number>()
  tail.forEach((m, i) => {
    if (m.role === 'tool' && m.tool_call_id !== undefined) {
      const call = calls.get(m.tool_call_id)
      if (call?.name === 'read_file' && call.path !== null) lastReadAt.set(call.path, i)
    }
    for (const c of m.tool_calls ?? []) {
      const call = calls.get(c.id)
      if (call && call.path !== null && WRITE_TOOL_NAMES.has(call.name)) {
        writtenAfter.set(call.path, i)
      }
    }
  })
  return tail.map((m, i) => {
    if (m.role !== 'tool' || m.tool_call_id === undefined || typeof m.content !== 'string') return m
    if (m.content.length < COLLAPSE_MIN_CHARS) return m
    const call = calls.get(m.tool_call_id)
    if (call?.name !== 'read_file' || call.path === null) return m
    const rereadLater = (lastReadAt.get(call.path) ?? i) > i
    const editedLater = (writtenAfter.get(call.path) ?? -1) > i
    if (!rereadLater && !editedLater) return m
    return {
      ...m,
      content: `[superseded read of ${call.path}: the file was ${editedLater ? 'edited' : 're-read'} ` +
        'later in this conversation — the current content is in the later message, or one ' +
        'read_file away. The original bytes were dropped at compaction.]',
    }
  })
}

/** The write family, matched by call NAME because this module must not import the
 * session's own registry. Kept in sync with `session.ts`'s WRITE_TOOLS by the test. */
const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(['edit_file', 'write_file', 'move_file', 'delete_file'])

/** A read smaller than this is cheaper to keep than to explain away. */
const COLLAPSE_MIN_CHARS = 600

/** Exported for the session's nothing-to-gain gate: counting a message any OTHER way there
 * (it once counted only content + reasoning) makes the gate blind to exactly the messages
 * whose bulk is `tool_calls` arguments — a write-heavy stretch is whole files in
 * `arguments` with `content: null`, and it read as "nothing to compact". */
export function approxTokensOf(m: ChatMessage): number {
  let chars = (m.content?.length ?? 0) + (m.reasoning_content?.length ?? 0)
  for (const c of m.tool_calls ?? []) chars += c.function.arguments.length + 20
  return Math.ceil(chars / 4)
}

/** How many messages after the system one are kept whole at the FRONT: the original request
 * and the first answer to it, which is what every summary has to be anchored on. */
const KEEP_HEAD = 3

/**
 * The messages a summary request may carry, within a token budget.
 *
 * This exists because of a dead end found in the running app: a session whose transcript had
 * outgrown the window answered every send with
 * `request (133029 tokens) exceeds the available context size (131072 tokens)` — and the only
 * remedy on offer, compaction, sent the WHOLE transcript to be summarised, so it hit exactly
 * the same wall. The advice was unfollowable and the session was unusable forever.
 *
 * What is kept, in priority order: the system message (it carries the project's own rules),
 * the opening exchange (what was asked), and then as much of the TAIL as fits, because where
 * the work stands now is what a continuation needs most. The middle is dropped with a marker
 * saying so — a summary that quietly skipped half a conversation while claiming to cover it
 * would be worse than no summary at all.
 *
 * `budgetTokens <= 0` (a caller that does not know the window) keeps everything, which is
 * exactly the old behaviour.
 */
export function fitForSummary(
  messages: readonly ChatMessage[], budgetTokens = 0,
): ChatMessage[] {
  if (budgetTokens <= 0) return [...messages]
  const total = messages.reduce((sum, m) => sum + approxTokensOf(m), 0)
  if (total <= budgetTokens) return [...messages]

  const system = messages[0]?.role === 'system' ? [messages[0]] : []
  const rest = messages.slice(system.length)
  const head = rest.slice(0, KEEP_HEAD)

  let spent = [...system, ...head].reduce((sum, m) => sum + approxTokensOf(m), 0)
  const tail: ChatMessage[] = []
  // Backwards from the end, stopping before the head so nothing is taken twice.
  for (let i = rest.length - 1; i >= head.length; i--) {
    const message = rest[i]!
    const cost = approxTokensOf(message)
    if (spent + cost > budgetTokens) break
    tail.unshift(message)
    spent += cost
  }

  const dropped = rest.length - head.length - tail.length
  if (dropped <= 0) return [...system, ...head, ...tail]
  return [
    ...system,
    ...head,
    {
      role: 'user',
      content:
        `[${dropped} messages from the middle of this conversation are not included here: ` +
        'it no longer fits in the context window. Summarise what you can see, and say ' +
        'plainly in the summary that the middle was not available.]',
    },
    ...tail,
  ]
}

/**
 * Builds the compaction request by APPENDING one user message to `input.messages` --
 * never editing the existing list. `input.messages` (and every message in it) is left
 * completely untouched; the returned request's `messages` is a fresh array.
 *
 * This append-only shape is not just tidiness: it is what makes the summary generation
 * cheap. llama.cpp's prompt cache matches on longest-common-prefix, and appending keeps
 * this request's prefix byte-identical to every prior request's prefix in the session --
 * so the whole existing transcript is served from the already-warm KV cache and only the
 * one new briefing instruction needs prefill (DESIGN.md §4, "context full": "summarising
 * runs on top of the already-warm cache: prefill ~= 0, ~2500 generated tokens ~= 80s").
 * Editing or trimming history here instead would force a full re-prefill on top of that
 * generation cost (Transcript's own measurement: 27.7s to change one early word in a
 * ~14.9k-token history, vs 0.5s to append).
 *
 * No tools are offered and `toolChoice` is `'none'`: this call's only job is prose.
 */
export function buildCompactionRequest(input: CompactionInput): ChatRequest {
  const briefing: ChatMessage = { role: 'user', content: COMPACTION_INSTRUCTION }
  return {
    messages: [...fitForSummary(input.messages, input.budgetTokens), briefing],
    maxTokens: MAX_TOKENS,
    toolChoice: 'none',
    // The one request in this system with nothing to decide: the whole conversation is in
    // front of it and the job is to restate it. Measured in a real 27-minute run before
    // this line existed, both compactions generated 4022 and 4298 tokens against a 3000
    // budget — they were over the cap, truncated, and re-generated at 4500. The thinking
    // was eating the budget the briefing needed, so every compaction paid for two
    // generations to produce one clipped summary. See `disableThinking`.
    disableThinking: true,
  }
}

/**
 * Runs the compaction request (non-streaming) and returns the briefing text.
 *
 * A `length` finish is retried exactly once at a larger budget (`RETRY_MAX_TOKENS`). If
 * the retry ALSO truncates, this throws rather than returning a briefing that silently
 * cuts off mid-section -- a truncated summary would corrupt every future turn built on
 * top of it, whereas a caller that catches this and keeps the session uncompacted has
 * lost nothing but the space compaction would have freed. An empty (or whitespace-only)
 * summary throws for the same reason: a blank briefing is not a usable continuation.
 */
export async function generateCompaction(
  client: LlamaClient,
  input: CompactionInput,
  signal?: AbortSignal,
): Promise<CompactionResult> {
  const request = buildCompactionRequest(input)
  if (signal) request.signal = signal

  const started = performance.now()
  let result = await client.chat(request)

  if (result.finishReason === 'length') {
    const retryRequest: ChatRequest = { ...request, maxTokens: RETRY_MAX_TOKENS }
    result = await client.chat(retryRequest)
    if (result.finishReason === 'length') {
      throw new Error(
        `compaction summary truncated (finish_reason "length") even after retrying at ` +
        `maxTokens=${RETRY_MAX_TOKENS}; caller should treat compaction as failed and carry ` +
        'on uncompacted',
      )
    }
  }

  const wallSeconds = (performance.now() - started) / 1000
  const summary = result.message.content ?? ''
  if (summary.trim().length === 0) {
    throw new Error(
      'compaction summary was empty; caller should treat compaction as failed and carry on uncompacted',
    )
  }

  return {
    summary,
    ...(result.usage?.prompt_tokens !== undefined ? { promptTokens: result.usage.prompt_tokens } : {}),
    ...(result.usage?.completion_tokens !== undefined
      ? { completionTokens: result.usage.completion_tokens }
      : {}),
    wallSeconds,
  }
}

// --- Task 9: swap helpers -------------------------------------------------------------
//
// The generator above only produces the briefing text; everything below decides what a
// post-compaction Transcript looks like. Kept in this file (not session.ts) because it is
// pure array/string logic with no dependency on Agent, Transcript, or Session -- easy to
// smoke-check in isolation, and this is where the plan's file structure puts "swap logic
// helpers" for Task 9.

/** Opens the one synthetic user message a swap inserts in place of the dropped history. */
export const COMPACTION_BRIEFING_PREFIX =
  'Session briefing from the earlier part of this conversation (auto-compacted):'
/** The one synthetic assistant message that follows it, closing the round-trip. */
export const COMPACTION_ACK_TEXT = 'Understood; continuing from the briefing.'

export interface CompactionTail {
  /** The old transcript's trailing messages, to be copied verbatim (still needs `structuredClone`
   * at the point they're re-appended -- `Transcript.append` does that; this array itself
   * is just a view, a `slice()` of the caller's own array). */
  tail: readonly ChatMessage[]
  /** How many of the OLD transcript's messages were actually summarised away --
   * EXCLUDING the old leading system message (it is rebuilt fresh by the swap either way,
   * never fed to the summary, so counting it as "dropped" would overstate what the
   * briefing covers). The count a host reports as "N earlier messages summarised". */
  droppedMessages: number
}

/**
 * A message a compacted tail may safely open on: anything that is not a bare `tool` reply.
 *
 * A `tool` message is the only kind a slice can orphan. Its other half -- the `assistant`
 * message carrying the matching `tool_calls` -- comes BEFORE it, so cutting there leaves a
 * result answering a call that is no longer in the conversation.
 *
 * An `assistant` message with pending `tool_calls` was also refused here, and that was too
 * strict: its other half comes AFTER it, inside the tail. Opening on it cuts nothing. The
 * cost of the stricter rule only showed up once compaction could run BETWEEN THE STEPS of
 * one turn (see `Agent`'s `beforeStep`): mid-turn, every message from the user's request
 * onward is either an assistant-with-calls or a tool reply, so the walk-back rejected all of
 * them and landed on the request itself -- making the tail the whole turn, the middle empty,
 * and every mid-turn compaction a no-op reported as "nothing to gain". The mechanism was
 * there and could never fire.
 *
 * An assistant message whose calls are genuinely unanswered (a turn cut short) stays exactly
 * as unanswered as it was: that is a property of the transcript, not something this slice
 * introduces.
 */
function isCleanTailStart(m: ChatMessage): boolean {
  return m.role !== 'tool'
}

/**
 * Selects the messages a compaction swap keeps verbatim from the OLD transcript: the last
 * `keepRecent` of them, walked BACK (never forward -- only ever including MORE history,
 * never less) until the slice opens on a clean boundary per `isCleanTailStart`.
 *
 * The walk never reaches back past index 1: index 0 is assumed to be the transcript's
 * leading `system` message (true of every `Transcript` a live `Session` ever builds, via
 * `Agent`'s constructor), and a swap always rebuilds its OWN fresh system message rather
 * than copying the old one forward -- so index 0 itself is never a candidate, and the
 * worst case is walking all the way back to index 1, the session's very first `user`
 * message, which is clean by construction (the first thing `Agent.runTurn` ever appends).
 * A `messages` array with no leading `system` message at all (not how `Session` ever
 * builds one, but not assumed away either) falls back to floor 0 and trusts index 0
 * as-is, since there is nothing more conservative to walk back to.
 */
export function selectCompactionTail(
  messages: readonly ChatMessage[], keepRecent: number, maxTailTokens = 0,
): CompactionTail {
  const floor = messages.length > 0 && messages[0]!.role === 'system' ? 1 : 0
  let desiredStart = Math.max(floor, messages.length - keepRecent)

  // A COUNT is the wrong unit on its own. Six messages of prose is nothing; six messages
  // carrying whole files is a hundred thousand tokens, and a compaction that leaves 85% of
  // the context in place has not compacted. Measured in the app: 130.2k -> 111.7k, which
  // bought one more turn.
  //
  // So the count is a ceiling and the budget is the other one: drop from the FRONT of the
  // intended tail until it fits, always keeping the most recent message, which carries what
  // was last asked.
  if (maxTailTokens > 0) {
    let spent = 0
    for (let i = messages.length - 1; i >= desiredStart; i--) {
      spent += approxTokensOf(messages[i]!)
      if (spent > maxTailTokens && i < messages.length - 1) {
        desiredStart = i + 1
        break
      }
    }
  }

  let start = desiredStart
  while (start > floor && !isCleanTailStart(messages[start]!)) start--
  // `start - floor` excludes the old leading system message from the count -- `floor` is
  // 1 exactly when one was present, 0 otherwise, so this is a no-op subtraction when
  // there was nothing to exclude.
  const tail = messages.slice(start).map((m) => clipToBudget(m, maxTailTokens))
  return { tail, droppedMessages: start - floor }
}

/**
 * The hole the size cap alone leaves: ONE message bigger than the whole budget.
 *
 * Dropping messages cannot help when a single one is the problem — and the last message can
 * never be dropped, since it carries what was asked. In a coding session that message is
 * routinely a whole file. So its TEXT is clipped, with a line saying so and naming the tool
 * to read it again with, which is exactly what the model would do next anyway.
 *
 * Editing history would normally be forbidden here; this is not that. `applyCompactionSwap`
 * is building a brand-new transcript, and the original file on disk keeps every byte — the
 * append-only law is about the record, and the record is untouched.
 */
function clipToBudget(message: ChatMessage, maxTailTokens: number): ChatMessage {
  if (maxTailTokens <= 0) return message
  const content = message.content
  if (typeof content !== 'string') return message
  const limit = maxTailTokens * CHARS_PER_TOKEN
  if (content.length <= limit) return message
  return {
    ...message,
    content:
      `${content.slice(0, limit)}\n\n[...this message was ${content.length} characters and ` +
      'was clipped here so the conversation fits in the context window. Read the file again ' +
      'with read_file if you need the rest.]',
  }
}

/** The same ratio `approxTokensOf` divides by, going the other way. */
const CHARS_PER_TOKEN = 4

// --- The continuation inventory --------------------------------------------------------

/** Tools whose successful call means "the model has looked at this path". */
const SEEN_TOOLS = new Set(['read_file', 'symbol_outline'])
/** Tools whose successful call means "the model changed this path". */
const CHANGED_TOOLS = new Set(['edit_file', 'write_file', 'move_file', 'delete_file'])
/** Permanent context, so bounded. Past this the list stops being an aid and becomes noise. */
const MAX_INVENTORY_PATHS = 40

function pathOf(argsJson: string): string | null {
  try {
    const parsed: unknown = JSON.parse(argsJson)
    if (typeof parsed !== 'object' || parsed === null) return null
    const p = (parsed as Record<string, unknown>)['path']
    return typeof p === 'string' && p.trim() !== '' ? p.trim() : null
  } catch {
    return null
  }
}

function listOf(paths: readonly string[]): string {
  const shown = paths.slice(0, MAX_INVENTORY_PATHS)
  const rest = paths.length - shown.length
  return shown.map((p) => `  ${p}`).join('\n') +
    (rest > 0 ? `\n  ... and ${rest} more` : '')
}

/**
 * Facts about the session that a generated summary can get wrong, computed instead.
 *
 * The briefing is written BY the model, which means every fact in it is a fact the model
 * recalled. That is fine for judgment ("we decided not to touch the parser") and unreliable
 * for bookkeeping — which files it opened, what is still on the todo list. Those are in the
 * transcript and in the todo store, exactly and cheaply, so they are read from there.
 *
 * Note what this deliberately does NOT say: "do not re-read these". After a swap the file
 * CONTENTS are genuinely gone from the context, so re-reading is often the correct move, and
 * an instruction not to would have the model working from knowledge it no longer has. It was
 * already measured once being efficient on its own — answering a counting task with
 * `search_code` instead of re-reading twenty files. What it lacks is not discipline, it is
 * the list: which paths it has already been through, so it can re-acquire the one it needs
 * narrowly instead of walking the tree again.
 */
/**
 * Which files this session has opened and which it has changed, from the transcript.
 *
 * Exported because two things need the same answer and must not compute it differently: the
 * briefing's inventory, and the repository map's focus at a compaction swap. "What is this
 * session about" has one answer, and it is this.
 */
export function touchedPaths(messages: readonly ChatMessage[]): { seen: string[]; changed: string[] } {
  const seen: string[] = []
  const changed: string[] = []
  for (const m of messages) {
    for (const call of m.tool_calls ?? []) {
      const name = call.function.name
      if (!SEEN_TOOLS.has(name) && !CHANGED_TOOLS.has(name)) continue
      const path = pathOf(call.function.arguments)
      if (path === null) continue
      const into = CHANGED_TOOLS.has(name) ? changed : seen
      if (!into.includes(path)) into.push(path)
    }
  }
  return { seen, changed }
}


/**
 * How many characters of changed-file contents a briefing may carry.
 *
 * ~2k tokens against a tail budget measured in tens of thousands. Small on purpose: this is
 * the one part of the briefing that grows with the work done, and a swap that carried thirty
 * files would have freed nothing.
 */
const DEFAULT_BODY_BUDGET = 8_000

/** A file too big to be worth carrying whole. Its name is still in the list above. */
const MAX_CARRIED_FILE = 4_000

/**
 * The current contents of as many of `paths` as fit, newest change first.
 *
 * Read from DISK rather than recovered from the transcript, deliberately: what matters after
 * a swap is what the file says now, and the transcript holds a diff of what it said then.
 * Anything unreadable is skipped in silence — its name is still listed above, so the model
 * knows it exists, and a briefing must never fail because a file was deleted.
 */
function readBodies(
  paths: readonly string[], root: string | undefined, budget: number,
  diffsByPath?: ReadonlyMap<string, string>,
): string {
  if (root === undefined) return ''
  const blocks: string[] = []
  let spent = 0
  for (const rel of [...paths].reverse()) {
    let text: string
    try {
      text = readFileSync(join(root, rel), 'utf8')
    } catch {
      continue
    }
    let block: string
    if (text.length <= MAX_CARRIED_FILE) {
      block = `--- ${rel}\n${text}`
    } else {
      // The file the model is MOST in the middle of is usually the one too big to carry
      // whole — dropping it silently (the old behaviour) is what made 9 of 10 post-swap
      // reads re-reads. Carry the regions this session actually edited instead, from the
      // transcript's own diffs; a big file with no diffs (created whole) carries its head.
      // Every omission is announced — the model must never mistake a part for the whole.
      const hunks = diffsByPath?.get(rel)
      block = hunks !== undefined
        ? `--- ${rel} [${text.length} chars on disk — too big to carry whole. ` +
          'The regions this session edited (oldest first); read_file for anything outside them:]\n' +
          (hunks.length > MAX_CARRIED_FILE
            ? `[... earlier edits omitted]\n${hunks.slice(hunks.length - MAX_CARRIED_FILE)}`
            : hunks)
        : `--- ${rel} [${text.length} chars on disk — too big to carry whole. ` +
          `Its first ${MAX_CARRIED_FILE} chars; read_file for the rest:]\n${text.slice(0, MAX_CARRIED_FILE)}`
    }
    if (spent + block.length > budget) break
    blocks.push(block)
    spent += block.length
  }
  return blocks.join('\n\n')
}

/**
 * The last diffs each path received this stretch, keyed by path — `readBodies`' source for
 * the edited regions of files too big to carry whole. The first line of every edit-family
 * tool result is `--- <path>`, which is the pairing this reads.
 */
export function diffsByPath(messages: readonly ChatMessage[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of messages) {
    if (m.role !== 'tool' || typeof m.content !== 'string' || !m.content.startsWith('--- ')) continue
    const firstLine = m.content.slice(4, m.content.indexOf('\n'))
    const path = firstLine.trim()
    if (path === '') continue
    const prev = out.get(path)
    out.set(path, prev === undefined ? m.content : `${prev}\n${m.content}`)
  }
  return out
}

export function continuationInventory(
  messages: readonly ChatMessage[],
  todos: readonly {
    text: string
    status: 'pending' | 'in_progress' | 'completed'
    done_when?: string
  }[] = [],
  /**
   * Paths from BEFORE these messages, folded in by the caller.
   *
   * The transcript handed here is the one about to be replaced, and after a previous swap
   * that is a briefing carrying no tool calls plus a short tail — so on a session's second
   * compaction this function could see almost nothing of what the session had actually
   * opened. The caller accumulates across swaps and passes what it has.
   */
  carried: { seen: readonly string[]; changed: readonly string[] } = { seen: [], changed: [] },
  /** Workspace root, so the bodies of changed files can be read. Absent means names only —
   * which is what every caller that has no filesystem (the tests) wants. */
  root?: string,
  bodyBudget: number = DEFAULT_BODY_BUDGET,
): string {
  const here = touchedPaths(messages)
  const seen = [...new Set([...carried.seen, ...here.seen])]
  const changed = [...new Set([...carried.changed, ...here.changed])]
  // A file that was changed was necessarily worked on; listing it twice says nothing extra.
  const seenOnly = seen.filter((p) => !changed.includes(p))
  const open = todos.filter((t) => t.status !== 'completed')

  const parts: string[] = []
  if (seenOnly.length > 0) {
    parts.push(
      'Files you have already opened in this session. Their contents are NOT in context any ' +
      'more — if you need one again, prefer search_code or a line range over reading the ' +
      'whole file:',
      listOf(seenOnly),
    )
  }
  if (changed.length > 0) {
    parts.push('Files you changed in this session:', listOf(changed))
    // And their CONTENTS, for the few that fit.
    //
    // Naming a file the model itself edited and then withholding what it now contains is the
    // one case where the inventory creates the re-read it exists to prevent: measured on the
    // longest recorded session, 9 of the 10 reads within eight steps of a swap were re-reads
    // of paths already named right here. `seen` files are correctly left as names — the model
    // looked at them once and may never need them again — but a file it CHANGED is the file
    // it is in the middle of working on.
    //
    // Most recently changed first, and only while the budget holds: this is the one part of
    // the briefing that can grow without bound, and a swap that carried thirty files would be
    // a swap that freed nothing.
    const bodies = readBodies(changed, root, bodyBudget, diffsByPath(messages))
    if (bodies !== '') {
      parts.push(
        'The current contents of the ones you changed most recently, so you do not have to ' +
        'read them again:',
        bodies,
      )
    }
  }
  if (open.length > 0) {
    parts.push(
      'Your todo list, as it actually stands (from the todo tool, not from memory):',
      // The done criterion rides along: after a swap, "what counts as finished" is exactly
      // what the replaced conversation was carrying.
      open.map((t) => `  [${t.status === 'in_progress' ? '>' : ' '}] ${t.text}` +
        (t.done_when !== undefined ? `\n        done when: ${t.done_when}` : '')).join('\n'),
    )
  }
  return parts.length === 0 ? '' : parts.join('\n\n')
}
