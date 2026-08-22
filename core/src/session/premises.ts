import { readFileSync } from 'node:fs'
import type { LlamaClient } from '../llama/client.js'
import type { ChatMessage, ToolSchema } from '../llama/types.js'
import { forcedJson } from './forced-json.js'

/**
 * The other half of "the model thought wrong", and the half with a hard oracle.
 *
 * The understanding check covers a misread REQUEST, and it works by disagreement: three
 * readings, and where they differ the model is guessing. That method is blind to the second
 * failure, because there the readings all agree — the model is confidently wrong about the
 * CODE. It believes a method validates its input, or takes a different argument, or that a
 * helper exists at all, and every reading of the request inherits the same false belief.
 *
 * There is no disagreement to measure there. There is something better: the code is sitting
 * on disk, and it is the ground truth. So the model is made to state the facts its change
 * depends on and to QUOTE each one from the file it came from — and the harness checks the
 * quote is actually there.
 *
 * That check is a string search, which is the point. It is not a judgement, cannot be talked
 * out of, and costs nothing. It is the same move the repro red-gate makes on a symptom
 * ("prove it fails before you fix it") applied to a belief ("show me the line you are relying
 * on"). A premise that cannot be found is, every time, one of the small set of things that
 * produce working code with wrong logic: a hallucinated API, an imagined signature, a
 * remembered validation that is not in the file.
 *
 * Whitespace is normalised on both sides before the search, and nothing else is. The model
 * reindents and rewraps what it quotes and that is not a false belief; if it changes an
 * identifier or an operator, that is exactly the failure this exists to catch, and the quote
 * will not be found.
 */

export interface Premise {
  file: string
  quote: string
  why: string
}

/** How the model's path is turned into something readable — the workspace itself in the
 * app, which is the only thing that knows about attached folders and their name prefixes.
 * Getting this wrong is not hypothetical: the project-notes feature spent its whole life
 * silently refusing every note because it used `join(root, path)` instead. */
export interface FileReader {
  resolve(relativePath: string): string
}

/** The shape the answer is held to, enforced by the sampler rather than by a one-tool
 * `tools` array — see `forced-json.ts` for the 61.9 s per gate that bought. */
const PREMISE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['premises'],
  additionalProperties: false,
  properties: {
    premises: {
      type: 'array',
      description: 'Two to five. Only the things that would BREAK your change if they ' +
        'turned out to be false — not a tour of the codebase.',
      items: {
        type: 'object',
        required: ['file', 'quote', 'why'],
        additionalProperties: false,
        properties: {
          file: {
            type: 'string',
            description: 'The file the quote is from, named exactly as the tools show ' +
              'it to you — including the folder prefix when the workspace has several.',
          },
          quote: {
            type: 'string',
            description: 'The lines themselves, copied out of the file. Word for word: ' +
              'this is checked against the file, so a remembered or tidied-up version ' +
              'will not match. One to five lines from ONE place — if you are relying on ' +
              'two different parts of the file, that is two premises, not one quote ' +
              'stitched together. Do not paraphrase and do not elide with "...".',
          },
          why: {
            type: 'string',
            description: 'One short line: what your change relies on this for.',
          },
        },
      },
    },
  },
}

/** Sized several times over the worst healthy answer, per this project's cap rule: a cap a
 * good generation can reach fails SILENTLY, because a `length` finish carries no tool call. */
const PREMISE_MAX_TOKENS = 2_000

/** Long enough for a small function, short enough that "quote the file" cannot become
 * "paste the file" — a quote that is the whole file proves nothing about the belief. */
const MAX_QUOTE_CHARS = 600

/** Past this the model is touring the codebase rather than naming what it depends on. */
const MAX_PREMISES = 5

/** Matched to `read_file`'s own ceiling on purpose: below it, the model can open the file and
 * quote from it, so anything this check refuses to read is a file it would then wrongly
 * report as an unreadable PATH — sending the model to fix a name that was right. */
const MAX_FILE_BYTES = 10 * 1024 * 1024

export interface PremiseCheck {
  verified: Premise[]
  /** Each with the reason it could not be confirmed, in the model's own terms. */
  unverified: { premise: Premise; problem: string }[]
}

/**
 * Whitespace folded flat, and nothing else touched.
 *
 * Indentation, line breaks and trailing spaces are the model's formatting, not its belief —
 * it will rewrap a quote to fit its answer and reindent it out of a nested block, and calling
 * either a false premise would make the check cry wolf until it was switched off. Everything
 * that carries meaning — identifiers, operators, punctuation, case — is left exactly as it
 * is, so a changed argument name or a flipped comparison still fails to match.
 */
export function normaliseCode(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * The file with its comments taken out, so a comment cannot stand as evidence for code.
 *
 * The hole this closes: the check was a substring search over the whole file, so
 * `// TODO: add validateInvoiceNumber(n)` — or a commented-out old implementation, or a
 * doc-comment describing a method that was removed — confirmed a premise about a method
 * that does not exist. That is the exact failure the premise check is for, passing.
 *
 * A doc comment is still worth reading and the model is still welcome to rely on one; it is
 * just not proof that the CODE does anything, and being told so sends it to look at the code,
 * which is where the belief has to come from.
 *
 * Deliberately crude — `//` to end of line and `/* … *​/` blocks, which covers every language
 * this project navigates. A `//` inside a string literal takes the rest of that line with it,
 * and that only ever makes the check STRICTER: the worst case is a premise reported as
 * unverified, which the model answers by quoting a different line.
 */
export function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** A quoted line short enough to appear in any file — a lone brace, a `})`, an `else`. Not
 * evidence of anything, so it is neither required to match nor allowed to carry a premise. */
const MIN_EVIDENCE_LINE_CHARS = 8

/**
 * Whether the quote is really in the file, checked twice and for two different things.
 *
 * The whole block first: that is the strict reading and it is what a copied span satisfies.
 * Then, if that fails, LINE BY LINE — every line long enough to mean anything has to be in
 * the file, though not next to each other.
 *
 * The second pass exists because of a live failure that was not a false belief. Asked for the
 * lines it was relying on, the model returned `import { db } from "./db" export class
 * InvoiceService { async allocate(...)` — three real lines from three different places, with
 * the method between them elided, joined into one quote. Nothing in it was invented; it had
 * simply summarised the file's shape. Refusing that would have the check crying wolf on a
 * perfectly healthy turn, which is how a check like this ends up switched off.
 *
 * What the looser pass gives up is the claim that the lines are ADJACENT, which nothing was
 * relying on. What it keeps is the only thing that matters: every line the model says it is
 * going by has to exist. A hallucinated method, an imagined signature, a remembered
 * validation — none of those are in the file on any line, and none of them survive this.
 */
export function quoteIsInFile(quote: string, normalisedContent: string): boolean {
  // The evidence floor applies to BOTH passes. It used to guard only the loose one, so a
  // quote of `}` or `})` sailed through the strict pass — which is a substring search over
  // the whole file and matches a brace everywhere. The test that claimed otherwise was
  // asserting the loose pass and never reached this.
  const whole = normaliseCode(quote)
  if (whole.length < MIN_EVIDENCE_LINE_CHARS) return false
  if (normalisedContent.includes(whole)) return true
  const lines = quote.split('\n').map(normaliseCode)
  const evidence = lines.filter((l) => l.length >= MIN_EVIDENCE_LINE_CHARS)
  if (evidence.length === 0) return false
  // Every line that carries content has to be there — and a SHORT line is dropped from the
  // requirement, which is the hole this closes: `if (!x)` is seven characters, so an invented
  // one used to be skipped rather than checked while the premise still verified on its
  // neighbours. A quote whose short lines outnumber its evidence is not evidence.
  if (evidence.length * 2 < lines.filter((l) => l.length > 0).length) return false
  return evidence.every((l) => normalisedContent.includes(l))
}

export function parsePremises(argsJson: string): Premise[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(argsJson)
  } catch {
    return null
  }
  return readPremises(parsed)
}

function readPremises(parsed: unknown): Premise[] | null {
  const raw = (parsed as { premises?: unknown } | null)?.premises
  if (!Array.isArray(raw)) return null
  const out: Premise[] = []
  for (const entry of raw.slice(0, MAX_PREMISES)) {
    if (typeof entry !== 'object' || entry === null) continue
    const o = entry as Record<string, unknown>
    const file = typeof o['file'] === 'string' ? o['file'].trim() : ''
    const quote = typeof o['quote'] === 'string' ? o['quote'].trim() : ''
    const why = typeof o['why'] === 'string' ? o['why'].trim() : ''
    // A quote of a few characters matches half of any file and proves nothing.
    if (file === '' || quote.length < 8) continue
    out.push({ file, quote: quote.slice(0, MAX_QUOTE_CHARS), why })
  }
  return out.length > 0 ? out : null
}

/**
 * Each premise against the file it claims to come from.
 *
 * Failures are separated by KIND because they mean different things to the model and one of
 * them is not its fault: a path that does not resolve is usually a naming mistake (the
 * folder prefix in a multi-folder workspace), while a quote that is absent from a file that
 * does exist is the belief itself being wrong. Told the wrong one, the model fixes the wrong
 * thing.
 */
export function verifyPremises(premises: readonly Premise[], where: FileReader): PremiseCheck {
  const verified: Premise[] = []
  const unverified: { premise: Premise; problem: string }[] = []
  const cache = new Map<string, { code: string; full: string } | null>()

  for (const premise of premises) {
    let content = cache.get(premise.file)
    if (content === undefined) {
      content = null
      try {
        const absolute = where.resolve(premise.file)
        const raw = readFileSync(absolute)
        if (raw.byteLength <= MAX_FILE_BYTES) {
          const text = raw.toString('utf8')
          // Two views of the same file: what it says, and what it DOES. See `stripComments`.
          content = { code: normaliseCode(stripComments(text)), full: normaliseCode(text) }
        }
      } catch {
        content = null
      }
      cache.set(premise.file, content)
    }
    if (content === null) {
      unverified.push({
        premise,
        problem: 'that file could not be read here — check the path is exactly what the ' +
          'tools showed you, folder prefix included',
      })
      continue
    }
    // BOTH sides comment-stripped, not just the file. Stripping only the file made every
    // comment line inside an otherwise-genuine quote into required evidence that could not
    // possibly be found: the loose pass keeps every line of 8+ characters, and a comment
    // line is exactly that. A model that really had copied four consecutive lines spanning
    // one comment was told "those lines are only in a COMMENT there" — the one message that
    // does not describe what happened — and the whole batched step halted, discarding every
    // queued edit, to go and re-read files it had read correctly. In a codebase this
    // comment-dense that is most multi-line quotes.
    //
    // A quote that is ONLY comments still strips to nothing, falls through, and is still
    // named as a comment below — which is the case that branch was written for.
    if (quoteIsInFile(stripComments(premise.quote), content.code)) verified.push(premise)
    else if (quoteIsInFile(premise.quote, content.full)) {
      // Found, but only among the comments. Said precisely, because the difference decides
      // what the model does next: re-quoting a different comment will not help, and reading
      // the code will.
      unverified.push({
        premise,
        problem: 'those lines are only in a COMMENT there, not in the code — a note about ' +
          'what something does is not evidence that it does it. Quote the code you are ' +
          'relying on, or check it still exists',
      })
    } else {
      unverified.push({
        premise,
        problem: 'those lines are not in that file — indentation and line breaks are ' +
          'ignored, so this is not a formatting difference',
      })
    }
  }
  return { verified, unverified }
}

/**
 * The forced generation, run over the live transcript at the moment before the first write.
 *
 * The transcript is where the reading already happened, so this costs one generation and no
 * new prefill worth counting. Thinking is off: naming what you just read and copying a line
 * out of it is restating, and restating with thinking on is measured waste on this server.
 */
export async function statePremises(
  client: LlamaClient,
  transcript: readonly ChatMessage[],
  signal?: AbortSignal,
  /** The session's own tool array, unchanged, so this stays a pure append. */
  tools?: readonly ToolSchema[],
): Promise<Premise[] | null> {
  const messages: ChatMessage[] = [
    ...transcript,
    {
      role: 'user',
      content:
        '[One more thing before you write. What are you ASSUMING about this codebase — the ' +
        'things that, if they turned out to be different, would make your change wrong?\n\n' +
        'For each one, paste the actual lines you are going by and say which file they came ' +
        'from. Copy them, do not retype them from memory: I am going to look them up, and a ' +
        'tidied-up version will not match. If you cannot find the lines for something you ' +
        'were about to rely on, that is worth knowing now.\n\n' +
        // Moved out of PREMISE_SCHEMA's `description` fields: a response_format schema is
        // compiled to a grammar and is never rendered, so anything written there is invisible
        // to the model. These two rules are what the verifier actually checks against.
        'Two to five of them — only the things that would BREAK your change if they turned ' +
        'out to be false, not a tour of the codebase. Name the file exactly as the tools ' +
        'showed it to you, INCLUDING the folder prefix when this workspace has several. ' +
        'Quote one to five lines from ONE place: if you are relying on two different parts ' +
        'of a file, that is two premises, not one quote stitched together. Do not paraphrase ' +
        'and do not elide with "...". Say in one short line what your change relies on each ' +
        'one for.\n\n' +
        'Answer with JSON only. Do not start the work.]',
    },
  ]
  const parsed = await forcedJson(client, {
    messages,
    name: 'premises',
    schema: PREMISE_SCHEMA,
    maxTokens: PREMISE_MAX_TOKENS,
    disableThinking: true,
    ...(tools ? { tools } : {}),
    ...(signal ? { signal } : {}),
  })
  return parsed === null ? null : readPremises(parsed)
}

/**
 * What the model is told when a premise does not check out.
 *
 * Names the confirmed ones too, briefly. Without that the message reads as "everything you
 * believe is wrong", which sends a model rewriting code that was fine — the same failure the
 * verify runner's message is worded around. The instruction is narrow on purpose: go and
 * look, then continue. Not "start over".
 */
/** Same job as `ACCEPTANCE_FIXER_PREFIX` in contract.ts: `replay.ts` reads it so this is not
 * replayed as something the person typed. */
export const PREMISE_FAILURE_PREFIX = 'Not run: some of what you are relying on is not in the files.'

export function premiseFailureMessage(check: PremiseCheck): string {
  const bad = check.unverified
    .map((u) => `- ${u.premise.file}: ${u.premise.why}\n  you quoted: ${u.premise.quote.split('\n')[0]}\n  ${u.problem}`)
    .join('\n')
  const good = check.verified.length > 0
    ? `\n${check.verified.length} of your other assumptions did check out and are fine.\n`
    : ''
  return `${PREMISE_FAILURE_PREFIX}\n\n` + bad + '\n' + good +
    '\nRead those places again before you change anything — what is actually there may not ' +
    'need the change you were about to make, or may need a different one. Nothing was written.'
}
