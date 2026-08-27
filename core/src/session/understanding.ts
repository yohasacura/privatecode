import type { LlamaClient } from '../llama/client.js'
import type { ChatMessage, ToolSchema } from '../llama/types.js'
import { forcedJson } from './forced-json.js'
import { alignReadings, readingCovers, sharedContentWords } from './contract.js'

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
 * ask) while STRUCTURE does. The schema below is what forces the shape -- and ONLY the shape:
 * it is a `response_format` schema, compiled to a grammar and never rendered, so a
 * `description` written there contributes zero prompt tokens and the model never sees it.
 * Every word that has to reach the model lives in the ask in `readOnce`. The prose there has
 * to do two jobs then: put the model in a frame of mind, where stiff instruction-speak is
 * worse than plain speech, and carry the rules the lines must obey. The difference between
 * the lenses is the whole experiment, so each one says its difference in one blunt sentence
 * and stops.
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

/** The shape a reading is held to, enforced by the sampler rather than by a one-tool
 * `tools` array — see `forced-json.ts`: the array swap was costing a full re-prefill of the
 * conversation, and the readings ride the LIVE transcript. */
const READING_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['does'],
  additionalProperties: false,
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
}

/** Room for six lines of prose several times over. Sized by the cap rule this project
 * learned the hard way: a cap a healthy generation can reach fails SILENTLY, because a
 * `length` finish carries no tool call and parses as nothing at all. */
const READING_MAX_TOKENS = 1_500

/** How many contested points are ever put to a person. Past three this stops being a
 * question and becomes a form, and the whole point is that answering is cheaper than
 * discovering the misunderstanding later. */
const MAX_CONTESTED = 3

/** Lines shorter than this carry no content to match on — "fix it", "the bug" — and would
 * pair with anything. Dropped rather than asked about. */
const MIN_USEFUL_CHARS = 12

export interface Understanding {
  /** What every reading agreed on. This is not asked about; it is stated. */
  shared: string[]
  /** What at least one reading saw and at least one other did not. */
  contested: string[]
}

function readReading(parsed: unknown, lens: LensName): Reading | null {
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
  tools?: readonly ToolSchema[],
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
        // These four sentences used to live in READING_SCHEMA's `description`, back when the
        // shape was forced by a one-tool `tools` array — which IS rendered, at the front of
        // the prompt. A `response_format` schema is compiled to a grammar and contributes
        // ZERO prompt tokens (measured: an 868-character description changes the prompt from
        // 275 tokens to 275 tokens), so moving the forcing mechanism moved this instruction
        // out of the model's sight. The lines it produces are shown to the USER as tick-boxes,
        // and without this the gate started offering steps and file names as options.
        //
        // The English pin is the half that matters most: it is the whole subject of commit
        // 6b0caec and of english-only-output.test.ts, and these lines are rendered verbatim.
        'What I want back is what will be DIFFERENT when it is done — not a summary of how ' +
        'the code works now. You have read the code; that part is settled.\n\n' +
        'One short line per thing that will be different. Each line is an OUTCOME, not a ' +
        'step and not a file: "invoice numbers never skip a value", not "add a transaction ' +
        'to InvoiceService" and not "edit BillingController.cs". Roll the call sites up into ' +
        'the outcome instead of listing them one by one. Two to six lines, each under about ' +
        'ten words — no examples, no brackets, and never the same outcome twice in different ' +
        'words. Write them IN ENGLISH, whatever language the request is in: these lines are ' +
        'shown to the user exactly as you write them.\n\n' +
        'Answer with JSON only and stop there, do not start the work.]',
    },
  ]
  // A reading that fails costs the check its resolution, not the turn: `forcedJson` returns
  // null on any refusal or unparseable answer. Two readings still disagree usefully; one
  // cannot disagree at all, and the caller treats that as silence.
  const parsed = await forcedJson(client, {
    messages,
    name: 'reading',
    schema: READING_SCHEMA,
    maxTokens: READING_MAX_TOKENS,
    disableThinking: true,
    ...(tools ? { tools } : {}),
    ...(signal ? { signal } : {}),
  })
  return parsed === null ? null : readReading(parsed, lens.name)
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
      // The ONE call in this codebase that still swaps the tools array, and deliberately.
      // Every other gate carries the session's own array so it stays an append onto the warm
      // prompt — but this one does not ride the transcript at all: its whole prompt is the
      // numbered list of lines built two lines above, a few hundred tokens with nothing
      // cached to preserve. Giving it the 4.4k-token tool block would make it bigger, not
      // cheaper, and llama.cpp keeps the conversation's prefix in RAM regardless.
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
  /** The session's own tool array, unchanged, so the three readings stay pure appends. */
  tools?: readonly ToolSchema[],
): Promise<Understanding | null> {
  const readings: Reading[] = []
  for (const lens of LENSES) {
    if (signal?.aborted) return null
    const reading = await readOnce(client, transcript, request, lens, signal, tools)
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
    // Agreement needs TWO core readings, not "all of however many survived". The only
    // arity guard upstream is `readings.length < 2` over the whole array, skeptic included,
    // so `[colleague, skeptic]` gets here with `coreLenses.size === 1` — and `core ===
    // coreLenses.size` is then satisfied by that single reading agreeing with itself. Every
    // line of the COLLEAGUE lens, the deliberately expansive one, was stated back verbatim
    // under "Here is what I am about to do:" with nothing having confirmed it, while every
    // skeptic line became contested — so the card was at its most confident and its noisiest
    // at the same moment, on the one run where least was known. `readOnce` returns null on a
    // parse failure, a wrong or absent tool call, or any throw, which is a real rate against
    // a 1500-token cap.
    if (coreLenses.size >= 2 && core === coreLenses.size) shared.push(shortest)
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
/**
 * The option that says "none of these", offered because otherwise it cannot be said.
 *
 * The card is a multi-select whose Answer button stays disabled until something is ticked
 * (`approvals.tsx`), so a person who wanted NONE of the contested readings had no way to
 * send that: tick something they did not want, or leave the turn parked. Meanwhile
 * `session.ts` carries a branch reading "They did not want any of them." that nothing could
 * reach. Reproduced in the running app before this existed.
 *
 * An explicit option rather than an enabled empty submit, because an EMPTY answer already
 * means something else on that path and must keep meaning it: the gate treats no-answer (an
 * abort, a queued run's parked reply, an empty string) as "keep the reading you had, touch
 * nothing". Deliberately choosing none is a different fact and needs its own way of being
 * said.
 */
export const NONE_OF_THESE = 'None of these — just do what we agreed above'

export function buildQuestion(u: Understanding): { question: string; options: string[]; multiSelect: true } | null {
  if (u.contested.length === 0) return null
  const agreed = u.shared.length > 0
    ? `Here is what I am about to do:\n${u.shared.map((s) => `• ${s}`).join('\n')}\n\n`
    : ''
  return {
    question:
      `${agreed}I am not sure about these. Which of them did you mean?\n` +
      '(Pick the ones you want. Anything you leave unpicked, I will not do.)',
    options: [...u.contested, NONE_OF_THESE],
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
 *
 * `existing` is the contract's criteria as they stand, and passing them is what stops the
 * contract growing a second copy of something it already says. The options here are readings
 * of the SAME request the contract was distilled from, so a ticked one is usually a paraphrase
 * of a criterion that is already in there. Watched live on a task about slugs: the contract
 * came out with seven criteria, the person ticked three readings, and the contract went to ten
 * — items 8, 9 and 10 restating 2, 4 and 5 in slightly shorter words. Every duplicate is
 * audited on its own, promoted into message 0 at every compaction, and gets its own line in
 * the plan.
 *
 * `nextCriteria` is what the contract should become. A tick that aligns with a criterion
 * CONFIRMS it rather than adding to it; it may sharpen it, but only upwards — if the ticked
 * wording covers strictly more than the criterion's, it replaces it in place, and otherwise
 * the criterion stands. Never the other way round: a checkbox must not be able to narrow what
 * "done" means, which is the same rule the unpicked half already follows.
 */
export function foldAnswer(
  u: Understanding,
  answer: string,
  existing: readonly string[] = [],
): { criteria: string[]; notPicked: string[]; nextCriteria: string[] } {
  const picked = answer.split(';').map((p) => p.trim()).filter((p) => p.length > 0)
  const criteria: string[] = []
  const notPicked: string[] = []

  // EXACT first, and it is what the checkbox path actually produces: the host joins the
  // ticked options with "; ", so every one of them is byte-identical to an option here.
  // Going straight to `alignReadings` let a ticked option ALSO claim a near-identical one
  // the person deliberately left unticked — narrow/wide pairs are exactly what it folds
  // together, and `groupLines` is under explicit instructions to keep such pairs in
  // separate groups, so the question offers them as separate choices and then adopted
  // both. The user was then told "they want these, and they are now part of what done
  // means" about scope they had just declined — and it was audited against, and promoted
  // into message 0 at every compaction after that.
  const unclaimed = [...picked]
  const takeExact = (option: string): boolean => {
    const at = unclaimed.indexOf(option)
    if (at === -1) return false
    unclaimed.splice(at, 1)
    return true
  }

  const fuzzyCandidates: string[] = []
  for (const option of u.contested) {
    if (takeExact(option)) criteria.push(option)
    else fuzzyCandidates.push(option)
  }
  // Only what no exact tick claimed is matched loosely, and only against ticks no option
  // has taken — that is the typed-their-own-words case the alignment exists for.
  for (const option of fuzzyCandidates) {
    if (unclaimed.some((p) => alignReadings(p, option))) criteria.push(option)
    else notPicked.push(option)
  }
  // Free text the person typed instead of picking: their own words outrank every reading,
  // so it is kept exactly as written. `NONE_OF_THESE` is excluded explicitly — it is the
  // harness's own sentence, not the person's, and without this it would sail through as
  // free text and become a criterion reading "None of these — just do what we agreed above".
  for (const p of unclaimed) {
    if (p === NONE_OF_THESE) continue
    if (!u.contested.some((option) => alignReadings(p, option)) && p.length >= MIN_USEFUL_CHARS) {
      criteria.push(p)
    }
  }

  // Fold, do not append. Each picked reading goes into the criterion it already restates —
  // sharpening it when the tick says strictly more — and only a reading that matches nothing
  // in the contract becomes a new criterion. `some` on the result, not on `existing`, so two
  // ticks that both restate the same criterion cannot both land as new ones.
  const nextCriteria = [...existing]
  for (const wanted of criteria) {
    const at = nextCriteria.findIndex((c) => alignReadings(c, wanted))
    if (at === -1) { nextCriteria.push(wanted); continue }
    if (readingCovers(wanted, nextCriteria[at]!)) nextCriteria[at] = wanted
  }
  return { criteria, notPicked, nextCriteria }
}

/**
 * The same fold, with the model deciding what says the same thing.
 *
 * `foldAnswer`'s own merge compares strings, and measured in the running app that is not
 * enough. A session whose contract read "no leading or trailing hyphens in the slug — e.g.
 * slug('---hello---') must not return '-hello-'" was answered with the tick "slug removes
 * leading and trailing hyphens", and `alignReadings` matched NONE of three such ticks against
 * ANY of eight criteria: 8 criteria + 3 ticks came out as 11. Same requirement, different
 * words, and lexical containment cannot see it. The two fixes even worked against each other
 * — putting the request's rule into the contract made the criteria longer and more
 * example-laden, which pushed them further from the terse lines a lens writes.
 *
 * So this asks `groupLines`, which is what `compareReadings` already asks the same question
 * of, and for the same stated reason: "same outcome = same group, even when the wording is
 * nothing alike". `alignReadings` stays as the fallback for when the model cannot answer.
 *
 * Being wrong here is bounded, which is why delegating it is acceptable at all. A merged tick
 * does not vanish: the criterion it merged into is still in the contract, and the caller's
 * message names every ticked line verbatim, so the model reads the person's words either way.
 * And a tick that says strictly MORE than the criterion still replaces it (`readingCovers`),
 * so a wrong grouping cannot cost content — only a separate audit line for a sentence that
 * meant the same thing.
 */
/** One number per ticked line: which criterion it merely restates, or 0 for "something the
 * criteria do not already require". Numbers only, so the answer stays small however long the
 * lines are. */
const RESTATES_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['restates'],
  additionalProperties: false,
  properties: {
    restates: { type: 'array', items: { type: 'integer', minimum: 0 } },
  },
}

/**
 * How many content words a ticked line and the criterion it supposedly restates must have in
 * common before the merge is believed.
 *
 * ONE, and the job is deliberately that narrow: block a merge between lines that are not
 * about the same things at all, and get out of the way otherwise. Measured -- the one wrong
 * merge observed ("totals are shown with a thousands separator" into "every amount is rounded
 * half-up to two decimals before it is summed") shared NOTHING, while a correct one can share
 * as little as a single word: "slug collapses multiple consecutive hyphens into one" and
 * "slugs contain only lowercase letters, digits and single hyphens" have only "hyphen" in
 * common. A floor of two was tried and cost real merges for no extra safety.
 */
const MIN_SHARED_TO_MERGE = 1

/** Room for one small integer per tick, several times over. */
const RESTATES_MAX_TOKENS = 400

/**
 * For each ticked line, the criterion it merely restates -- or 0.
 *
 * A DIFFERENT question from `groupLines`, deliberately, and the difference is measurable.
 * `groupLines` asks a symmetric "which of these jumbled lines mean the same thing" of lines
 * that are all readings of one request; pointed at criteria-versus-ticks it over-merged, and
 * "concurrent requests never produce a duplicate number" was grouped into "invoice numbers
 * are gap-free" -- two different requirements, and the tick would have been dropped. This
 * asks the asymmetric question that is actually being decided: does the contract ALREADY
 * require this?
 *
 * Fails toward 0, i.e. toward keeping the tick. A duplicate criterion is noise; a ticked line
 * that quietly leaves the contract is scope the user asked for and will not get.
 */
async function restatedCriterion(
  client: LlamaClient,
  criteria: readonly string[],
  ticks: readonly string[],
  signal?: AbortSignal,
): Promise<number[] | null> {
  const parsed = await forcedJson(client, {
    messages: [{
      role: 'user',
      content: [
        'A task already has these done-criteria:',
        ...criteria.map((c, i) => `${i + 1}. ${c}`),
        '',
        'The user was asked what they meant and ticked these lines:',
        ...ticks.map((t, i) => `${i + 1}. ${t}`),
        '',
        'For each ticked line IN ORDER, answer with one number: the number of the ' +
        'criterion that ALREADY REQUIRES it, or 0 if none of them does.',
        '',
        'A criterion already requires a line when it says the same thing in other words, ' +
        'and also when it FORCES it: \"slugs contain only lowercase letters, digits and ' +
        'hyphens\" already requires \"slugs never contain punctuation\" and already ' +
        'requires \"slug of Hi! is hi\" -- neither of those is new, so both ' +
        'get that criterion number.',
        '',
        'Be careful in the other direction: \"numbers are never skipped\" and ' +
        '\"numbers are never repeated\" are DIFFERENT requirements even though ' +
        'both are about numbers, and neither one forces the other. Answering with a ' +
        'criterion number for a line the criteria do not cover drops something the user ' +
        'just asked for, so when it is genuinely a different requirement, answer 0.',
        '',
        `Give exactly ${ticks.length} number(s). Answer with JSON only.`,
      ].join('\n'),
    }],
    name: 'restates',
    schema: RESTATES_SCHEMA,
    maxTokens: RESTATES_MAX_TOKENS,
    disableThinking: true,
    ...(signal ? { signal } : {}),
  })
  if (typeof parsed !== 'object' || parsed === null) return null
  const raw = (parsed as { restates?: unknown }).restates
  if (!Array.isArray(raw)) return null
  // Anything that is not a usable index reads as 0 -- keep the tick. A short answer is
  // padded rather than treated as a failure, for the same reason.
  const out: number[] = []
  for (let i = 0; i < ticks.length; i++) {
    const n = raw[i]
    out.push(typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= criteria.length ? n : 0)
  }
  return out
}

/**
 * The contested readings the contract does NOT already carry, and the mapping that decided it.
 *
 * A contested reading is a line one lens wrote and another did not. That makes it a candidate
 * for a QUESTION -- but not every disagreement between lenses is a disagreement about the
 * task: the contract was distilled from the same request, so a reading the contract already
 * states is a question whose answer is written down two fields away.
 *
 * Measured in the running app. The card offered three readings:
 *
 *   Slugs contain only lowercase letters, digits, and single hyphens
 *   No slug starts or ends with a hyphen
 *   Punctuation is stripped before slug generation
 *
 * against a contract whose first two criteria were "slugs contain only lowercase letters,
 * digits and single hyphens -- e.g. ..." and "no leading or trailing hyphen -- e.g. ...".
 * All three were already required. The turn stopped, a person was interrupted, three boxes
 * were ticked, and the contract came back byte-identical.
 *
 * `readThroughLenses` cannot see this: it compares readings with each other and never with
 * the contract, even though `session.ts` holds both. This is that comparison.
 *
 * It costs nothing extra. The same question was already being asked AFTER the answer, to fold
 * the ticks in; asking it here instead means one generation either way, and the returned
 * mapping is handed to `foldAnswerWithModel` so it does not ask again.
 *
 * Fails OPEN: when the model cannot answer, every contested point survives and the question is
 * asked exactly as before. Suppressing a question is the one direction that loses something.
 */
export async function contestedBeyondContract(
  client: LlamaClient,
  u: Understanding,
  existing: readonly string[],
  signal?: AbortSignal,
): Promise<{ understanding: Understanding; known: Map<string, number> }> {
  const known = new Map<string, number>()
  if (u.contested.length === 0 || existing.length === 0) return { understanding: u, known }

  const restates = await restatedCriterion(client, existing, u.contested, signal)
  if (restates === null) return { understanding: u, known }

  const contested: string[] = []
  u.contested.forEach((reading, i) => {
    const at = (restates[i] ?? 0) - 1
    // The same floor the fold uses: two lines that are not about the same things are not the
    // same requirement, whatever was answered. See `sharedContentWords`.
    const covered = at >= 0 && sharedContentWords(reading, existing[at]!) >= MIN_SHARED_TO_MERGE
    if (covered) known.set(reading, at + 1)
    else contested.push(reading)
  })
  return { understanding: { ...u, contested }, known }
}


export async function foldAnswerWithModel(
  client: LlamaClient,
  u: Understanding,
  answer: string,
  existing: readonly string[],
  signal?: AbortSignal,
  /** An answer to the same question, already obtained -- see `contestedBeyondContract`, which
   * asks it BEFORE the person is interrupted so it can drop the readings the contract already
   * carries. Passing it here is what keeps the whole path at ONE generation: the mapping is
   * computed once and used twice, rather than asked for again after the answer comes back. */
  known?: ReadonlyMap<string, number>,
): Promise<{ criteria: string[]; notPicked: string[]; nextCriteria: string[] }> {
  const folded = foldAnswer(u, answer, existing)
  if (folded.criteria.length === 0 || existing.length === 0) return folded

  const restates = known !== undefined
    ? folded.criteria.map((tick) => known.get(tick) ?? 0)
    : await restatedCriterion(client, existing, folded.criteria, signal)
  // `null` is "could not ask", and the string comparison is a real answer rather than a
  // guess -- so it stands, exactly as it did before this function existed.
  if (restates === null) return folded

  const next = [...existing]
  const appended: string[] = []
  folded.criteria.forEach((tick, i) => {
    const at = (restates[i] ?? 0) - 1
    // The floor the model's answer has to clear: see `sharedContentWords`. Two lines that are
    // not even about the same things are not the same requirement, whatever was answered.
    if (at < 0 || sharedContentWords(tick, existing[at]!) < MIN_SHARED_TO_MERGE) {
      appended.push(tick)
      return
    }
    // The criterion stands. A tick may still sharpen it, and only upwards -- a checkbox must
    // never narrow what "done" means.
    if (readingCovers(tick, next[at]!)) next[at] = tick
  })
  return { ...folded, nextCriteria: [...next, ...appended] }
}
