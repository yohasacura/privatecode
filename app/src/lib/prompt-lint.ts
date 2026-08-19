/**
 * The model-free half of the prompt improver: what a draft is MISSING, said while it is
 * being typed. Zero latency and zero slot traffic, which is what "on the fly" can honestly
 * mean on a single-slot local server — the model-powered half is the Improve button.
 *
 * Hints, not corrections: each names an absence the agent will otherwise fill by guessing.
 * They appear only on a task-shaped draft (mirroring core's `looksLikeTask` thresholds —
 * duplicated here rather than imported so the UI bundle does not swallow the llama client
 * that module pulls in) and disappear the moment the draft covers the point.
 */

/** Mirrors core/session/contract.ts `looksLikeTask`: ≥220 chars, or ≥80 with 3+ sentences. */
export function taskShaped(text: string): boolean {
  const t = text.trim()
  if (t.length >= 220) return true
  if (t.length < 80) return false
  const sentences = t.split(/[.!?\n]+/).filter((s) => s.trim().length > 0)
  return sentences.length >= 3
}

/** The LINT gate, softer than the distill gate on purpose: hints are free and harmless,
 * and a 213-char single-sentence task (watched live) is still a task worth hinting at.
 * The auto-improver keeps the strict gate — model requests are not free. */
export function lintShaped(text: string): boolean {
  if (taskShaped(text)) return true
  const t = text.trim()
  return t.length >= 120 && t.split(/[.!?\n]+/).filter((s) => s.trim().length > 0).length >= 2
}

/**
 * The EXPANDER's input shape — and by the owner's direct order it is WIDE: «улучшение
 * промта должно быть даже на одном предложении или паре слов». A first cut matched only
 * imperative verbs and rejected questions, and it skipped exactly the drafts the user
 * wanted grown («Дай мне KQL сколько запросов мы делаем?»). So: anything long enough to
 * carry intent qualifies, questions included — the model decides whether there is
 * something to add, and the preview costs one click to ignore. Still disjoint from
 * `taskShaped` (a long draft gets the chips instead), still never a slash command, and
 * twelve characters keeps «ок», «спасибо» and their kin out.
 */
export function commandShaped(text: string): boolean {
  const t = text.trim()
  if (t.length < 12 || taskShaped(t)) return false
  return !/^\/[a-z0-9-]/i.test(t)
}

/**
 * Carries the user's decisions across a re-improve: a suggestion that survived verbatim
 * keeps its checkbox state and its answer; new ones arrive in the default state (checked
 * for criteria and constraints, unanswered for questions). Without this, the automatic
 * re-distill after an edit silently re-checked what the user had unchecked — their
 * curation lost to the feature meant to help them.
 */
export function carryAcceptance(
  next: DraftSuggestions,
  previous: DraftSuggestions | null,
  previousAccepted: ReadonlySet<string>,
  previousAnswers: ReadonlyMap<string, string>,
): { accepted: Set<string>; answers: Map<string, string> } {
  const known = new Set<string>(previous === null ? [] : [
    ...previous.criteria.map((c) => `c:${c}`),
    ...previous.constraints.map((c) => `k:${c}`),
  ])
  const accepted = new Set<string>()
  for (const key of [...next.criteria.map((c) => `c:${c}`), ...next.constraints.map((c) => `k:${c}`)]) {
    if (known.has(key) ? previousAccepted.has(key) : true) accepted.add(key)
  }
  const answers = new Map<string, string>()
  for (const q of next.questions) {
    const a = previousAnswers.get(q)
    if (a !== undefined) answers.set(q, a)
  }
  return { accepted, answers }
}

/** Path-ish tokens: `src/foo.ts`, `run-checks.js`, `App.css` — an extension or a slash. */
const NAMES_A_FILE = /(^|[\s"'`(\[])[\w.-]+[/\\][\w./\\-]+|\.[a-z]{1,4}\b/i

const NAMES_A_DONE_CRITERION =
  /(тест|провер|критери|должн|готов|работает|сходится|проходят|компилир|собира|test|pass|verify|check|criteri|should|must)/i

const NAMES_A_CONSTRAINT =
  /(не (трогай|меняй|ломай|удаляй|изменяй)|только|кроме|без изменени|оставь|сохрани|don'?t|do not|only|except|keep|leave)/i

export interface DraftSuggestions {
  criteria: string[]
  constraints: string[]
  questions: string[]
}

/**
 * The send-time glue: the user's draft AS TYPED, with the accepted suggestions appended
 * below it as plain structured text. Never a rewrite — the words above the fold are the
 * user's own. Unaccepted chips and unanswered questions simply do not travel; an answered
 * question travels as "question — answer", which reads as the clarification it is.
 */
export function glueSuggestions(
  draft: string,
  s: DraftSuggestions,
  accepted: ReadonlySet<string>,
  answers: ReadonlyMap<string, string>,
): string {
  const criteria = s.criteria.filter((c) => accepted.has(`c:${c}`))
  const constraints = s.constraints.filter((c) => accepted.has(`k:${c}`))
  const answered = s.questions
    .map((q) => {
      const a = answers.get(q)?.trim()
      return a !== undefined && a !== '' ? `${q.replace(/\?+\s*$/, '')} — ${a}` : null
    })
    .filter((x): x is string => x !== null)
  if (criteria.length === 0 && constraints.length === 0 && answered.length === 0) return draft

  // The glued block is MESSAGE content, not window chrome: its headers follow the
  // draft's language, because Russian criteria under English headers (or the reverse)
  // read as a tool malfunction inside the user's own message.
  const ru = /[а-яё]/i.test(draft)
  const parts: string[] = [draft.trimEnd()]
  if (criteria.length > 0) {
    parts.push('', ru ? 'Критерии готовности:' : 'Done criteria:')
    criteria.forEach((c, i) => parts.push(`${i + 1}. ${c}`))
  }
  if (constraints.length > 0) {
    parts.push('', ru ? 'Ограничения:' : 'Constraints:')
    for (const c of constraints) parts.push(`- ${c}`)
  }
  if (answered.length > 0) {
    parts.push('', ru ? 'Уточнения:' : 'Clarifications:')
    for (const a of answered) parts.push(`- ${a}`)
  }
  return parts.join('\n')
}

export function lintPrompt(text: string): string[] {
  if (!lintShaped(text)) return []
  const hints: string[] = []
  if (!NAMES_A_FILE.test(text)) {
    hints.push('No file named — the agent will go looking on its own')
  }
  if (!NAMES_A_DONE_CRITERION.test(text)) {
    hints.push('No done criterion — unclear when the task is finished')
  }
  if (!NAMES_A_CONSTRAINT.test(text)) {
    hints.push('No constraints — the agent decides what it may touch')
  }
  return hints
}
