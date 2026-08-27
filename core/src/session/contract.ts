import type { TodoItem } from '../interaction.js'
import type { LlamaClient } from '../llama/client.js'
import type { ChatMessage, ToolSchema } from '../llama/types.js'
import { forcedJson } from './forced-json.js'

/**
 * The task contract: what a complex task IS, held where the model cannot lose it.
 *
 * The failure this exists for is goal drift. On a multi-file, multi-hour task the goal
 * lives in one user message in the middle of a growing transcript — exactly where
 * attention decays first and where compaction reaches first — and the measured endgame is
 * a model that finishes with conviction while criteria the user stated plainly are simply
 * not met (the recorded corpus's worst turn: 38 edits, 11 files, "done", 11 compile
 * errors). The contract is distilled ONCE, up front, into checkable criteria, and then:
 *
 *  - injected into the transcript tail at the moment it is made (cache-friendly: an
 *    append, never a prefix rewrite),
 *  - promoted into the SYSTEM prompt at every compaction swap (message 0 is rebuilt there
 *    anyway, so this costs nothing and survives every later swap),
 *  - enforced at the end of every writing turn by `checkAcceptance` — the turn may not end
 *    as "done" while a criterion is demonstrably unmet.
 *
 * Everything here follows the project's one measured law of prompting this model:
 * INSTRUCTIONS in the prompt do not route behaviour (0/703), information in the prefix
 * does, and structure must be enforced by the harness, not requested of the model. So the
 * contract is created by a FORCED tool call (the model cannot decline to produce it), and
 * the gate is code (the turn cannot end while the check says no), and the only thing the
 * prompt carries is information: the goal and the criteria themselves.
 */

export interface TaskContract {
  /**
   * The user's request in THEIR OWN WORDS, kept beside the distillation of it.
   *
   * The contract is a restatement, and a restatement cannot catch a misreading — so the
   * understanding check has to read the original, not this file's summary of it. Stored on
   * the contract so it survives a resumed session and a compaction, both of which can put
   * the request itself out of reach.
   */
  request?: string
  /** Set once the understanding check has run for this task, so it runs once and not before
   * every write. Absent means it has not run; a new task replaces the whole contract. */
  understood?: boolean
  /** Same, for the premise check. Its own flag rather than one shared with `understood`
   * because the two run at the same moment but answer different questions, and a premise
   * failure sends the model back to the files BEFORE anyone is asked what they meant. */
  premisesChecked?: boolean
  /** Set once the gate has seen every criterion met (and the diff review, when it ran,
   * raise nothing). A satisfied contract stops gating and stops being promoted — small
   * follow-up turns must not keep paying an audit for a task that is finished. Only a new
   * task-shaped request replaces it. */
  satisfied?: boolean
  /**
   * What the LAST acceptance check said, criterion by criterion — one line like
   * "checked: 1,3 met; 2 UNMET (no assertion write happened)". Rendered into every
   * promoted contract, so after a swap the model reads not just what "done" means but
   * where it actually STANDS against it. A row a check just wrote is information in the
   * prefix — the only channel measured to route this model — and it is what turns
   * "38 edits, done, 11 compile errors discovered hours later" into a gap named in
   * message 0 at the next swap.
   */
  checkedState?: string
  /**
   * What KIND of task this is. `bugfix` changes the protocol: the harness appends a
   * reproduction-first criterion (below), because for a repair the failing output routes
   * localization better than any instruction and turns acceptance deterministic — the
   * repro flips green or it does not, no 3B-judgement involved.
   */
  kind?: 'bugfix' | 'feature' | 'other'
  /**
   * Whether finishing this means changing source that has to build and pass tests.
   *
   * A separate forced question rather than something read off `kind`, because they are two
   * judgements and letting two judgements collapse into one is precisely how the reviewer's
   * out-of-scope escape hatch worked. `other` covers a refactor (code) and an email (not),
   * so a gate keyed on it would be guessing. Asked LAST, with the goal and the criteria
   * already written.
   */
  changesCode?: boolean
  /** One sentence: what the user actually wants to exist at the end. */
  goal: string
  /** Checkable statements — each one answerable yes/no by looking at the workspace or
   * running a command, never "the code is clean". 2–6 of them. */
  criteria: string[]
  /** Things that must NOT happen — files not to touch, behaviour not to change. */
  constraints: string[]
  /** Multi-file tasks only: the agreed shape of the seams — signatures, types, names —
   * pinned BEFORE bodies are written, because inconsistent seams are how multi-file work
   * fails. Free text, small. */
  interfaces?: string
}

/**
 * Whether a user message warrants the up-front distillation generation at all.
 *
 * A one-line request ("fix the typo in README") does not: the contract would cost a
 * generation and restate the request. The threshold is deliberately dumb — length and
 * structure, not comprehension — and TUNED LIVE: at the measured 40 tok/s a distillation
 * costs ~8–15 s, which is worth paying exactly when the task will run for many minutes.
 */
export function looksLikeTask(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length >= 220) return true
  // Shorter but visibly multi-part: several sentences or an explicit list.
  const sentences = trimmed.split(/[.!?]\s|\n/).filter((s) => s.trim().length > 12)
  return trimmed.length >= 80 && sentences.length >= 3
}

/** Shape only — every word that has to reach the model is in `distillContract`'s ask, because
 * a `response_format` schema is never rendered. */
export const CONTRACT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['goal', 'rules', 'criteria', 'constraints', 'interfaces', 'kind', 'changesCode'],
  additionalProperties: false,
  properties: {
    goal: { type: 'string' },
    // BEFORE `criteria`, and the order is the whole point — the same lever `acceptanceSchema`
    // uses to put evidence before a verdict. A `response_format` grammar emits properties in
    // schema order, so by the time the model writes the criteria list it has already had to
    // isolate the rules, and the ask can then tell it not to re-derive them.
    //
    // A required FIELD rather than a sentence in the ask, because the sentence was not
    // enough. The ask names this failure verbatim — "do not split it into the parts you would
    // implement (lowercases, strips punctuation, no leading hyphen)" — and a measured run
    // produced exactly those three anyway. This session has the general lesson twice over:
    // this model follows the grammar and negotiates with the prose.
    rules: { type: 'array', items: { type: 'string' } },
    criteria: { type: 'array', items: { type: 'string' } },
    constraints: { type: 'array', items: { type: 'string' } },
    // Required-but-emptyable rather than optional: a strict schema is clearer about what
    // "nothing to say here" looks like than an absent key, and `parseContract` already
    // treats an empty string and an absent one identically.
    interfaces: { type: 'string' },
    kind: { type: 'string', enum: ['bugfix', 'feature', 'other'] },
    // LAST, so it is answered with the goal and the criteria already written rather than
    // from the request alone — the same property-order lever the acceptance schema uses.
    changesCode: { type: 'boolean' },
  },
}

/**
 * Output caps in this file follow one rule, learned the expensive way: a cap that a
 * healthy generation can hit is a SILENT failure — a `length` finish carries no tool
 * call, parses as null, and the feature quietly does not happen, with nothing anywhere
 * to trace. The first acceptance cap (900) died exactly like that on the first live
 * six-criterion task. So every cap here is sized to several times the worst healthy
 * output; the 262k window makes generosity free.
 */
const DISTILL_MAX_TOKENS = 2_000

/** How much recent conversation the distiller sees — enough to understand a continuation
 * request, small enough that its (cache-diverging) prefill stays in seconds. */
const DISTILL_TAIL_MESSAGES = 8
const DISTILL_TAIL_CLIP_CHARS = 2_000

/**
 * One forced generation over the live transcript plus the new request: the model must call
 * `set_contract` (toolChoice 'required' — it cannot answer with prose), and thinking is
 * off because extraction is restating, and restating with thinking on was measured pure
 * waste on this server. The request shares the transcript prefix, so the marginal prefill
 * is the instruction below.
 */
/**
 * Message 0 plus a CLIPPED recent tail, never the whole conversation — shared by the
 * distiller and the draft improver, which must understand a continuation draft against
 * the same context a send would be. The transcript with a different tool list is a
 * different prompt to the server: carrying it all paid a full re-prefill (minutes, on a
 * fat session) for a request whose main input is the text itself. Clips are announced
 * in-line, per the no-silent-truncation rule.
 */
function distillContext(transcript: readonly ChatMessage[]): ChatMessage[] {
  const head = transcript.length > 0 && transcript[0]!.role === 'system' ? [transcript[0]!] : []
  const recent = transcript.slice(Math.max(head.length, transcript.length - DISTILL_TAIL_MESSAGES))
    .map((m) => {
      // `content` is only half of a message's bulk, and on a write-heavy tail it is the
      // empty half: a `write_file` call carries the whole file in
      // `tool_calls[0].function.arguments` with `content: null` — bounded only by
      // DEFAULT_MAX_TOKENS_PER_STEP, i.e. 8,000 tokens each. The old guard short-circuited
      // on `typeof m.content !== 'string'`, so those messages were never clipped by any
      // path, and `content: ''` skipped the length test too. Eight of them made this
      // "small" context tens of thousands of tokens. This codebase has learned the same
      // lesson twice already, in `approxTokensOf` and in the session's compaction gate.
      const clipped = typeof m.content === 'string' && m.content.length > DISTILL_TAIL_CLIP_CHARS
        ? `${m.content.slice(0, DISTILL_TAIL_CLIP_CHARS)}\n[... clipped for contract distillation]`
        : m.content
      const calls = m.tool_calls
      if (calls === undefined) return clipped === m.content ? m : { ...m, content: clipped }
      return {
        ...m,
        content: clipped,
        tool_calls: calls.map((c) => (
          c.function.arguments.length <= DISTILL_TAIL_CLIP_CHARS ? c : {
            ...c,
            function: {
              ...c.function,
              // Still valid JSON is not worth faking here: this context is read, never
              // replayed as a call, and saying what was cut is the no-silent-truncation rule.
              arguments: `${c.function.arguments.slice(0, DISTILL_TAIL_CLIP_CHARS)}\n[... clipped for contract distillation]`,
            },
          }
        )),
      }
    })
  return [...head, ...recent]
}

export async function distillContract(
  client: LlamaClient,
  transcript: readonly ChatMessage[],
  userText: string,
  signal?: AbortSignal,
  /** The session's own tool array, unchanged, so this stays an append onto the warm prefix. */
  tools?: readonly ToolSchema[],
): Promise<TaskContract | null> {
  const messages: ChatMessage[] = [
    ...distillContext(transcript),
    {
      role: 'user',
      content:
        `${userText}\n\n` +
        '[Before starting: distill this request into a task contract. Do not begin the work ' +
        'yet.\n\n' +
        // All of the following lived in CONTRACT_TOOL's `description` fields, which were
        // rendered while the shape was forced by a one-tool `tools` array. A
        // `response_format` schema is compiled to a grammar and contributes zero prompt
        // tokens, so the move had to bring the prose with it — see forced-json.ts, and see
        // the regression it caused the one time it did not.
        'goal — one sentence: what must exist when this is done.\n\n' +
        'rules — every sentence in the request that must hold for EVERY input, or that bounds ' +
        'the SET of what is allowed: "slugs contain only lowercase letters, digits and single ' +
        'hyphens", "every amount is rounded before it is summed", "no endpoint may return a ' +
        'raw stack trace". Copy each one from the request, in the request\'s own words. Add an ' +
        'example after it only as evidence — "<rule> — e.g. <instance>". One entry per rule: ' +
        'never the same rule twice in different words. Empty when the request states no such ' +
        'sentence, which is common — a request to rename one function has no rules.\n\n' +
        'criteria — the rest of the done-criteria. Two to six IN TOTAL counting the rules ' +
        'above, so a request with two rules leaves room for about four. Each answerable ' +
        'yes/no by looking at ' +
        'a file or running a command. Never vague. Each one is a STATE OF THE WORLD once the ' +
        'work is finished, never an activity along the way: "the counter cannot hand out the ' +
        'same number twice" is a criterion; "the code is examined", "the root cause is ' +
        'identified", "a fix is implemented" are not — every one of those is satisfied by a ' +
        'conversation in which nothing changed, which is exactly how a task passes its own ' +
        'audit while the bug is still there. Every criterion must come from the REQUEST: a ' +
        'criterion the request does not imply is not a higher standard, it is a licence to go ' +
        'and do something else, and the audit will hold the task open until it is done. Keep ' +
        'the request\'s own specifics VERBATIM — "invalid status TRANSITION rejected" must ' +
        'not soften into "status is from the valid set", because a generalized criterion ' +
        'passes work the user did not ask for.\n\n' +
        // The mirror of the sentence above, and it has to be said separately because it is
        // the OPPOSITE error: that one guards a specific requirement from being widened,
        // this one guards a general one from being narrowed. Measured on this server, twice
        // out of two, "slugs contain only lowercase letters, digits and single hyphens" came
        // back as seven criteria of which ZERO stated the rule — "converts all letters to
        // lowercase", "strips all punctuation", "no leading hyphen". Every part held; the
        // rule did not (`_` and `&` survived), and the audit affirmed all seven.
        'A rule you already listed above is DONE. Do not restate it here in other words, do ' +
        'not split it into the parts you would implement ("lowercases", "strips punctuation", ' +
        '"no leading hyphen"), and do not list its cases: an input-and-expected-output pair ' +
        'for a rule already listed ("slug(\'Hello World\') returns \'hello-world\'") is not a ' +
        'criterion, it is one of the cases that rule\'s test will cover. Parts and cases can ' +
        'all be true while the rule is false, and then the audit affirms a task that is not ' +
        'finished. And an invented case costs more than a wasted line: every criterion is ' +
        'audited on its own and has to be demonstrated by something that RAN in the ' +
        'conversation, so a case you made up that nobody thought to try holds the task open ' +
        'for work the user never asked for.\n\n' +
        'constraints — what must NOT change or be touched. Empty if the user named none.\n\n' +
        'interfaces — only when several files must agree: the signatures, types and names ' +
        'they agree ON, pinned now. Empty otherwise.\n\n' +
        'kind — "bugfix" ONLY when the request reports existing behaviour as broken and asks ' +
        'to repair it; "feature" for new capability; "other" for the rest.\n\n' +
        'changesCode — true when finishing this means changing source that has to build and ' +
        'pass tests. False when the work is writing, answering, explaining or producing a ' +
        'document. Writing a FILE is not the test: an email saved to disk is still false.\n\n' +
        'Answer with JSON only.]',
    },
  ]
  // The session's own tool array, so this shares the prefix every step warmed instead of
  // being a new one. See `forcedJson`.
  const parsed = await forcedJson(client, {
    messages,
    name: 'contract',
    schema: CONTRACT_SCHEMA,
    maxTokens: DISTILL_MAX_TOKENS,
    disableThinking: true,
    ...(tools ? { tools } : {}),
    ...(signal ? { signal } : {}),
  })
  // A distillation that failed must never cost the turn — the task simply runs the way every
  // task ran before contracts existed.
  return parsed === null ? null : readContract(parsed)
}

/** Tolerant of every way a generated JSON document can be slightly wrong, strict about the
 * one thing that matters: without a goal and at least one checkable criterion there is no
 * contract worth enforcing. */
export function parseContract(argsJson: string): TaskContract | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(argsJson)
  } catch {
    return null
  }
  return readContract(parsed)
}

function readContract(parsed: unknown): TaskContract | null {
  if (typeof parsed !== 'object' || parsed === null) return null
  const o = parsed as Record<string, unknown>
  const goal = typeof o['goal'] === 'string' ? o['goal'].trim() : ''
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : []
  // Rules ARE criteria, and they go first: they are the headline requirement, and the audit
  // reads the list in order. Merged here rather than kept as a second field so that nothing
  // downstream — `renderContract`, `checkAcceptance`, `seedTodos`, `syncTodosWithAudit` —
  // has to learn about a new shape, and so that a rule cannot be quietly skipped by a reader
  // that only knows about criteria.
  //
  // Deduped against the criteria the model wrote anyway: it is told not to restate a rule,
  // and it sometimes does. Comparison is on the words that carry meaning, because the
  // restatement is rarely byte-identical.
  const meaningful = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const rules = strings(o['rules']).slice(0, 4)
  const ruleKeys = new Set(rules.map(meaningful))
  const rest = strings(o['criteria']).filter((c) => !ruleKeys.has(meaningful(c)))
  const criteria = [...rules, ...rest].slice(0, 8)
  if (goal === '' || criteria.length === 0) return null
  const contract: TaskContract = { goal, criteria, constraints: strings(o['constraints']).slice(0, 8) }
  if (typeof o['interfaces'] === 'string' && o['interfaces'].trim() !== '') {
    contract.interfaces = o['interfaces'].trim()
  }
  if (o['kind'] === 'bugfix' || o['kind'] === 'feature' || o['kind'] === 'other') {
    contract.kind = o['kind']
  }
  // Only an explicit `false` turns the build gate off. An absent or malformed answer leaves
  // it undefined, and every consumer treats undefined as "code" — a distillation that came
  // back wrong must not be able to silence a check by omission, which is the failure mode
  // that matters here: skipping a build nobody asked to skip is invisible.
  if (typeof o['changesCode'] === 'boolean') contract.changesCode = o['changesCode']
  // The reproduction-first criterion is appended by the HARNESS, never trusted to the
  // distillation: for a repair, "the repro failed before and passes after" is the one
  // deterministic definition of fixed, and the skeptic gate refuses it without evidence.
  if (contract.kind === 'bugfix' && !contract.criteria.some((c) => /репро|reproduc/i.test(c))) {
    contract.criteria.push(
      'A reproduction (script or test) demonstrably FAILED before the fix — its red run is ' +
      'in the conversation — and passes after it',
    )
  }
  return contract
}

/**
 * The contract as the model reads it — in the tail note at creation and in the system
 * prompt after every swap. Information, not instruction, except the one line the gate
 * makes TRUE by force: the turn genuinely cannot end while a criterion is unmet.
 */
/**
 * What the composer's improver suggests ADDING to a draft — never a rewrite of it.
 *
 * The user's words are untouchable; an improvement is the structure around them: the
 * checkable criteria the draft implies, the constraints it implies, and QUESTIONS for
 * whatever essential it leaves unspecified. Questions are the honesty valve — the one
 * failure mode of every prompt improver is inventing requirements the user never meant,
 * and here anything not implied by the draft must arrive as a question, not a claim.
 */
export interface DraftSuggestions {
  criteria: string[]
  constraints: string[]
  questions: string[]
}

/** `set_contract`'s sibling for DRAFTS: same checkability bar, plus questions, minus the
 * fields that only matter once work actually starts (kind, interfaces). Its own tool so
 * the send-path distiller never wastes tokens asking questions nobody will answer. */
/** Shape only — the rules are in `improveDraft`'s ask, because a `response_format` schema is
 * compiled to a grammar and never rendered. */
const IMPROVE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['criteria', 'constraints', 'questions'],
  additionalProperties: false,
  properties: {
    criteria: { type: 'array', items: { type: 'string' } },
    constraints: { type: 'array', items: { type: 'string' } },
    questions: { type: 'array', items: { type: 'string' } },
  },
}

/** Tolerant like `parseContract`, strict about emptiness: with nothing to suggest and
 * nothing to ask there is no improvement worth showing. */
export function parseSuggestions(argsJson: string): DraftSuggestions | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(argsJson)
  } catch {
    return null
  }
  return readSuggestions(parsed)
}

function readSuggestions(parsed: unknown): DraftSuggestions | null {
  if (typeof parsed !== 'object' || parsed === null) return null
  const o = parsed as Record<string, unknown>
  const strings = (v: unknown, cap: number): string[] =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()).slice(0, cap)
      : []
  const out: DraftSuggestions = {
    criteria: strings(o['criteria'], 8),
    constraints: strings(o['constraints'], 8),
    questions: strings(o['questions'], 4),
  }
  if (out.criteria.length === 0 && out.constraints.length === 0 && out.questions.length === 0) return null
  return out
}

/** `suggest_improvements`' sibling for SHORT drafts: not structure around a long draft
 * but a rewritten one — the rough command expanded into a detailed brief out of what
 * message 0 already knows about the project (repo map, notes, conversation). */
/** Shape only — see `expandDraft`'s ask for the rules, including the language pin. */
const EXPAND_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['expanded'],
  additionalProperties: false,
  properties: {
    expanded: { type: 'string' },
  },
}

/** Tolerant like the parsers above; empty or non-string is "nothing worth showing". */
export function parseExpanded(argsJson: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(argsJson)
  } catch {
    return null
  }
  return readExpanded(parsed)
}

function readExpanded(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null) return null
  const v = (parsed as Record<string, unknown>)['expanded']
  if (typeof v !== 'string' || v.trim() === '') return null
  return v.trim()
}

/**
 * The expander behind the composer's preview card: a rough command ("make a red button")
 * grown into the brief the user would have written with the project open in their head.
 * Same clipped context a send would get — message 0 carries the repo map and the notes,
 * which is exactly where the file names and tokens come from — so the request rides the
 * cached prefix. Null when the model declines or returns nothing usable.
 */
export async function expandDraft(
  client: LlamaClient,
  transcript: readonly ChatMessage[],
  draft: string,
  signal?: AbortSignal,
  /** The session's own tool array. The user is WAITING on this one — it runs from the
   * composer while they type — so sharing the warm prefix is felt directly. */
  tools?: readonly ToolSchema[],
): Promise<string | null> {
  const messages: ChatMessage[] = [
    ...distillContext(transcript),
    {
      role: 'user',
      content:
        `${draft}\n\n` +
        '[The user is still DRAFTING the rough request above — do not begin the work. ' +
        'Give the same request expanded into a detailed brief: pull the concrete file ' +
        'paths, components, design tokens and conventions it should build on from the ' +
        'project context you already have (repo map, project notes, this conversation). ' +
        'Never invent a path or a value the context does not support — anything essential ' +
        'it cannot answer, keep as a short open question inside the text. Keep the ' +
        'user\'s intent exactly.\n\n' +
        // Out of EXPAND_TOOL's `description`, which is no longer rendered. This is the pin
        // the owner reported Ctrl+E breaking without.
        'Write it the way a careful colleague would brief it, WRITTEN IN ENGLISH always, ' +
        'whatever language the draft is in. Plain prose, no headings.\n\n' +
        'Answer with JSON only.]',
    },
  ]
  const parsed = await forcedJson(client, {
    messages,
    name: 'expanded',
    schema: EXPAND_SCHEMA,
    maxTokens: DISTILL_MAX_TOKENS,
    disableThinking: true,
    ...(tools ? { tools } : {}),
    ...(signal ? { signal } : {}),
  })
  return parsed === null ? null : readExpanded(parsed)
}

/**
 * The improver behind the composer's suggestion chips: the draft, distilled the way a
 * sent message would be (same transcript context, so a continuation draft is understood
 * against the session) — but into SUGGESTIONS, not a contract, and with questions instead
 * of inventions. Null when the model declines or the answer parses to nothing.
 */
export async function improveDraft(
  client: LlamaClient,
  transcript: readonly ChatMessage[],
  draft: string,
  signal?: AbortSignal,
  /** The session's own tool array — same reason as `expandDraft`. */
  tools?: readonly ToolSchema[],
): Promise<DraftSuggestions | null> {
  const messages: ChatMessage[] = [
    ...distillContext(transcript),
    {
      role: 'user',
      content:
        `${draft}\n\n` +
        '[The user is still DRAFTING the request above — do not begin the work.\n\n' +
        // Out of IMPROVE_TOOL's `description` fields, which are no longer rendered.
        'criteria — the checkable done-criteria the draft IMPLIES, its own specifics kept ' +
        'VERBATIM, each answerable yes/no by looking at a file or running a command. Empty ' +
        'if it implies none.\n' +
        'constraints — what the draft implies must NOT change. Empty if it implies none.\n' +
        'questions — a short question for each essential thing the draft leaves open: which ' +
        'files, what counts as done, what must not break. NEVER answer them yourself; a ' +
        'requirement the draft does not imply belongs here, not in criteria.\n\n' +
        'Never invent a requirement the draft does not imply. Answer with JSON only.]',
    },
  ]
  const parsedImprove = await forcedJson(client, {
    messages,
    name: 'suggestions',
    schema: IMPROVE_SCHEMA,
    maxTokens: DISTILL_MAX_TOKENS,
    disableThinking: true,
    ...(tools ? { tools } : {}),
    ...(signal ? { signal } : {}),
  })
  return parsedImprove === null ? null : readSuggestions(parsedImprove)
}

/** The tool text/`done_when` cap `todo_write` enforces; planned items obey the same one
 * so a harness-written plan is indistinguishable from a model-written one. */
const TODO_TEXT_CAP = 200

export function clipTodoText(text: string): string {
  const t = text.trim()
  return t.length <= TODO_TEXT_CAP ? t : `${t.slice(0, TODO_TEXT_CAP - 1)}…`
}

/** The decomposer behind the seeded plan: for a task big enough that criteria alone are
 * a poor path (many criteria, or agreed seams between files), one forced call turns the
 * contract into ordered implementation steps — each with its own checkable done_when.
 * The schema is the discipline: `required` fields are what "write it in detail" means
 * when asking nicely has a measured hit rate of 0/703. */
/** Shape only — the rules live in `decomposeTodos`'s ask, because a `response_format`
 * schema is compiled to a grammar and never rendered. */
const PLAN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['items'],
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'done_when', 'files'],
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          done_when: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
}

function readPlannedTodos(parsed: unknown): TodoItem[] | null {
  if (typeof parsed !== 'object' || parsed === null) return null
  const raw = (parsed as Record<string, unknown>)['items']
  if (!Array.isArray(raw)) return null
  const items: TodoItem[] = []
  for (const entry of raw.slice(0, 12)) {
    if (typeof entry !== 'object' || entry === null) continue
    const o = entry as Record<string, unknown>
    if (typeof o['title'] !== 'string' || o['title'].trim() === '') continue
    if (typeof o['done_when'] !== 'string' || o['done_when'].trim() === '') continue
    const files = Array.isArray(o['files'])
      ? o['files'].filter((f): f is string => typeof f === 'string' && f.trim() !== '')
      : []
    const suffix = files.length > 0 ? ` [${files.join(', ')}]` : ''
    items.push({
      text: clipTodoText(`${o['title'].trim()}${suffix}`),
      status: 'pending',
      done_when: clipTodoText(o['done_when']),
    })
  }
  return items.length >= 2 ? items : null
}

/**
 * One forced call over the shared transcript prefix, exactly like the distiller it runs
 * beside. The contract says what "done" means; this says the path — and it exists
 * because a model that works well WITH a plan writes one on its own almost never
 * (measured 0/703 for a system-prompt ask). Null degrades to the criteria scaffold.
 */
export async function decomposeTodos(
  client: LlamaClient,
  transcript: readonly ChatMessage[],
  contract: TaskContract,
  signal?: AbortSignal,
  /** The session's own tool array. This runs immediately after `distillContract`, so leaving
   * it on a different array would evict the prefix that call just warmed. */
  tools?: readonly ToolSchema[],
): Promise<TodoItem[] | null> {
  const messages: ChatMessage[] = [
    ...distillContext(transcript),
    {
      role: 'user',
      content:
        `[${renderContract(contract)}]\n\n` +
        '[Before any work starts: give the ordered implementation steps for the contract ' +
        'above. Two to twelve of them, in execution order. Steps are the PATH; the contract ' +
        'criteria stay the definition of done.\n\n' +
        // Out of PLAN_TOOL's `description` fields, which are no longer rendered. The English
        // pin is the half that matters most — these titles are shown to the user.
        'title — one implementation step, imperative, specific to THIS task.\n' +
        'done_when — how this step is known to be done, answerable by looking at a file or ' +
        'running a command.\n' +
        'files — the files this step touches, when the contract names them; an empty list ' +
        'otherwise.\n\n' +
        'Write them IN ENGLISH, whatever language the task is in. Do not begin the work. ' +
        'Answer with JSON only.]',
    },
  ]
  const parsed = await forcedJson(client, {
    messages,
    name: 'plan',
    schema: PLAN_SCHEMA,
    maxTokens: DISTILL_MAX_TOKENS,
    disableThinking: true,
    ...(tools ? { tools } : {}),
    ...(signal ? { signal } : {}),
  })
  return parsed === null ? null : readPlannedTodos(parsed)
}

export function renderContract(c: TaskContract): string {
  // Defensive against a hand-edited or corrupt meta file: this renders inside the
  // compaction swap, where a throw would cost the swap itself.
  const criteria = Array.isArray(c.criteria) ? c.criteria : []
  const constraints = Array.isArray(c.constraints) ? c.constraints : []
  const lines = [
    'TASK CONTRACT — the current task, held across the whole session:',
    `Goal: ${c.goal}`,
    'Done only when every one of these holds:',
    ...criteria.map((cr, i) => `  ${i + 1}. ${cr}`),
  ]
  if (constraints.length > 0) {
    lines.push('Must not happen:', ...constraints.map((x) => `  - ${x}`))
  }
  if (c.interfaces !== undefined) {
    lines.push('Agreed seams between files (write bodies to match these):', `  ${c.interfaces}`)
  }
  if (typeof c.checkedState === 'string' && c.checkedState !== '') {
    lines.push(`Last audit: ${c.checkedState}`)
  }
  return lines.join('\n')
}

/** Words carrying no identity of their own, ignored when a restatement is scored against
 * a criterion: they are in every English sentence, so counting them would let a short
 * generic phrase look like a strong match for anything. */
const MATCH_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'by', 'for', 'from', 'has', 'have',
  'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'their', 'them', 'then',
  'they', 'this', 'to', 'was', 'were', 'when', 'which', 'with',
])

/** Case, punctuation and dash style folded away: the model restates a criterion with a
 * trailing period, straight quotes for curly ones, or a hyphen where the contract had an
 * em dash, and none of those are a different criterion. Splitting on every non-alphanumeric
 * run also folds the numbering the audit prompt itself adds ("1. tests pass"). Unicode
 * letters are kept as letters so a Russian-language contract normalises the same way. */
function matchWords(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w !== '')
}

/**
 * Whether two lines say the same thing — the pairwise sibling of `matchCriterionIndex`.
 *
 * Used to compare one reading of a request against another (`understanding.ts`), where there
 * is no list to disambiguate against, only two sentences. The first two rules are the same
 * ones the audit uses and are safe pairwise: identical once punctuation, case and dash style
 * are folded, or one is a contiguous word-run inside the other ("keeps its padding" inside
 * "the invoice number keeps its padding").
 *
 * The third is deliberately stricter than the audit's. There, an unmatched report is
 * SURFACED, so a miss is loud; here a false match quietly merges two readings and hides the
 * disagreement that was the entire point of taking them. So containment by content words
 * also requires the shorter line to carry at least half the longer one's content — without
 * that, a three-word line is a subset of half of everything and every difference dissolves.
 */
/**
 * A word with its inflection knocked off, crudely.
 *
 * `matchCriterionIndex` deliberately does no stemming and says so: there, an unmatched report
 * is surfaced loudly, so a miss is cheap and a wrong tick is not. Here the trade runs the
 * other way. Two readings of one request differ mostly by MORPHOLOGY — measured live on this
 * model: "invoice numbers are never skipped" against "invoice numbers never skip a value",
 * and "every call site now invokes X" against "every call site that used X now uses X". Left
 * unstemmed those are two questions about one thing, which is precisely the noise this whole
 * feature exists to remove.
 *
 * A false merge is also the cheaper mistake HERE specifically, and only because of how the
 * question is built: a merged line becomes SHARED, and shared lines are stated to the person
 * verbatim ("here is what I am about to do"). So an over-merge still reaches their eyes — it
 * just arrives as a statement instead of a question. An under-merge is what fills the card
 * with three phrasings of one sentence.
 *
 * Latin suffixes first, then the Russian endings, because the model answers in the language
 * of the request and both turn up. Short words are left alone: they are mostly stopwords
 * already, and stemming them is how "use" and "us" become the same token.
 */
function stem(word: string): string {
  if (word.length < 4) return word
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (word.length - suffix.length >= 3 && word.endsWith(suffix)) {
      const cut = word.slice(0, word.length - suffix.length)
      // "skipped" -> "skipp" -> "skip": a doubled final consonant is an artefact of the
      // suffix, not part of the word.
      const last = cut[cut.length - 1]
      const before = cut[cut.length - 2]
      return last !== undefined && last === before && !'aeiou'.includes(last) ? cut.slice(0, -1) : cut
    }
  }
  for (const suffix of ['ами', 'ями', 'ов', 'ев', 'ах', 'ях', 'ый', 'ая', 'ое', 'ые', 'ой', 'ем', 'ом']) {
    if (word.length - suffix.length >= 3 && word.endsWith(suffix)) return word.slice(0, word.length - suffix.length)
  }
  for (const suffix of ['а', 'я', 'ы', 'и', 'е', 'у', 'ю', 'о']) {
    if (word.length - suffix.length >= 4 && word.endsWith(suffix)) return word.slice(0, word.length - suffix.length)
  }
  return word
}

/**
 * Whether `wider` says everything `narrower` says, and more.
 *
 * The sibling of `alignReadings`, for the case where two lines have ALREADY been found to
 * say the same thing and the question is which of them to keep. Content words only, on the
 * same stemming and the same stopword list, so the two notions cannot drift apart: a line
 * whose content words are a strict superset carries the other's meaning plus something the
 * other does not have.
 *
 * Written for `foldAnswer`, where a person ticking a reading of the request must be able to
 * SHARPEN a criterion without either duplicating it or quietly narrowing it.
 */
/**
 * How many content words two lines have in common, on the same stemming and stopword list as
 * `alignReadings` and `readingCovers`.
 *
 * A floor rather than a verdict. Whether two lines say the same thing is a judgement this
 * codebase delegates to the model (`foldAnswerWithModel`), and measured it is mostly right --
 * but when it is wrong it is wrong in the direction that costs something, merging a ticked
 * line the criteria do not cover. Observed: "totals are shown with a thousands separator" was
 * merged into "every amount is rounded half-up to two decimals before it is summed", which
 * share NO content words at all, while every correct merge observed shared at least two.
 * Lines that are not even about the same things are not the same requirement.
 */
export function sharedContentWords(a: string, b: string): number {
  const content = (text: string): Set<string> =>
    new Set(matchWords(text).map(stem).filter((w) => !MATCH_STOPWORDS.has(w)))
  const wa = content(a)
  let shared = 0
  for (const word of content(b)) if (wa.has(word)) shared++
  return shared
}

export function readingCovers(wider: string, narrower: string): boolean {
  const content = (text: string): Set<string> =>
    new Set(matchWords(text).map(stem).filter((w) => !MATCH_STOPWORDS.has(w)))
  const w = content(wider)
  const n = content(narrower)
  if (n.size === 0 || w.size <= n.size) return false
  for (const word of n) if (!w.has(word)) return false
  return true
}

export function alignReadings(a: string, b: string): boolean {
  const wa = matchWords(a).map(stem)
  const wb = matchWords(b).map(stem)
  if (wa.length === 0 || wb.length === 0) return false
  if (wa.join(' ') === wb.join(' ')) return true

  // The size guard, and it gates BOTH containment rules below rather than only the last.
  // A three-word line is a subset — and often a leading run — of half of everything, so
  // without it "the counter" and "the counter is row-locked, gap-free and per-year" merge
  // into one line and the specific half is never asked about. The legitimate case the
  // containment rules exist for is a restatement that drops a trailing clause, and that keeps
  // most of its content: "the invoice number keeps its padding" against the same line plus
  // "when the year rolls over" passes this comfortably.
  const content = (words: string[]): string[] => [...new Set(words)].filter((w) => !MATCH_STOPWORDS.has(w))
  const ca = content(wa)
  const cb = content(wb)
  const [short, long] = ca.length <= cb.length ? [ca, cb] : [cb, ca]
  if (short.length < 2) return false
  // A third, not a half. Measured live: the same outcome came back as four content words
  // from one lens and twelve from another, because one of them padded its line with an
  // example — and a half-length floor split them into two questions about one thing. See the
  // note above on why an over-merge is the cheaper mistake here.
  if (short.length * 3 < long.length) return false

  const runOf = (hay: string[], needle: string[]): boolean =>
    needle.length > 0 && needle.length <= hay.length &&
    ` ${hay.join(' ')} `.includes(` ${needle.join(' ')} `)
  if (runOf(wa, wb) || runOf(wb, wa)) return true

  const inLong = new Set(long)
  return short.every((w) => inLong.has(w))
}

/**
 * Which criterion a reported item is talking about, or `null` when nothing can be said.
 *
 * The rule, in order, and it is deliberately three narrow steps rather than a similarity
 * score with a threshold — a wrong tick is worse than no tick, because a criterion marked
 * met is one nothing will look at again:
 *   1. the normalised words are identical (punctuation, case and dash style folded);
 *   2. one side's normalised words are a contiguous run inside the other's — a criterion
 *      quoted with a "Criterion 2:" prefix, or a restatement that drops a trailing clause;
 *   3. every content word of the restatement (stopwords dropped) appears in the criterion,
 *      there are at least two such words, AND no other criterion swallows them too — an
 *      ambiguous restatement matches nothing rather than the first plausible criterion.
 *
 * Comparison stays literal word by word: "fails" and "failed" are different words here, and
 * no stemming is attempted. A restatement that re-inflects every content word falls through
 * to `unmatched`, which callers must SURFACE — being told the audit named a gap we could not
 * place is recoverable, quietly ticking the wrong criterion is not.
 *
 * Step 3 is what the exact-equality version could not do. Measured case: the harness's own
 * bugfix criterion, "A reproduction (script or test) demonstrably FAILED before the fix —
 * its red run is in the conversation — and passes after it", audited back as "Reproduction
 * test failed before and passes after." Under `===` that reported gap matched no criterion
 * at all, so all three criteria were written into `checkedState` as met and promoted into
 * message 0 as "Last audit: 1,2,3 met" at every later swap, while the fix round for it was
 * still running.
 */
function matchCriterionIndex(criteria: readonly string[], reported: string): number | null {
  const want = matchWords(reported)
  if (want.length === 0) return null
  const all = criteria.map((c) => matchWords(c))
  // Padded on both sides so the containment test lands on WORD boundaries: without the
  // pad, "test" would be a run inside "testing the fixture".
  const runOf = (hay: string[], needle: string[]): boolean =>
    needle.length > 0 && needle.length <= hay.length &&
    ` ${hay.join(' ')} `.includes(` ${needle.join(' ')} `)

  const exact = all.findIndex((c) => c.join(' ') === want.join(' '))
  if (exact !== -1) return exact

  // Containment resolves to the MOST SPECIFIC criterion, not the first one that fits: with
  // criteria "tests pass" and "all tests pass on Windows", a report of the second contains
  // the first as a run as well, and taking the first hit would tick the wrong line. A tie
  // at the longest length is genuinely ambiguous and matches nothing.
  const contained = all.flatMap((c, i) => (runOf(c, want) || runOf(want, c) ? [i] : []))
  if (contained.length > 0) {
    const longest = Math.max(...contained.map((i) => all[i]!.length))
    const best = contained.filter((i) => all[i]!.length === longest)
    return best.length === 1 ? best[0]! : null
  }

  const distinctive = [...new Set(want)].filter((w) => !MATCH_STOPWORDS.has(w))
  if (distinctive.length < 2) return null
  const swallows = all.flatMap((c, i) => {
    const words = new Set(c)
    return distinctive.every((w) => words.has(w)) ? [i] : []
  })
  return swallows.length === 1 ? swallows[0]! : null
}

/**
 * The report's gaps, resolved to criterion positions — the one place that decides what
 * "the audit says criterion N is unmet" means. Shared by `renderCheckedState` and by the
 * session's plan sync so the contract note and the user's Plan card can never disagree
 * about which items the audit affirmed.
 *
 * `unmatched` is the honest remainder: a reported gap that names no recognisable criterion
 * is still a gap, and swallowing it silently is exactly how a contract came to read
 * "1,2,3 met" while a fix round ran. Callers must surface it, not drop it.
 */
export function resolveReportedCriteria(
  criteria: readonly string[], report: AcceptanceReport,
): { unmetByIndex: Map<number, string>; unmatched: { criterion: string; why: string }[] } {
  const unmetByIndex = new Map<number, string>()
  const unmatched: { criterion: string; why: string }[] = []
  for (const item of report.unmet) {
    const i = matchCriterionIndex(criteria, item.criterion)
    if (i === null) unmatched.push(item)
    else if (!unmetByIndex.has(i)) unmetByIndex.set(i, item.why)
  }
  return { unmetByIndex, unmatched }
}

/** Bounded for message 0, and it says when it cut: an audit note that quietly ends
 * mid-sentence reads as the model having stopped mid-thought. */
function clipReason(text: string, cap: number): string {
  const t = text.trim()
  return t.length <= cap ? t : `${t.slice(0, cap - 1)}…`
}

/**
 * The one-line audit trail `TaskContract.checkedState` holds, built from a report:
 * met criteria by NUMBER (they need no explanation), unmet ones by number WITH the reason
 * (the reason is the pointer the model acts on), and last any gap that named no criterion
 * we could place — spelled out in full rather than dropped, because that gap is the one
 * the numbering cannot carry.
 */
export function renderCheckedState(contract: TaskContract, report: AcceptanceReport): string {
  const criteria = Array.isArray(contract.criteria) ? contract.criteria : []
  const { unmetByIndex, unmatched } = resolveReportedCriteria(criteria, report)
  const met: number[] = []
  const unmet: string[] = []
  for (let i = 0; i < criteria.length; i++) {
    const why = unmetByIndex.get(i)
    if (why === undefined) met.push(i + 1)
    else unmet.push(`${i + 1} UNMET (${clipReason(why, 120)})`)
  }
  const parts: string[] = []
  if (met.length > 0) parts.push(`${met.join(',')} met`)
  parts.push(...unmet)
  for (const u of unmatched) {
    parts.push(`UNMET, not matched to a criterion: "${clipReason(u.criterion, 120)}" ` +
      `(${clipReason(u.why, 120)})`)
  }
  return parts.length === 0 ? 'no criteria matched the report' : parts.join('; ')
}

/**
 * True when a closing text reads as "I am finished" — in either language this model
 * actually answers in. Shared by the unattended runner (which ends the run on it) and the
 * acceptance gate (which runs on it): the audit is worth its cache displacement exactly
 * when the model claims the task is over, and an intermediate turn's work is re-audited by
 * whichever later turn finally claims it.
 *
 * Deliberately narrow, with hedge guards on the Russian half: a false "finished" ends a
 * run mid-work (or wastes an audit), and the Russian equivalents of "almost done" /
 * "half-finished" are continuations, not endings. (The Russian patterns below are
 * DETECTION MACHINERY for input in that language, kept on purpose — every word the app
 * itself says is English.)
 *
 * Scans the head AND tail of the message, not just the tail: the model's live style is
 * often the finish word first followed by a long report, which a tail-only window
 * misses. The middle stays unscanned — that is where quoted text lives. `\b` cannot
 * guard the Russian words (JS word boundaries are ASCII-only and never match beside
 * Cyrillic); a Cyrillic lookbehind does the same job.
 *
 * Both halves are sentence-scoped rather than one phrase regex: live answers decline
 * freely through real morphology, so a fixed word order keeps losing. A sentence
 * carrying a finish phrase counts unless that SAME sentence also carries a hedge or
 * negation word ("not all done yet") — the veto stays sentence-local so an honest
 * caveat elsewhere is not silenced. The Russian idioms whose canonical form contains
 * the negation word ("nothing left to do") are matched before the veto, or they could
 * never fire at all.
 */
/**
 * The shapes a finish claim actually takes, and the list grows from observation rather than
 * imagination — every miss here silently disables the acceptance audit AND the diff review,
 * because both hang off this one boolean.
 *
 * Added after a live run ended "All 7 steps complete. Here's the summary:" and neither gate
 * fired: the task was finished, well, and nothing checked it. The plan-shaped endings are the
 * common ones now that the model actually keeps a plan — "all 7 steps complete", "all steps
 * done" — and the noun-phrase endings ("the fix is complete", "implementation finished") are
 * the other half of the same habit.
 */
const EN_FINISH = /\b(all done|everything (is )?(now )?(done|finished|complete)|task (is )?complete|all \d+ steps? (are )?(complete|completed|done|finished)|all (the )?steps? (are )?(complete|completed|done|finished)|(the )?(work|implementation|fix|change|refactor)s? (is|are) (now )?(complete|completed|done|finished)|nothing (else|more) (left )?to do|no (further|more) (work|changes) (is |are )?(needed|required))\b/

const RU_NEGATION_IDIOM = /(больше (ничего|нечего) (не осталось|делать)|ничего больше делать не (нужно|требуется))/
const RU_FINISH = /((всё|все) готово|(?<![а-яё-])готово$)/
const RU_TASK_DONE = /(задач[аи]|работ[аы]).{0,80}?(выполнен|заверш[её]н|закончен)/
const HEDGE_VETO = new Set([
  'not', 'yet', 'almost', 'nearly', 'partially', 'but', 'however',
  'remains', 'remaining', 'unfinished',
  'не', 'нет', 'почти', 'наполовину', 'частично', 'пока',
  'но', 'однако', 'осталось', 'осталась', 'остались', 'остался',
])

function sentenceSaysFinished(window: string): boolean {
  return window.split(/[.!\n]+/).some((raw) => {
    const sentence = raw.trim()
    if (sentence.length === 0) return false
    // A question is not a claim: "All done?" carries the finish words without the finish.
    if (sentence.includes('?')) return false
    if (RU_NEGATION_IDIOM.test(sentence)) return true
    if (!EN_FINISH.test(sentence) && !RU_FINISH.test(sentence) && !RU_TASK_DONE.test(sentence)) {
      return false
    }
    return !sentence.split(/[^a-zа-яё0-9]+/).some((word) => HEDGE_VETO.has(word))
  })
}

export function saysFinished(text: string): boolean {
  const whole = text.trim().toLowerCase()
  const windows = whole.length <= 800 ? [whole] : [whole.slice(0, 400), whole.slice(-400)]
  return windows.some(sentenceSaysFinished)
}

// ---------------------------------------------------------------------------------------
// The acceptance gate
// ---------------------------------------------------------------------------------------

export interface AcceptanceReport {
  /** Criteria the check could not stand behind, each with the reason. */
  unmet: { criterion: string; why: string }[]
  /** How many criteria were affirmed with evidence. */
  met: number
  /**
   * The affirmed criteria AS THE AUDIT NAMED THEM, beside the count of them.
   *
   * The count alone cannot answer the question that matters — WHICH criteria the audit
   * actually looked at — and without that, a criterion the report simply never mentioned
   * was indistinguishable from one it affirmed. See `withUnreportedCriteria`.
   *
   * Optional so a report built by hand (tests, older callers) still typechecks; absent
   * means "nothing is known to have been affirmed", which is the safe reading.
   */
  metCriteria?: string[]
  /**
   * Which criteria the audit reported on at all, as 0-based indices into `contract.criteria`.
   *
   * The audit answers by NUMBER now, so coverage is a fact rather than an inference: this is
   * exactly the set it spoke about, with no matching involved. `withUnreportedCriteria` reads
   * it and falls back to the text matcher only for a report built the old way.
   */
  reported?: number[]
}

/**
 * The shape the audit's answer is held to, enforced by the sampler — see `forcedJson` for
 * why this is a `response_format` schema and no longer a one-tool `tools` array.
 *
 * The audit answers with the criterion's NUMBER, not its text, and that one change removes a
 * whole apparatus. Asked to retype each criterion, the model paraphrased — which is why
 * `matchCriterionIndex` exists at all, with its three fallback passes — and a paraphrase that
 * matched nothing then produced a gap belonging to no criterion, or a criterion that looked
 * unreported while its restatement sat in the same list. An integer cannot paraphrase: the
 * grammar bounds it to 1..n, so coverage is exact and every criterion string downstream is
 * the contract's own.
 *
 * It is also the cheapest thing in the file to fix under Law 2. Retyping six criteria costs
 * ~180 output tokens a round, twice a task at MAX_ACCEPTANCE_ROUNDS — about 8.6 s at the
 * measured 42 tok/s, spent restating text the prompt already numbered two lines above.
 *
 * Per-call rather than a module constant, because `maximum` is the contract's own length:
 * that is what makes an out-of-range index unreachable rather than merely unlikely.
 */
function acceptanceSchema(criteriaCount: number): Record<string, unknown> {
  return {
    type: 'object',
    required: ['items'],
    additionalProperties: false,
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          // `evidence` BEFORE `met`, and the order is load-bearing rather than cosmetic:
          // `response_format` compiles to a grammar that emits properties in the order the
          // schema declares them, so `met` first made the model commit to a verdict and then
          // write the justification for a verdict it had already given. The ask defines `met`
          // IN TERMS OF the evidence, and `disableThinking` leaves no scratchpad to work it
          // out in first. Verified that the grammar really does fix the order: asked
          // explicitly, in the user message, to write the keys as evidence-then-met-then-index,
          // the server returned index-then-met-then-evidence anyway.
          required: ['index', 'evidence', 'met'],
          additionalProperties: false,
          properties: {
            index: { type: 'integer', minimum: 1, maximum: Math.max(1, criteriaCount) },
            evidence: { type: 'string' },
            met: { type: 'boolean' },
          },
        },
      },
    },
  }
}

/** Room for 8 criteria each with a paragraph of evidence, several times over — see the
 * cap rule above; 900 died on the first live six-criterion task. */
const ACCEPTANCE_MAX_TOKENS = 4_000

/**
 * The end-of-turn question, asked as a skeptic and answered under force.
 *
 * Same-context self-review has a known bias — the writing context believes its own work —
 * so the instruction is phrased to hunt for the UNMET ("which of these can you not prove"),
 * and the ask defines evidence so that assertion-without-demonstration is a `met: false` by
 * definition. That sentence lives in the ASK and not in the schema: the shape is forced by a
 * `response_format` schema, which is compiled to a grammar and never rendered, so a
 * `description` on it is invisible to the model. This will not catch everything; it reliably
 * catches the measured failure class of criteria that were simply forgotten.
 */
export async function checkAcceptance(
  client: LlamaClient,
  transcript: readonly ChatMessage[],
  contract: TaskContract,
  signal?: AbortSignal,
  /** The session's own tool array, passed straight through so this request stays a pure
   * append onto the already-warm prompt. See `forcedJson`: sending a one-tool array
   * instead cost a measured 61.9 s of re-prefill per gate. */
  tools?: readonly ToolSchema[],
): Promise<AcceptanceReport | null> {
  const messages: ChatMessage[] = [
    ...transcript,
    {
      role: 'user',
      content:
        '[Before this turn may end: audit the work above against the task contract, ' +
        'one item per criterion, in order:\n' +
        contract.criteria.map((c, i) => `${i + 1}. ${c}`).join('\n') +
        '\nBe a skeptic about your own work: a criterion nothing in this conversation ' +
        'demonstrates is NOT met, however confident you feel.\n\n' +
        // Moved out of the schema's `evidence` description: a response_format schema is
        // compiled to a grammar and never rendered, so an instruction left there is invisible.
        // This one defines what the whole audit MEANS by "met", and it is the sentence that
        // turns assertion-without-demonstration into met:false by definition.
        'For each criterion give the evidence: what in THIS conversation demonstrates it — a ' +
        'command that ran and its result, a diff that landed, a file that was read back. ' +
        '"I implemented it" is not evidence; if nothing demonstrates it, met is false. ' +
        // Added after measuring the failure it describes: with the rule finally present as a
        // criterion, the audit still affirmed it 3 times out of 3 by READING the code and
        // agreeing with it, while `slug('Hello, World!')` returned `'hello,-world!'`. Code
        // that looks like it implements a rule is the assertion, not the demonstration.
        'A criterion that states a rule over EVERY input needs the rule to have been ' +
        'EXERCISED. Reading the implementation and agreeing with it is an assertion, not a ' +
        'demonstration — you cannot run code in your head, and a rule that merely looks right ' +
        'is how this audit affirmed a task while the rule was false. What met looks like is a ' +
        'run over inputs that would BREAK the rule if it were wrong — a character nobody ' +
        'listed, an empty string, something already in the target form — with its output ' +
        'visible. Such a run is enough; it does not have to name every input. If the only ' +
        'evidence is the code itself, met is false, and say which input is missing. ' +
        'Report one item per criterion, and report on EVERY criterion above.\n\n' +
        // The pin every other gate carries. This one's `evidence` is not internal: it goes
        // into `contract.checkedState`, which `renderContract` promotes into MESSAGE 0 at
        // every compaction swap, and `acceptanceFailureMessage` puts it on screen as a note
        // row. Measured against a Russian transcript, the shipped ask answered in Russian
        // ("В сообщении прямо указано: «Тесты я не запускал.»") and that sentence reached
        // both places — while the diff reviewer, whose brief is English, answered in English
        // over the same conversation.
        'Write every word of your answer IN ENGLISH, whatever language the conversation ' +
        'above is in.\n\n' +
        'Answer with JSON only.]',
    },
  ]
  const parsed = await forcedJson(client, {
    messages,
    name: 'acceptance',
    schema: acceptanceSchema(contract.criteria.length),
    maxTokens: ACCEPTANCE_MAX_TOKENS,
    disableThinking: true,
    ...(tools ? { tools } : {}),
    ...(signal ? { signal } : {}),
  })
  return parsed === null ? null : readAcceptance(parsed, contract.criteria)
}

/** The same reading, from JSON text — for callers that already hold a string. */
export function parseAcceptance(argsJson: string, criteria: readonly string[]): AcceptanceReport | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(argsJson)
  } catch {
    return null
  }
  return readAcceptance(parsed, criteria)
}

/**
 * The audit's answer, resolved against the contract it was asked about.
 *
 * Every criterion string here is the CONTRACT'S OWN, looked up by the reported number — the
 * model never supplies text, so there is nothing to paraphrase and nothing to match. An index
 * outside the contract is dropped rather than guessed at; the grammar makes it unreachable,
 * and a report that somehow arrived by another route should lose the item, not invent one.
 */
function readAcceptance(parsed: unknown, criteria: readonly string[]): AcceptanceReport | null {
  const items = (parsed as { items?: unknown })?.items
  if (!Array.isArray(items)) return null
  const unmet: { criterion: string; why: string }[] = []
  const metCriteria: string[] = []
  const reported: number[] = []
  const seen = new Set<number>()
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null) continue
    const item = raw as Record<string, unknown>
    const n = item['index']
    if (typeof n !== 'number' || !Number.isInteger(n)) continue
    const i = n - 1
    const criterion = criteria[i]
    // A repeated number is the same criterion twice; the first verdict stands, the way
    // `resolveReportedCriteria` has always taken the first reading of a repeated gap.
    if (criterion === undefined || seen.has(i)) continue
    seen.add(i)
    reported.push(i)
    if (item['met'] === true) metCriteria.push(criterion)
    else unmet.push({ criterion, why: typeof item['evidence'] === 'string' ? item['evidence'] : 'not demonstrated' })
  }
  if (metCriteria.length === 0 && unmet.length === 0) return null
  return { unmet, met: metCriteria.length, metCriteria, reported }
}

/** What an unreported criterion is recorded as. Worded as a gap in the AUDIT, not in the
 * work: the fixer must go and demonstrate it, not assume the work is missing. */
export const UNREPORTED_REASON = 'the audit did not report on this criterion'

/**
 * Every criterion the report simply did not mention, promoted to UNMET.
 *
 * `parseAcceptance` derives its verdicts only from the items the model returned, and the
 * only emptiness guard is "no items at all" — so a report covering 3 of 5 criteria parsed
 * perfectly clean. Downstream, `renderCheckedState` treats "no gap recorded for criterion
 * i" as an affirmation (`if (why === undefined) met.push(i + 1)`), which makes the ABSENCE
 * of a report indistinguishable from an affirmation. A short report therefore ended the
 * turn: `checkedState` promoted "1,2,3,4,5 met" into message 0 at every later swap, the
 * plan ticked, and `contract.satisfied` retired the gate for good — over criteria nothing
 * had ever looked at. That is the exact failure this file's header says it exists to stop,
 * arriving through the audit instead of through the model's confidence.
 *
 * The schema cannot prevent it either: ACCEPTANCE_SCHEMA's `items` array carries no
 * `minItems`, so a short list is a legal generation. So it is repaired here rather than
 * requested: coverage is CODE, like every other structural guarantee in this design.
 *
 * Returns the report unchanged when the audit covered everything, so the common path
 * allocates nothing and behaves exactly as before.
 */
export function withUnreportedCriteria(
  criteria: readonly string[], report: AcceptanceReport,
): AcceptanceReport {
  // `reported` is the audit's own numbering, so coverage is exact and nothing has to be
  // matched. That also closes the double-report this function used to produce: when the
  // model paraphrased a criterion into something the matcher could not place, the
  // paraphrase stayed in `unmet` AND the criterion was appended as unreported, so the
  // fixer got the same criterion twice with contradictory reasons — one of which no edit
  // could ever close — and `unmet.length` could exceed `criteria.length`.
  const covered = new Set<number>(report.reported ?? [])
  if (report.reported === undefined) {
    for (const item of report.unmet) {
      const i = matchCriterionIndex(criteria, item.criterion)
      if (i !== null) covered.add(i)
    }
    for (const text of report.metCriteria ?? []) {
      const i = matchCriterionIndex(criteria, text)
      if (i !== null) covered.add(i)
    }
  }
  const missing = criteria.filter((_, i) => !covered.has(i))
  if (missing.length === 0) return report
  return {
    ...report,
    unmet: [...report.unmet, ...missing.map((criterion) => ({ criterion, why: UNREPORTED_REASON }))],
  }
}

/** What the fixer round is told. Names only the gaps — the criteria already sit in the
 * contract note above, and repeating the met ones invites re-doing finished work. */
/** The opener the acceptance fixer message starts with. Exported so `replay.ts` can tell a
 * harness message from something a person typed — see `HARNESS_OPENERS` there. */
export const ACCEPTANCE_FIXER_PREFIX = 'The task contract is not fully met yet. Unmet criteria:'

export function acceptanceFailureMessage(report: AcceptanceReport): string {
  const gaps = report.unmet.map((u) => `- ${u.criterion}\n  (${u.why})`).join('\n')
  return `${ACCEPTANCE_FIXER_PREFIX}\n` + gaps +
    '\n\nClose these gaps now. If one is genuinely impossible or wrong, say why in one ' +
    'sentence instead of working around it.'
}

// ---------------------------------------------------------------------------------------
// The fresh-context diff review
// ---------------------------------------------------------------------------------------

export interface ReviewIssue {
  where: string
  what: string
}

/** The verdict's shape, forced by the sampler — see `forced-json.ts`. The prose that has to
 * REACH the model lives in the ask in `reviewVerdict`, because a `response_format` schema is
 * compiled to a grammar and never rendered. */
const REVIEW_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['goalMet', 'goalGap', 'issues'],
  additionalProperties: false,
  properties: {
    // Asked SEPARATELY from the defect list, and required — which is the whole fix. See
    // `reviewVerdict`.
    goalMet: { type: 'boolean' },
    goalGap: { type: 'string' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['where', 'what'],
        additionalProperties: false,
        properties: {
          where: { type: 'string' },
          what: { type: 'string' },
        },
      },
    },
  },
}

/** The reviewer THINKS (judgment, not restating): measured median thinking on hard work
 * is 5591 tokens with a tail past 6100, plus the verdict itself — 8000 total was thin at
 * the tail, and a `length` finish silently skips the review. See the cap rule above. */
const REVIEW_MAX_TOKENS = 12_000

/** Below this much diff, the acceptance check already looked at everything that happened
 * and an independent reader has nothing extra to see. */
export const DIFF_REVIEW_MIN_CHARS = 2_000

/** ~40k tokens of diff — the 262k window affords a real read, and a clipped review is a
 * review of something else. Still announced in-text when it does clip, so the reviewer
 * knows it saw a part rather than believing it saw the whole. */
const DIFF_REVIEW_MAX_CHARS = 160_000

/**
 * The same model, reading the diff with no memory of writing it.
 *
 * The writing context believes its own work — that is not a flaw to prompt away, it is
 * what holding a plan in context IS. So the reviewer gets a FRESH context: the contract,
 * the diff, and nothing else. No transcript, no reasoning that led to the code, no
 * "I already checked this". Costs one small prefill plus the displacement of the main
 * conversation's server cache — the caller marks the cache cold, exactly as a compaction
 * generation does.
 */
export const REVIEW_SYSTEM =
  'You are reviewing a change someone else made. You did not write it and you were not ' +
  'there for the conversation that produced it.\n\n' +
  'You can open files, and you should: read the code AROUND the change, not just the lines ' +
  'in it. A diff shows what moved and hides what it depends on, and most real defects live ' +
  'in that gap — a call to the wrong helper, an invariant kept somewhere else, a caller this ' +
  'breaks.\n\n' +
  'The question is not "are these lines correct". It is: DOES THIS ACTUALLY DO WHAT WAS ' +
  'ASKED, given the rest of the code? A change that is flawless on its own and leaves the ' +
  'goal unmet is the defect this review exists to find — the same broken invariant still ' +
  'reachable through another path, a caller that was never updated, a second place doing the ' +
  'old thing. Say so, and name the file, even when that file is nowhere in the diff.\n\n' +
  'What does NOT count is everything the change is not responsible for. You are not auditing ' +
  'the codebase and you are not reporting style. Pre-existing problems unrelated to this ' +
  'goal belong to somebody else. An empty list is a fine and common verdict.\n\n' +
  'Decide, and then stand behind it. Either something is a defect and you report it plainly, ' +
  'or it is out of scope and you leave it out — never both. A finding that ends "however this ' +
  'is out of scope" is worse than silence: whoever reads it cannot act on it and cannot ' +
  'dismiss it either. And note that SCOPE limits what may be changed, not what may be true: ' +
  'if the goal is still not met, saying so is always in scope, even when the cause sits in a ' +
  'file nobody asked you to touch.'

/**
 * What the reviewer is given, and the deliberate order of it.
 *
 * The USER'S OWN WORDS come first, above the contract. That is the fix for a blindness the
 * review had by construction: the contract is a distillation of the request, so a reading
 * error that happened during the distillation is baked into it, and a reviewer checking the
 * diff against the contract will happily confirm work that answers the wrong question. Only
 * the original words can catch that, and they cost nothing to carry.
 */
export function buildReviewBrief(contract: TaskContract, diffText: string, request?: string): string {
  const clipped = diffText.length > DIFF_REVIEW_MAX_CHARS
    ? `${diffText.slice(0, DIFF_REVIEW_MAX_CHARS)}\n[... diff clipped at ${DIFF_REVIEW_MAX_CHARS} characters]`
    : diffText
  const asked = request !== undefined && request.trim() !== ''
    ? `What the person actually asked for, in their words:\n\n    ${request.trim()}\n\n` +
      'That is what the change has to answer. What follows is somebody\'s summary of it — ' +
      'useful, but if the two disagree, the words above win.\n\n'
    : ''
  return `${asked}${renderContract(contract)}\n\nThe diff:\n\n${clipped}`
}

/**
 * The verdict itself: one forced generation over whatever the reviewer has looked at.
 *
 * Separate from the looking, because they want different things — the looking is a normal
 * agent turn with read-only tools, and this is a structured answer that must arrive whatever
 * happened during it. Same reason the understanding check splits its readings from its
 * grouping.
 */
export async function reviewVerdict(
  client: LlamaClient,
  messages: readonly ChatMessage[],
  signal?: AbortSignal,
  /** The tools the REVIEWER itself was given, unchanged. Passing them keeps this an append
   * onto the prefix the reviewer's own reading turn just warmed. A one-tool array instead
   * re-prefilled that entire transcript from zero at the end of every writing task — and by
   * this point the reviewer has read files around the change, so it is the fattest transcript
   * in the system: measured at ~19k tokens on a modest task and ~60k on a large one, which is
   * 26 s and 82 s of silence at 730 tok/s. */
  tools?: readonly ToolSchema[],
): Promise<ReviewIssue[] | null> {
  try {
    const result = await client.chat({
      messages: [
        ...messages,
        {
          role: 'user',
          content: '[Now the verdict. Two separate answers.\n\n' +
            'FIRST, goalMet. Is the goal actually achieved once the REST of the code is ' +
            'taken into account — not "is this diff correct", but "is the thing the user ' +
            'asked for now true of this codebase"? If the same problem is still reachable ' +
            'through another path, or a second place still does the old thing, then the goal ' +
            'is NOT met: answer false and put the file and the reason in goalGap.\n\n' +
            'Scope limits what may be CHANGED. It does not limit what is TRUE. A problem ' +
            'outside the diff is still the reason the goal is unmet, and saying so is always ' +
            'in scope — that is what this question is for. Do not leave it out because ' +
            'somebody else introduced it, because it is pre-existing, or because it is in a ' +
            'file nobody asked you to touch. If the goal IS met, answer true and leave ' +
            'goalGap empty.\n\n' +
            'SECOND, issues: defects in the change itself. For each one give WHERE — file ' +
            'and place, e.g. lib/stats.js percentile() — and WHAT the defect is and why it ' +
            'is one: a bug, a criterion the change contradicts, or a constraint it violates. ' +
            'Style is not a defect, and neither is anything this change is not responsible ' +
            'for. An empty list is fine if the change genuinely does the job.\n\n' +
            'Answer with JSON only.]',
        },
      ],
      ...(tools && tools.length > 0 ? { tools: [...tools] } : {}),
      jsonSchema: { name: 'review', schema: REVIEW_SCHEMA },
      maxTokens: REVIEW_MAX_TOKENS,
      // Thinking OFF, and this is a change from when the review was a single generation.
      // Then it had to do the judging here, and 12k tokens of it was justified by measured
      // reasoning lengths. Now the LOOKING does the judging — six steps of reading the code
      // around the change, with thinking on throughout — and this call only has to report
      // what that turn arrived at. Restating with thinking on is measured waste on this
      // server, and here it was worse than waste: at ~40 tok/s a full budget of it is five
      // minutes added to the end of every task, on top of the reading. Hit live.
      disableThinking: true,
      ...(signal ? { signal } : {}),
    })
    const text = result.message.content
    if (typeof text !== 'string' || text.trim() === '') return null
    return parseReview(text)
  } catch {
    return null // an unreviewed turn is the pre-review status quo, not a failure
  }
}

export function parseReview(argsJson: string): ReviewIssue[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(argsJson)
  } catch {
    return null
  }
  const obj = parsed as { issues?: unknown; goalMet?: unknown; goalGap?: unknown }
  const issues = obj?.issues
  if (!Array.isArray(issues)) return null
  const listed = issues
    .filter((i): i is Record<string, unknown> => typeof i === 'object' && i !== null)
    .filter((i) => typeof i['where'] === 'string' && typeof i['what'] === 'string')
    .map((i) => ({ where: i['where'] as string, what: i['what'] as string }))
    .slice(0, 10)

  // The GOAL answer, folded in as the first finding so every existing reader — the fixer
  // message, the event, the turn gate — treats it exactly like any other defect.
  //
  // This is the fix for the failure recorded in docs/SPIKE-KAT-CODER.md §9. The reviewer
  // used to be asked for a list of defects and nothing else, which let "is it a defect" and
  // "is it in scope" collapse into one judgement it could decline: watched twice on the same
  // planted case, it FOUND the second service still reading the counter unlocked, named it in
  // its prose, and then wrote "not reporting: out of scope" and returned an empty list — over
  // a goal that was not met. `REVIEW_SYSTEM` forbids exactly that, in three separate
  // sentences, and the model did it anyway; this codebase's own measured law says
  // instructions do not route behaviour and structure does. So the goal question is now a
  // required boolean the grammar will not let it omit, asked about the GOAL rather than about
  // the diff, and "out of scope" is no longer an expressible answer to it.
  if (obj?.goalMet === false) {
    const gap = typeof obj.goalGap === 'string' ? obj.goalGap.trim() : ''
    return [
      {
        where: 'the goal',
        what: gap === ''
          ? 'the reviewer reports the goal is still not met, but named no reason'
          : gap,
      },
      ...listed,
    ].slice(0, 10)
  }
  return listed
}

/** Same job as `ACCEPTANCE_FIXER_PREFIX`, for the diff reviewer's findings. */
export const REVIEW_FIXER_PREFIX = 'An independent review of this turn\'s diff found problems:'

export function reviewFailureMessage(issues: ReviewIssue[]): string {
  const list = issues.map((i) => `- ${i.where}: ${i.what}`).join('\n')
  return `${REVIEW_FIXER_PREFIX}\n` + list +
    '\n\nAddress each one, or say in one sentence why the reviewer is wrong about it.'
}
