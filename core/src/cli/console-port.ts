import type {
  ApprovalDecision,
  ApprovalRequest,
  InteractionPort,
  RememberLayer,
  TodoItem,
  UserQuestion,
} from '../interaction.js'

/**
 * The minimal surface `createConsolePort` needs from a line-reading host.
 *
 * The real REPL (`cli/repl.ts`) passes a thin adapter over `node:readline/promises` that
 * also handles raw-mode toggling and turn cancellation around each `question()` call; this
 * module knows nothing about any of that, which is what lets it be driven by a scripted
 * stand-in (a plain array of canned answers) for hand-verification without a real TTY.
 */
export interface ReadlineLike {
  question(prompt: string): Promise<string>
  write(text: string): void
}

/** A garbled answer is re-asked this many times before the prompt gives up and fails closed. */
const MAX_ATTEMPTS = 3

/** Detail longer than this is clipped, with a note, so one huge diff can't scroll the
 * actual question off the top of the terminal. */
const DETAIL_MAX_LINES = 30

function clipDetail(detail: string): string {
  const lines = detail.split('\n')
  if (lines.length <= DETAIL_MAX_LINES) return detail
  const clippedCount = lines.length - DETAIL_MAX_LINES
  return `${lines.slice(0, DETAIL_MAX_LINES).join('\n')}\n... (${clippedCount} more line${clippedCount === 1 ? '' : 's'} clipped)`
}

function todoBox(status: TodoItem['status']): string {
  switch (status) {
    case 'completed': return '[x]'
    case 'in_progress': return '[>]'
    case 'pending': return '[ ]'
  }
}

/** Shared by the port's own `todosChanged` and the REPL's `/todos` command, so the two
 * never drift into rendering the list differently. */
export function formatTodoLine(item: TodoItem): string {
  return `${todoBox(item.status)} ${item.text}`
}

/** Offered only when `req.suggestedRules` is non-empty -- see `requestApproval`. */
const ALLOW_PROMPT_WITH_RULES =
  'Allow? [y] yes once  [a] always...  [n] no  [n <comment>] no with comment: '

/**
 * Used whenever `req.suggestedRules` is empty -- no `[a]` offered at all, and (see
 * `requestApproval`) an `a` answer is treated as unrecognized rather than as a pick. An
 * empty `suggestedRules` means the engine's `decide()` reached this `ask` via an explicit
 * ask RULE (`Decision.source === 'rule'`, see `agent/loop.ts`), which was written
 * specifically to require asking every time; offering "always allow" here would be a lie,
 * since no allow rule or session grant could ever win over that ask rule for the same key.
 */
const ALLOW_PROMPT_NO_RULES =
  'Allow? [y] yes once  [n] no  [n <comment>] no with comment: '

/**
 * Asks which of `rules` to remember, numbered starting at 1, default 1 on an empty
 * answer. An answer that is neither empty nor a number in range is re-asked up to
 * `MAX_ATTEMPTS` times, then falls back to the default -- unlike the top-level Allow?
 * question, there is no sane "deny" to fail closed to here: the user already said "always",
 * this step only narrows which rule text and is safe to default rather than discard.
 *
 * Only ever called with a non-empty `rules` -- `requestApproval` only reaches the `[a]`
 * branch when `req.suggestedRules` is non-empty, so there is no "no suggested rule"
 * placeholder to fall back to here.
 */
async function pickRule(rl: ReadlineLike, rules: string[]): Promise<string> {
  rl.write('Always allow which rule?\n')
  rules.forEach((r, i) => rl.write(`  [${i + 1}] ${r}\n`))
  const prompt = `Pick [1..${rules.length}, default 1]: `

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const raw = (await rl.question(prompt)).trim()
    if (raw === '') return rules[0]!
    if (/^\d+$/.test(raw)) {
      const n = Number(raw)
      if (n >= 1 && n <= rules.length) return rules[n - 1]!
    }
    rl.write(`Unrecognized answer. Enter a number from 1 to ${rules.length}, or press Enter for 1.\n`)
  }
  return rules[0]!
}

/** Same shape as pickRule: defaults rather than denies, since "always" was already decided. */
async function pickLayer(rl: ReadlineLike): Promise<RememberLayer> {
  const prompt = 'Remember at: [s] this session (default)  [l] local  [p] project  [u] user: '
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const raw = (await rl.question(prompt)).trim().toLowerCase()
    if (raw === '' || raw === 's') return 'session'
    if (raw === 'l') return 'local'
    if (raw === 'p') return 'project'
    if (raw === 'u') return 'user'
    rl.write('Unrecognized answer. Enter s, l, p, or u, or press Enter for session.\n')
  }
  return 'session'
}

/** `n missing the point` -> comment `missing the point`; bare `n` -> no comment. */
function parseDeny(raw: string): { comment?: string } | null {
  if (/^n$/i.test(raw)) return {}
  const withComment = /^n\s+(.+)$/i.exec(raw)
  if (withComment) return { comment: withComment[1]!.trim() }
  return null
}

async function requestApproval(rl: ReadlineLike, req: ApprovalRequest): Promise<ApprovalDecision> {
  rl.write(`\n${req.tool}: ${req.summary}\n`)
  if (req.detail) rl.write(`${clipDetail(req.detail)}\n`)

  // No suggested rule means the ask came from a rule specifically requiring it every time
  // (see the doc comment on ALLOW_PROMPT_NO_RULES) -- so `[a]` is not offered, and (below)
  // an `a` answer is not treated as the "always allow" pick either; it just falls through
  // to "unrecognized", the same as any other garbled answer.
  const canRemember = req.suggestedRules.length > 0
  const prompt = canRemember ? ALLOW_PROMPT_WITH_RULES : ALLOW_PROMPT_NO_RULES

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const raw = (await rl.question(prompt)).trim()

    if (raw === '' || /^y$/i.test(raw)) return { verdict: 'allow' }

    const denied = parseDeny(raw)
    if (denied) return denied.comment !== undefined
      ? { verdict: 'deny', comment: denied.comment }
      : { verdict: 'deny' }

    if (canRemember && /^a$/i.test(raw)) {
      const rule = await pickRule(rl, req.suggestedRules)
      const layer = await pickLayer(rl)
      return { verdict: 'allow', remember: { rule, layer } }
    }

    rl.write(canRemember
      ? 'Unrecognized answer. Enter y, a, n, or n <comment>.\n'
      : 'Unrecognized answer. Enter y, n, or n <comment>.\n')
  }
  return { verdict: 'deny', comment: 'unrecognized answer' }
}

type ParsedAnswer =
  | { kind: 'option'; index: number }
  | { kind: 'out-of-range' }
  | { kind: 'text'; text: string }

function parseNumberOrText(raw: string, optionCount: number): ParsedAnswer {
  const trimmed = raw.trim()
  if (!/^-?\d+$/.test(trimmed)) return { kind: 'text', text: trimmed }
  const n = Number(trimmed)
  if (n >= 1 && n <= optionCount) return { kind: 'option', index: n - 1 }
  return { kind: 'out-of-range' }
}

async function askUser(rl: ReadlineLike, q: UserQuestion): Promise<string> {
  rl.write(`\n${q.question}\n`)
  q.options.forEach((o, i) => rl.write(`  [${i + 1}] ${o}\n`))
  const prompt = q.multiSelect === true
    ? 'Answer (numbers like 1,3, or free text): '
    : 'Answer (number or free text): '

  // Multi-select: a comma list of numbers becomes those options joined "; " — the same
  // one-string answer shape every other port produces. Anything that is not a pure
  // number list falls through to the single-answer parse below, so free text and single
  // numbers keep working unchanged.
  if (q.multiSelect === true) {
    const raw = (await rl.question(prompt)).trim()
    if (/^\d+(\s*,\s*\d+)+$/.test(raw)) {
      const chosen = [...new Set(raw.split(',').map((n) => Number(n.trim())))]
        .filter((n) => n >= 1 && n <= q.options.length)
        .sort((a, b) => a - b)
        .map((n) => q.options[n - 1]!)
      if (chosen.length > 0) return chosen.join('; ')
    }
    const parsed = parseNumberOrText(raw, q.options.length)
    if (parsed.kind === 'option') return q.options[parsed.index]!
    if (parsed.kind === 'text') return parsed.text
    rl.write(`Enter numbers from 1 to ${q.options.length} (comma-separated), or type your own answer: `)
    return (await rl.question(prompt)).trim()
  }

  const first = parseNumberOrText(await rl.question(prompt), q.options.length)
  if (first.kind === 'option') return q.options[first.index]!
  if (first.kind === 'text') return first.text

  // Out of range: re-ask exactly once, then hand back whatever comes next verbatim --
  // no further validation, per the brief ("the raw text is returned as-is").
  rl.write(`Enter a number from 1 to ${q.options.length}, or type your own answer: `)
  const second = await rl.question(prompt)
  return second.trim()
}

/**
 * Builds the terminal side of `InteractionPort` from a `ReadlineLike`.
 *
 * Everything here is pure prompt/parse logic with no knowledge of raw mode, TTYs, or
 * cancellation -- that all lives in the `ReadlineLike` the caller provides (see
 * `cli/repl.ts`), which is what makes this half testable with a scripted stand-in.
 */
export function createConsolePort(rl: ReadlineLike): InteractionPort {
  return {
    requestApproval: (req) => requestApproval(rl, req),
    askUser: (q) => askUser(rl, q),
    todosChanged: (todos) => {
      rl.write('\nTodos:\n')
      for (const t of todos) rl.write(`  ${formatTodoLine(t)}\n`)
    },
  }
}
