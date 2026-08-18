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
 * A one-line request ("поправь опечатку в README") does not: the contract would cost a
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

/**
 * The one-line audit trail `TaskContract.checkedState` holds, built from a report:
 * met criteria by NUMBER (they need no explanation), unmet ones by number WITH the reason
 * (the reason is the pointer the model acts on).
 */
export function renderCheckedState(contract: TaskContract, report: AcceptanceReport): string {
  const met: number[] = []
  const unmet: string[] = []
  contract.criteria.forEach((criterion, i) => {
    const miss = report.unmet.find((u) => u.criterion === criterion)
    if (miss === undefined) met.push(i + 1)
    else unmet.push(`${i + 1} UNMET (${miss.why.slice(0, 120)})`)
  })
  const parts: string[] = []
  if (met.length > 0) parts.push(`${met.join(',')} met`)
  parts.push(...unmet)
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
 * run mid-work (or wastes an audit), and "почти готово"/"выполнена наполовину" are
 * continuations, not endings.
 *
 * Scans the head AND tail of the message, not just the tail: the model's live style is
 * often "Готово." as the first word followed by a long report, which a tail-only window
 * misses. The middle stays unscanned — that is where quoted text lives. `\b` cannot guard
 * the Russian words (JS word boundaries are ASCII-only, so `\bготово` never matches);
 * a Cyrillic lookbehind does the same job.
 *
 * Both halves are sentence-scoped rather than one phrase regex: live answers decline
 * freely («Задача починки отчёта полностью завершена: …»), so a fixed word order keeps
 * losing to real morphology. A sentence carrying a finish phrase counts unless that SAME
 * sentence also carries a hedge or negation word («почти всё готово», "not all done
 * yet") — the veto stays sentence-local so an honest caveat elsewhere is not silenced.
 * The Russian idioms whose canonical form contains «не» («больше ничего не осталось»)
 * are matched before the veto, or they could never fire at all.
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
