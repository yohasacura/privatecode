import type { TodoItem } from '../interaction.js'
import type { LlamaClient } from '../llama/client.js'
import type { ChatMessage, ToolSchema } from '../llama/types.js'

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

const CONTRACT_TOOL: ToolSchema = {
  type: 'function',
  function: {
    name: 'set_contract',
    description: 'Record the task contract distilled from the user request.',
    parameters: {
      type: 'object',
      required: ['goal', 'criteria', 'constraints'],
      properties: {
        goal: { type: 'string', description: 'One sentence: what must exist when this is done.' },
        criteria: {
          type: 'array', items: { type: 'string' },
          description: 'Two to six checkable done-criteria. Each answerable yes/no by ' +
            'looking at a file or running a command. Never vague.',
        },
        constraints: {
          type: 'array', items: { type: 'string' },
          description: 'What must NOT change or be touched. Empty if the user named none.',
        },
        interfaces: {
          type: 'string',
          description: 'Only when several files must agree: the signatures/types/names ' +
            'they agree ON, pinned now. Omit otherwise.',
        },
        kind: {
          type: 'string', enum: ['bugfix', 'feature', 'other'],
          description: 'bugfix ONLY when the request reports existing behaviour as broken ' +
            'and asks to repair it; feature for new capability; other for the rest.',
        },
      },
    },
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
      if (typeof m.content !== 'string' || m.content.length <= DISTILL_TAIL_CLIP_CHARS) return m
      return {
        ...m,
        content: `${m.content.slice(0, DISTILL_TAIL_CLIP_CHARS)}\n[... clipped for contract distillation]`,
      }
    })
  return [...head, ...recent]
}

export async function distillContract(
  client: LlamaClient,
  transcript: readonly ChatMessage[],
  userText: string,
  signal?: AbortSignal,
): Promise<TaskContract | null> {
  const messages: ChatMessage[] = [
    ...distillContext(transcript),
    {
      role: 'user',
      content:
        `${userText}\n\n` +
        '[Before starting: distill this request into a contract with set_contract. ' +
        'Criteria must be CHECKABLE — a command that passes, a file that exists, an ' +
        'observable behaviour — and must cover everything the request asked, including ' +
        'anything it forbids. Keep the request\'s own specifics VERBATIM in the criteria: ' +
        '"invalid status TRANSITION rejected" must not soften into "status is from the ' +
        'valid set" — a generalized criterion passes work the user did not ask for. ' +
        'Do not begin the work yet.]',
    },
  ]
  try {
    const result = await client.chat({
      messages, tools: [CONTRACT_TOOL], toolChoice: 'required',
      maxTokens: DISTILL_MAX_TOKENS, disableThinking: true,
      ...(signal ? { signal } : {}),
    })
    const call = result.message.tool_calls?.[0]
    if (!call || call.function.name !== 'set_contract') return null
    return parseContract(call.function.arguments)
  } catch {
    // A distillation that failed must never cost the turn — the task simply runs the way
    // every task ran before contracts existed.
    return null
  }
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
  if (typeof parsed !== 'object' || parsed === null) return null
  const o = parsed as Record<string, unknown>
  const goal = typeof o['goal'] === 'string' ? o['goal'].trim() : ''
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : []
  const criteria = strings(o['criteria']).slice(0, 8)
  if (goal === '' || criteria.length === 0) return null
  const contract: TaskContract = { goal, criteria, constraints: strings(o['constraints']).slice(0, 8) }
  if (typeof o['interfaces'] === 'string' && o['interfaces'].trim() !== '') {
    contract.interfaces = o['interfaces'].trim()
  }
  if (o['kind'] === 'bugfix' || o['kind'] === 'feature' || o['kind'] === 'other') {
    contract.kind = o['kind']
  }
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
const IMPROVE_TOOL: ToolSchema = {
  type: 'function',
  function: {
    name: 'suggest_improvements',
    description: 'Suggest the structure a draft request is missing. Never begin the work.',
    parameters: {
      type: 'object',
      required: ['criteria', 'constraints', 'questions'],
      properties: {
        criteria: {
          type: 'array', items: { type: 'string' },
          description: 'Checkable done-criteria the draft IMPLIES, its specifics verbatim. ' +
            'Each answerable yes/no by looking at a file or running a command. Empty if none.',
        },
        constraints: {
          type: 'array', items: { type: 'string' },
          description: 'What the draft implies must NOT change. Empty if it implies none.',
        },
        questions: {
          type: 'array', items: { type: 'string' },
          description: 'Short questions for anything essential the draft leaves open — which ' +
            'files, what counts as done, what must not break. NEVER answer them yourself: a ' +
            'requirement the draft does not imply belongs here, not in criteria.',
        },
      },
    },
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
const EXPAND_TOOL: ToolSchema = {
  type: 'function',
  function: {
    name: 'expand_prompt',
    description: 'Rewrite a rough draft command as a detailed task brief. Never begin the work.',
    parameters: {
      type: 'object',
      required: ['expanded'],
      properties: {
        expanded: {
          type: 'string',
          description: 'The same request, written the way a careful colleague would brief ' +
            'it: name the concrete files, components, styles, tokens and conventions from ' +
            'THIS project the work should build on. WRITTEN IN THE LANGUAGE OF THE DRAFT ' +
            '— a Russian draft expands into Russian, never English. Only facts the ' +
            'context supports — anything essential it cannot answer stays a short open ' +
            'question inside the text. Plain prose, no headings.',
        },
      },
    },
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
): Promise<string | null> {
  const messages: ChatMessage[] = [
    ...distillContext(transcript),
    {
      role: 'user',
      content:
        `${draft}\n\n` +
        '[The user is still DRAFTING the rough request above — do not begin the work. ' +
        'Call expand_prompt with the same request expanded into a detailed brief: pull ' +
        'the concrete file paths, components, design tokens and conventions it should ' +
        'build on from the project context you already have (repo map, project notes, ' +
        'this conversation). Never invent a path or a value the context does not ' +
        'support — anything essential it cannot answer, keep as a short open question ' +
        'inside the text. Keep the user\'s intent exactly, and write the brief in the ' +
        'SAME LANGUAGE as the draft — a draft in another language expands in that language.]',
    },
  ]
  try {
    const result = await client.chat({
      messages, tools: [EXPAND_TOOL], toolChoice: 'required',
      maxTokens: DISTILL_MAX_TOKENS, disableThinking: true,
      ...(signal ? { signal } : {}),
    })
    const call = result.message.tool_calls?.[0]
    if (!call || call.function.name !== 'expand_prompt') return null
    return parseExpanded(call.function.arguments)
  } catch {
    return null
  }
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
): Promise<DraftSuggestions | null> {
  const messages: ChatMessage[] = [
    ...distillContext(transcript),
    {
      role: 'user',
      content:
        `${draft}\n\n` +
        '[The user is still DRAFTING the request above — do not begin the work. Call ' +
        'suggest_improvements with the checkable criteria and constraints the draft ' +
        'implies (keep its own specifics VERBATIM), and a question for each essential ' +
        'thing it leaves unspecified. Never invent a requirement the draft does not imply.]',
    },
  ]
  try {
    const result = await client.chat({
      messages, tools: [IMPROVE_TOOL], toolChoice: 'required',
      maxTokens: DISTILL_MAX_TOKENS, disableThinking: true,
      ...(signal ? { signal } : {}),
    })
    const call = result.message.tool_calls?.[0]
    if (!call || call.function.name !== 'suggest_improvements') return null
    return parseSuggestions(call.function.arguments)
  } catch {
    return null
  }
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
const PLAN_TOOL: ToolSchema = {
  type: 'function',
  function: {
    name: 'plan_todos',
    description: 'Break the task into ordered implementation steps. Never begin the work.',
    parameters: {
      type: 'object',
      required: ['items'],
      properties: {
        items: {
          type: 'array',
          description: '2-12 steps, in execution order, IN THE LANGUAGE OF THE TASK.',
          items: {
            type: 'object',
            required: ['title', 'done_when'],
            properties: {
              title: {
                type: 'string',
                description: 'One implementation step, imperative, specific to THIS task.',
              },
              done_when: {
                type: 'string',
                description: 'How this step is known to be done — answerable by looking ' +
                  'at a file or running a command.',
              },
              files: {
                type: 'array', items: { type: 'string' },
                description: 'The files this step touches, when the contract names them.',
              },
            },
          },
        },
      },
    },
  },
}

/** Tolerant like the parsers above. Fewer than 2 usable steps is not a plan. */
export function parsePlannedTodos(argsJson: string): TodoItem[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(argsJson)
  } catch {
    return null
  }
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
): Promise<TodoItem[] | null> {
  const messages: ChatMessage[] = [
    ...distillContext(transcript),
    {
      role: 'user',
      content:
        `[${renderContract(contract)}]\n\n` +
        '[Before any work starts: call plan_todos with the ordered implementation steps ' +
        'for the contract above — each step with its own checkable done_when, and the ' +
        'files it touches where the contract names them. Steps are the PATH; the ' +
        'contract criteria stay the definition of done. Write the steps in the language ' +
        'of the task — a task in another language is planned in that language. Do not ' +
        'begin the work.]',
    },
  ]
  try {
    const result = await client.chat({
      messages, tools: [PLAN_TOOL], toolChoice: 'required',
      maxTokens: DISTILL_MAX_TOKENS, disableThinking: true,
      ...(signal ? { signal } : {}),
    })
    const call = result.message.tool_calls?.[0]
    if (!call || call.function.name !== 'plan_todos') return null
    return parsePlannedTodos(call.function.arguments)
  } catch {
    return null
  }
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
const EN_FINISH = /\b(all done|everything (is )?(now )?(done|finished|complete)|task (is )?complete|nothing (else|more) (left )?to do|no (further|more) (work|changes) (is |are )?(needed|required))\b/

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
}

const ACCEPTANCE_TOOL: ToolSchema = {
  type: 'function',
  function: {
    name: 'report_acceptance',
    description: 'Report, criterion by criterion, whether the contract is met.',
    parameters: {
      type: 'object',
      required: ['items'],
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            required: ['criterion', 'met', 'evidence'],
            properties: {
              criterion: { type: 'string' },
              met: { type: 'boolean' },
              evidence: {
                type: 'string',
                description: 'What in THIS conversation demonstrates it: a command that ' +
                  'ran and its result, a diff that landed, a file that was read back. ' +
                  '"I implemented it" is not evidence; if nothing demonstrates it, met is false.',
              },
            },
          },
        },
      },
    },
  },
}

/** Room for 8 criteria each with a paragraph of evidence, several times over — see the
 * cap rule above; 900 died on the first live six-criterion task. */
const ACCEPTANCE_MAX_TOKENS = 4_000

/**
 * The end-of-turn question, asked as a skeptic and answered under force.
 *
 * Same-context self-review has a known bias — the writing context believes its own work —
 * so the instruction is phrased to hunt for the UNMET ("which of these can you not prove"),
 * and the evidence field's description makes assertion-without-demonstration a `met:
 * false` by definition. This will not catch everything; it reliably catches the measured
 * failure class of criteria that were simply forgotten.
 */
export async function checkAcceptance(
  client: LlamaClient,
  transcript: readonly ChatMessage[],
  contract: TaskContract,
  signal?: AbortSignal,
): Promise<AcceptanceReport | null> {
  const messages: ChatMessage[] = [
    ...transcript,
    {
      role: 'user',
      content:
        '[Before this turn may end: audit the work above against the task contract with ' +
        'report_acceptance, one item per criterion, in order:\n' +
        contract.criteria.map((c, i) => `${i + 1}. ${c}`).join('\n') +
        '\nBe a skeptic about your own work: a criterion nothing in this conversation ' +
        'demonstrates is NOT met, however confident you feel.]',
    },
  ]
  try {
    const result = await client.chat({
      messages, tools: [ACCEPTANCE_TOOL], toolChoice: 'required',
      maxTokens: ACCEPTANCE_MAX_TOKENS, disableThinking: true,
      ...(signal ? { signal } : {}),
    })
    const call = result.message.tool_calls?.[0]
    if (!call || call.function.name !== 'report_acceptance') return null
    return parseAcceptance(call.function.arguments)
  } catch {
    return null // a gate that cannot run must not block the turn; verify already ran
  }
}

export function parseAcceptance(argsJson: string): AcceptanceReport | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(argsJson)
  } catch {
    return null
  }
  const items = (parsed as { items?: unknown })?.items
  if (!Array.isArray(items)) return null
  const unmet: { criterion: string; why: string }[] = []
  let met = 0
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null) continue
    const item = raw as Record<string, unknown>
    const criterion = typeof item['criterion'] === 'string' ? item['criterion'] : ''
    if (criterion === '') continue
    if (item['met'] === true) met++
    else unmet.push({ criterion, why: typeof item['evidence'] === 'string' ? item['evidence'] : 'not demonstrated' })
  }
  if (met === 0 && unmet.length === 0) return null
  return { unmet, met }
}

/** What the fixer round is told. Names only the gaps — the criteria already sit in the
 * contract note above, and repeating the met ones invites re-doing finished work. */
export function acceptanceFailureMessage(report: AcceptanceReport): string {
  const gaps = report.unmet.map((u) => `- ${u.criterion}\n  (${u.why})`).join('\n')
  return 'The task contract is not fully met yet. Unmet criteria:\n' + gaps +
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

const REVIEW_TOOL: ToolSchema = {
  type: 'function',
  function: {
    name: 'review_verdict',
    description: 'Report genuine defects found in the diff, or an empty list.',
    parameters: {
      type: 'object',
      required: ['issues'],
      properties: {
        issues: {
          type: 'array',
          items: {
            type: 'object',
            required: ['where', 'what'],
            properties: {
              where: { type: 'string', description: 'File and place, e.g. lib/stats.js percentile()' },
              what: {
                type: 'string',
                description: 'The defect and why it is one: a bug, a contract criterion ' +
                  'the diff contradicts, a constraint it violates. Style is not a defect.',
              },
            },
          },
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
export async function reviewDiff(
  client: LlamaClient,
  contract: TaskContract,
  diffText: string,
  signal?: AbortSignal,
): Promise<ReviewIssue[] | null> {
  const clipped = diffText.length > DIFF_REVIEW_MAX_CHARS
    ? `${diffText.slice(0, DIFF_REVIEW_MAX_CHARS)}\n[... diff clipped at ${DIFF_REVIEW_MAX_CHARS} characters]`
    : diffText
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'You are reviewing a change someone else made to a codebase you have not seen. ' +
        'You have exactly two inputs: the task contract and the diff. Judge the diff ' +
        'against the contract and against correctness — off-by-one, wrong formula, broken ' +
        'export, violated constraint. Report only defects you can point at in the diff; ' +
        'an empty list is a fine and common verdict. Style preferences are not defects.',
    },
    {
      role: 'user',
      content: `${renderContract(contract)}\n\nThe diff:\n\n${clipped}\n\nReport with review_verdict.`,
    },
  ]
  try {
    const result = await client.chat({
      messages, tools: [REVIEW_TOOL], toolChoice: 'required',
      maxTokens: REVIEW_MAX_TOKENS,
      ...(signal ? { signal } : {}),
    })
    const call = result.message.tool_calls?.[0]
    if (!call || call.function.name !== 'review_verdict') return null
    return parseReview(call.function.arguments)
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
  const issues = (parsed as { issues?: unknown })?.issues
  if (!Array.isArray(issues)) return null
  return issues
    .filter((i): i is Record<string, unknown> => typeof i === 'object' && i !== null)
    .filter((i) => typeof i['where'] === 'string' && typeof i['what'] === 'string')
    .map((i) => ({ where: i['where'] as string, what: i['what'] as string }))
    .slice(0, 10)
}

export function reviewFailureMessage(issues: ReviewIssue[]): string {
  const list = issues.map((i) => `- ${i.where}: ${i.what}`).join('\n')
  return 'An independent review of this turn\'s diff found problems:\n' + list +
    '\n\nAddress each one, or say in one sentence why the reviewer is wrong about it.'
}
