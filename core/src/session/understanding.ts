import type { LlamaClient } from '../llama/client.js'
import type { ChatMessage, ToolSchema } from '../llama/types.js'
import { alignReadings } from './contract.js'

/**
 * The check that runs in the last quiet moment before the first write: **did I understand
 * what you asked?**
 *
 * The failure this exists for is the one the whole rest of the harness cannot see. A contract
 * is distilled from the request, the work is audited against that contract, and the diff is
 * reviewed against it too — so if the misunderstanding entered at the distillation, every gate
 * agrees with every other gate and all of them are green. The contract is a mirror, not a
 * check: it is the same understanding restated, and a restatement cannot catch a misreading.
 *
 * You cannot make a small model understand better. You can make its uncertainty OBSERVABLE,
 * and that is a different problem with a mechanical solution:
 *
 *  1. read the request three times through deliberately different LENSES — literally, as a
 *     careful colleague, and as someone hunting for a second meaning. Not three samples of
 *     one prompt: at this server's tuned temperature that measures sampling noise mixed with
 *     genuine ambiguity, and nothing separates the two. Three lenses put the disagreement
 *     where the ambiguity actually is — scope, and meaning.
 *  2. align what they produced with `alignReadings`, which is the audit's own criterion
 *     matcher pointed at two readings instead of at a report and a contract.
 *  3. anything not shared by every reading is a CONTESTED point.
 *
 * The questions are then assembled by CODE, out of the model's own sentences. That is the
 * property that makes this different from the prompt improver it replaces: a model asked what
 * it finds unclear will invent something, because a small model is a poor judge of what it
 * does not know, and the result is a stream of questions about nothing. Here a question can
 * only exist where two of its own readings actually differed, and its text is the reading
 * itself. There is nowhere for an invention to enter.
 *
 * WHEN it runs is the other half, and it is the user's own observation: the model opens
 * almost every task by reading around the codebase. Asked before that, the questions are
 * uninformed — half of them are answered by the code, which is exactly the noise complaint —
 * and the ones that remain are vague. Asked after it, they are specific and usually
 * answerable in one word. The last moment that is still free is the first WRITE: everything
 * before it is reading, which is cheap and reversible, and everything after it is code.
 */

/** One reading of the request: the concrete things this change should do. */
export interface Reading {
  lens: LensName
  does: string[]
}

export type LensName = 'literal' | 'colleague' | 'skeptic'

/**
 * The three lenses, written the way a person would actually say them.
 *
 * Deliberately casual, and not out of style preference: this codebase's one measured law of
 * prompting this model is that instructions do not route behaviour (0/703 on a system-prompt
 * ask) while STRUCTURE does. The schema below is what forces the shape; the prose only has to
 * put the model in a frame of mind, and stiff instruction-speak is worse at that than plain
 * speech. The difference between the lenses is the whole experiment, so each one says its
 * difference in one blunt sentence and stops.
 */
const LENSES: { name: LensName; ask: string }[] = [
  {
    name: 'literal',
    ask: 'Take it dead literally. Only what they actually asked to change — if the words ' +
      'did not ask for it, leave it off, however obviously useful it would be.',
  },
  {
    name: 'colleague',
    ask: 'Read it like a good colleague would: what they asked for, plus whatever has to ' +
      'come with it for that to really work. The bits you would be annoyed to find missing.',
  },
  {
    name: 'skeptic',
    ask: 'Assume the obvious reading is the wrong one. What ELSE could they be asking for? ' +
      'Give me that other reading, not the obvious one — even if you think the obvious one ' +
      'is right.',
  },
]

const READING_TOOL: ToolSchema = {
  type: 'function',
  function: {
    name: 'record_reading',
    description: 'Say what will be different once this change is done, as you read it.',
    parameters: {
      type: 'object',
      required: ['does'],
      properties: {
        does: {
          type: 'array',
          items: { type: 'string' },
          description: 'One short line per thing that will be DIFFERENT once the work is ' +
            'finished. Not how the code works today — you already know that, and nobody is ' +
            'asking. Each line is an outcome, not a step and not a file: "invoice numbers ' +
            'never skip a value", not "add a transaction to InvoiceService" and not "edit ' +
            'BillingController.cs". Roll the call sites up into the outcome instead of ' +
            'listing them one by one. Two to six lines, each under about ten words — no ' +
            'examples, no brackets, and never the same outcome twice in different words. ' +
            'Write them IN ENGLISH, whatever language the request is in — these lines are ' +
            'shown to the user as they are.',
        },
      },
    },
  },
}

/** Room for six lines of prose several times over. Sized by the cap rule this project
 * learned the hard way: a cap a healthy generation can reach fails SILENTLY, because a
 * `length` finish carries no tool call and parses as nothing at all. */
const READING_MAX_TOKENS = 1_500

/** How many contested points are ever put to a person. Past three this stops being a
 * question and becomes a form, and the whole point is that answering is cheaper than
 * discovering the misunderstanding later. */
export const MAX_CONTESTED = 3

/** Lines shorter than this carry no content to match on — "fix it", "the bug" — and would
 * pair with anything. Dropped rather than asked about. */
const MIN_USEFUL_CHARS = 12

export interface Understanding {
  /** What every reading agreed on. This is not asked about; it is stated. */
  shared: string[]
  /** What at least one reading saw and at least one other did not. */
  contested: string[]
}

function parseReading(argsJson: string, lens: LensName): Reading | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(argsJson)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const raw = (parsed as Record<string, unknown>)['does']
  if (!Array.isArray(raw)) return null
  const does = raw
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim())
    .filter((x) => x.length >= MIN_USEFUL_CHARS)
    .slice(0, 8)
  return does.length > 0 ? { lens, does } : null
}

/**
 * One reading, over the live transcript.
 *
 * The transcript is passed whole and unclipped on purpose: everything the model has read so
 * far is the entire reason to ask now rather than on send, and it is already the server's
 * cached prefix, so three readings cost three GENERATIONS and one prefill between them.
 * Thinking is off — this is restating, and restating with thinking on was measured pure
 * waste on this server.
 */
async function readOnce(
  client: LlamaClient,
  transcript: readonly ChatMessage[],
  request: string,
  lens: { name: LensName; ask: string },
  signal?: AbortSignal,
): Promise<Reading | null> {
  const messages: ChatMessage[] = [
    ...transcript,
    {
      role: 'user',
      content:
        '[Hold on, before you write anything. I want to check we agree on what this is.\n\n' +
        'Here is what was asked for, word for word:\n\n' +
        `    ${request}\n\n` +
        `${lens.ask}\n\n` +
        'What I want back is what will be DIFFERENT when it is done — not a summary of how ' +
        'the code works now. You have read the code; that part is settled. Call ' +
        'record_reading and stop there, do not start the work.]',
    },
  ]
  try {
    const result = await client.chat({
      messages,
      tools: [READING_TOOL],
      toolChoice: 'required',
      maxTokens: READING_MAX_TOKENS,
      disableThinking: true,
      ...(signal ? { signal } : {}),
    })
    const call = result.message.tool_calls?.[0]
    if (!call || call.function.name !== 'record_reading') return null
    return parseReading(call.function.arguments, lens.name)
  } catch {
    // A reading that failed costs the check its resolution, not the turn. Two readings still
    // disagree usefully; one cannot disagree at all and the caller treats that as silence.
    return null
  }
}

const GROUP_TOOL: ToolSchema = {
  type: 'function',
  function: {
    name: 'group_lines',
    description: 'Group the numbered lines that say the same thing.',
    parameters: {
      type: 'object',
      required: ['groups'],
      properties: {
        groups: {
          type: 'array',
          description: 'One entry per DISTINCT thing. Each entry is the list of line numbers ' +
            'that say that thing. A line that stands alone gets a group of its own. Every ' +
            'number appears exactly once across all the groups. Numbers only — do not write ' +
            'the lines out again.',
          items: { type: 'array', items: { type: 'number' } },
        },
      },
    },
  },
}

/** Numbers only, so the answer is small however long the lines were. */
const GROUP_MAX_TOKENS = 800

/**
 * Which of the readings' lines say the same thing — asked of the model, in numbers.
 *
 * `alignReadings` does this by string comparison and it is the fallback below, but measured
 * live it loses to ordinary paraphrase: "all callers invoke InvoiceService.FormatNumber
 * instead of Format" and "all callers invoke FormatNumber rather than Format" are one thing
 * to any reader and two to a word matcher, and the card then offers the same option twice.
 * Deciding whether two sentences mean the same thing is the one part of this that a language
 * model is genuinely better at than code.
 *
 * Which is safe HERE, and only because of the answer's shape: the model may reply with
 * nothing but line numbers. It cannot introduce a line, reword one, or invent a requirement —
 * every question still comes out of a reading, verbatim. The harness checks provenance
 * (in range, used once) and hands back the rest. That is the same division of labour as the
 * rest of the check: judgement to the model, custody of the facts to the code.
 */
async function groupLines(
  client: LlamaClient, lines: readonly string[], signal?: AbortSignal,
): Promise<number[][] | null> {
  const numbered = lines.map((l, i) => `${i + 1}. ${l}`).join('\n')
  try {
    const result = await client.chat({
      messages: [{
        role: 'user',
        content:
          'Someone read the same request three times and wrote down what they thought it ' +
          'meant. Their lines are jumbled together below, and plenty of them are the same ' +
          'thing said differently.\n\n' + numbered + '\n\n' +
          'Group the ones that mean the same thing. Same outcome = same group, even when ' +
          'the wording is nothing alike. Different outcome = different groups, even when ' +
          'the wording is nearly identical — "within a year" and "across years" are not the ' +
          'same thing. Call group_lines with the numbers.',
      }],
      tools: [GROUP_TOOL],
      toolChoice: 'required',
      maxTokens: GROUP_MAX_TOKENS,
      disableThinking: true,
      ...(signal ? { signal } : {}),
    })
    const call = result.message.tool_calls?.[0]
    if (!call || call.function.name !== 'group_lines') return null
    return parseGroups(call.function.arguments, lines.length)
  } catch {
    return null
  }
}

/**
 * The provenance check, and it is the whole reason the grouping may be delegated at all.
 *
 * Anything that is not a number in range is dropped, a number used twice counts only the
 * first time, and every line the answer forgot becomes a group of its own — a forgotten line
 * is an ungrouped line, never a deleted one. So the worst a bad grouping can do is ask about
 * something that did not need asking; it can never make a contested point disappear.
 */
export function parseGroups(argsJson: string, lineCount: number): number[][] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(argsJson)
  } catch {
    return null
  }
  const raw = (parsed as { groups?: unknown } | null)?.groups
  if (!Array.isArray(raw)) return null
  const used = new Set<number>()
  const groups: number[][] = []
  for (const entry of raw) {
    if (!Array.isArray(entry)) continue
    const group: number[] = []
    for (const n of entry) {
      const index = typeof n === 'number' ? Math.trunc(n) - 1 : -1
      if (index < 0 || index >= lineCount || used.has(index)) continue
      used.add(index)
      group.push(index)
    }
    if (group.length > 0) groups.push(group)
  }
  for (let i = 0; i < lineCount; i++) {
    if (!used.has(i)) groups.push([i])
  }
  return groups.length > 0 ? groups : null
}

/**
 * Read the request through every lens, then sort the results into what they agreed on and
 * what they did not.
 *
 * Sequential, not parallel: one slot. Every reading shares the conversation's cached prefix,
 * so three readings cost three generations and one prefill between them.
 */
export async function readThroughLenses(
  client: LlamaClient,
  transcript: readonly ChatMessage[],
  request: string,
  signal?: AbortSignal,
): Promise<Understanding | null> {
  const readings: Reading[] = []
  for (const lens of LENSES) {
    if (signal?.aborted) return null
    const reading = await readOnce(client, transcript, request, lens, signal)
    if (reading !== null) readings.push(reading)
  }
  if (readings.length < 2) return null
  if (signal?.aborted) return null

  const flat = readings.flatMap((r) => r.does)
  const groups = await groupLines(client, flat, signal)
  // A grouping that could not be taken falls back to the word matcher, which is worse at
  // paraphrase but never absent.
  if (groups === null) return compareReadings(readings)
  return fromGroups(readings, groups)
}

/** Which reading each flattened line came from. */
function ownerOf(readings: readonly Reading[], index: number): number {
  let seen = 0
  for (let r = 0; r < readings.length; r++) {
    seen += readings[r]!.does.length
    if (index < seen) return r
  }
  return readings.length - 1
}

/**
 * Groups of line numbers into the two lists a question is built from.
 *
 * The rule that matters is which readings have to agree, and the obvious answer is wrong.
 * Requiring all three was the first version and it made "shared" almost always empty —
 * measured live on a request with nothing ambiguous about it at all. The reason is structural
 * rather than a tuning problem: the SKEPTIC is under orders to produce a different reading, so
 * by construction its lines rarely land in anyone else's group, and a rule that waits for its
 * vote waits forever.
 *
 * So the core is the literal and colleague readings — the two that are trying to describe the
 * same thing — and a group is shared when it covers all of them. The skeptic only ever ADDS:
 * a line of its own becomes a candidate question, and it can never take one off the agreed
 * list. That is exactly the job it was given.
 *
 * Contested points are ordered by how many core readings saw them, then core before skeptic:
 * something the colleague saw is likelier to be real work than something only the skeptic
 * imagined. Each is shown by its SHORTEST phrasing, which is the one without the padding.
 */
export function fromGroups(readings: readonly Reading[], groups: readonly number[][]): Understanding {
  const flat = readings.flatMap((r) => r.does)
  const coreLenses = new Set(
    readings.map((r, i) => (r.lens === 'skeptic' ? -1 : i)).filter((i) => i >= 0),
  )
  const shared: string[] = []
  const contested: { text: string; core: number; fromCore: boolean }[] = []
  for (const group of groups) {
    const lines = group.map((i) => flat[i]).filter((l): l is string => l !== undefined)
    if (lines.length === 0) continue
    const shortest = lines.reduce((a, b) => (b.length < a.length ? b : a))
    const owners = new Set(group.map((i) => ownerOf(readings, i)))
    const core = [...owners].filter((o) => coreLenses.has(o)).length
    // With no core reading at all — only the skeptic survived — nothing can be agreed, and
    // every line is a candidate rather than a promise.
    if (coreLenses.size > 0 && core === coreLenses.size) shared.push(shortest)
    else contested.push({ text: shortest, core, fromCore: core > 0 })
  }
  contested.sort((a, b) => (b.core - a.core) || (Number(b.fromCore) - Number(a.fromCore)))
  // At most one skeptic-only point. Its job is to surface AN alternative reading, and asked
  // for three it starts inverting the request instead of widening it — measured live on an
  // unambiguous rename, where its third offering was "the controller formats invoice numbers
  // inline instead of calling a service method", the opposite of what had been asked for.
  let skepticOnly = 0
  const kept = contested.filter((c) => {
    if (c.fromCore) return true
    skepticOnly++
    return skepticOnly === 1
  })
  return { shared, contested: kept.slice(0, MAX_CONTESTED).map((c) => c.text) }
}

/**
 * The comparison, and it is deliberately the ONLY place a question can come from.
 *
 * A line counts as shared when every reading that ran has something matching it — matching by
 * `alignReadings`, which folds punctuation, case and word order the way the acceptance audit
 * already does, so "the padding is kept" and "keeps its padding." are one line and not two.
 * Everything else is contested, ordered so the most-agreed-upon contested line is asked first:
 * a point two readings saw is likelier to be real work than one only the skeptic imagined.
 *
 * Fewer than two readings is not a comparison. Returning null there is the honest answer, and
 * the caller stays silent rather than asking about a list nothing disagreed with.
 */
export function compareReadings(readings: readonly Reading[]): Understanding | null {
  if (readings.length < 2) return null

  const seen = new Map<string, { text: string; count: number }>()
  for (const reading of readings) {
    // Within one reading, a line is counted once however often the model repeated it.
    const countedHere = new Set<string>()
    for (const line of reading.does) {
      const existing = [...seen.values()].find((e) => alignReadings(e.text, line))
      const key = existing?.text ?? line
      if (countedHere.has(key)) continue
      countedHere.add(key)
      const entry = seen.get(key)
      if (entry === undefined) seen.set(key, { text: line, count: 1 })
      else entry.count++
    }
  }

  const shared: string[] = []
  const contested: { text: string; count: number }[] = []
  for (const entry of seen.values()) {
    if (entry.count === readings.length) shared.push(entry.text)
    else contested.push(entry)
  }
  contested.sort((a, b) => b.count - a.count)
  return { shared, contested: contested.slice(0, MAX_CONTESTED).map((c) => c.text) }
}

/**
 * The question a person is actually shown, assembled from the model's own lines.
 *
 * Written as one card rather than a run of them: what was agreed is STATED (that half needs
 * no answer, and seeing it is how you catch a misreading nobody flagged), and only the
 * contested half is asked. Multi-select, because these are independent bits of scope and not
 * a menu — and every unpicked one is an answer too, recorded as something not to do.
 *
 * Null when nothing was contested, which is the common case and the right silence: three
 * readings that agree have nothing to ask about.
 */
export function buildQuestion(u: Understanding): { question: string; options: string[]; multiSelect: true } | null {
  if (u.contested.length === 0) return null
  const agreed = u.shared.length > 0
    ? `Here is what I am about to do:\n${u.shared.map((s) => `• ${s}`).join('\n')}\n\n`
    : ''
  return {
    question:
      `${agreed}I am not sure about these. Which of them did you mean?\n` +
      '(Pick the ones you want. Anything you leave unpicked, I will not do.)',
    options: u.contested,
    multiSelect: true,
  }
}

/**
 * The answer, turned into criteria — and the unpicked half kept as a plain fact, never as a
 * prohibition.
 *
 * The first version made every unpicked option a constraint reading "Do not: <option>". The
 * reasoning was that "no, not that" is a decision worth recording once. What that ignores is
 * where these options come from: they are readings of the REQUEST, so a contested line is
 * often a restatement of the goal rather than optional extra scope. Caught in a live run, on
 * a task about gap-free invoice numbers, the harness wrote itself:
 *
 *     Do not: Concurrent requests no longer produce duplicate invoice numbers
 *             — the user was asked and did not pick it
 *
 * That is an instruction not to do the job, promoted into the contract, carried into message
 * 0 at every compaction. A multi-select cannot express "no" at all: not ticking a box is a
 * shrug, and reading a shrug as a prohibition is how a harness talks a model out of the work.
 *
 * So `notPicked` comes back as information for the caller to state once, in the moment, and
 * nothing here becomes a constraint. Constraints are for what the USER said not to do.
 *
 * The answer is matched back to the options by the same alignment used to compare readings:
 * the host joins a multi-select with "; ", but a person may also type their own words, and a
 * typed answer that matches nothing is kept verbatim as a criterion rather than dropped.
 */
export function foldAnswer(u: Understanding, answer: string): { criteria: string[]; notPicked: string[] } {
  const picked = answer.split(';').map((p) => p.trim()).filter((p) => p.length > 0)
  const criteria: string[] = []
  const notPicked: string[] = []
  for (const option of u.contested) {
    if (picked.some((p) => alignReadings(p, option))) criteria.push(option)
    else notPicked.push(option)
  }
  // Free text the person typed instead of picking: their own words outrank every reading,
  // so it is kept exactly as written.
  for (const p of picked) {
    if (!u.contested.some((option) => alignReadings(p, option)) && p.length >= MIN_USEFUL_CHARS) {
      criteria.push(p)
    }
  }
  return { criteria, notPicked }
}
