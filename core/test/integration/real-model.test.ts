import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { Agent, type StepInfo, type StepStartInfo } from '../../src/agent/loop.js'
import { LlamaClient } from '../../src/llama/client.js'
import { Workspace } from '../../src/workspace.js'
import { buildRegistry } from '../../src/tools/default-set.js'

/**
 * Every file in the tree, by path and by bytes.
 *
 * Plan mode used to be checked by comparing one file's contents before and after. That
 * cannot see the escape a real plan-mode failure actually produces — a file the agent
 * *created* — and "no editing tools are available to you at all" is a promise about the
 * whole workspace, which is the acceptance criterion. The listing is returned alongside
 * the hash so a failure names the file instead of printing two hex strings.
 */
function snapshotTree(dir: string): { files: string[]; hash: string } {
  const files: string[] = []
  const h = createHash('sha256')
  const walk = (current: string, prefix: string): void => {
    const entries = readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const rel = prefix + entry.name
      if (entry.isDirectory()) {
        files.push(`${rel}/`)
        h.update(`D ${rel}\n`)
        walk(join(current, entry.name), `${rel}/`)
      } else {
        files.push(rel)
        h.update(`F ${rel} `)
        h.update(readFileSync(join(current, entry.name)))
        h.update('\n')
      }
    }
  }
  walk(dir, '')
  return { files, hash: h.digest('hex') }
}

/**
 * Compiles the (small, single-function) edited file and actually calls slugify, instead
 * of grepping the source for a substring. `expect(after).toMatch(/replace\(/)` used to
 * pass before the agent ran at all, because the ORIGINAL file already contains
 * `replace(` — it proved nothing about whether the requested change landed. This proves
 * the behavior: a model that "improves" the file in some other shape (a different regex,
 * a different helper) still passes as long as slugify actually strips the characters the
 * task asked for; a model that left slugify unchanged fails here even if it happened to
 * add an unrelated `replace(` call elsewhere in the file.
 */
function loadSlugify(source: string): (title: string) => string {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  })
  const exports: { slugify?: (title: string) => string } = {}
  new Function('exports', outputText)(exports)
  if (typeof exports.slugify !== 'function') {
    throw new Error(`src/slug.ts no longer exports a slugify function:\n${source}`)
  }
  return exports.slugify
}

/**
 * Compiles and calls the edited tokenizer, the same way loadSlugify does and for the same
 * reason: the task leaves the model free to choose its own shape, so the outcome has to be
 * proved behaviourally rather than by grepping for a spelling.
 */
interface Token { kind: string; text: string }
function loadTokenize(source: string): (input: string) => Token[] {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  })
  const exports: { tokenize?: (input: string) => Token[] } = {}
  new Function('exports', outputText)(exports)
  if (typeof exports.tokenize !== 'function') {
    throw new Error(`src/tokenizer.ts no longer exports a tokenize function:\n${source}`)
  }
  return exports.tokenize
}

const SERVER = process.env.PRIVATECODE_SERVER ?? 'http://127.0.0.1:8080'
const enabled = process.env.PRIVATECODE_INTEGRATION === '1'

const ORIGINAL_SLUG =
  'export function slugify(title: string): string {\n' +
  '  return title.toLowerCase().replace(/ /g, "-")\n' +
  '}\n'

/** U+FEFF, built from its code point because the character itself is invisible. */
const BOM = String.fromCharCode(0xfeff)

/**
 * The hard fixture. Both live runs so far used the 3-line slug file, produced at most 584
 * completion tokens against the budget, and had zero truncation continuations — so the
 * truncation-continuation path, which is the source of Task 11's Critical, had never once
 * run against the live model. This is the shape the spike measured at 1900+ thinking
 * tokens: substantially longer, escaping-heavy (regex literals full of backslashes and
 * both quote characters), CRLF throughout, and carrying a UTF-8 BOM — so it also puts the
 * write path's line-ending and BOM preservation in front of the real model instead of only
 * in front of a unit test.
 */
const HARD_LINES = [
  '// Tokenizer for a small config language.',
  'export interface Token {',
  '  kind: "string" | "number" | "ident"',
  '  text: string',
  '}',
  '',
  '/** A double-quoted string, with backslash escapes. */',
  String.raw`const DOUBLE = /^"((?:[^"\\]|\\.)*)"/`,
  '',
  '/** A single-quoted string, with backslash escapes. */',
  String.raw`const SINGLE = /^'((?:[^'\\]|\\.)*)'/`,
  '',
  String.raw`const NUMBER = /^-?\d+(?:\.\d+)?/`,
  String.raw`const IDENT = /^[A-Za-z_][A-Za-z0-9_]*/`,
  String.raw`const WHITESPACE = /^\s+/`,
  '',
  '/** Turns \\n and \\t into real characters and drops any other backslash. */',
  'function unescapeBody(body: string): string {',
  String.raw`  return body.replace(/\\(.)/g, (_match, ch: string) => {`,
  '    if (ch === "n") return "\\n"',
  '    if (ch === "t") return "\\t"',
  '    return ch',
  '  })',
  '}',
  '',
  'export function tokenize(input: string): Token[] {',
  '  const out: Token[] = []',
  '  let rest = input',
  '  while (rest.length > 0) {',
  '    const ws = WHITESPACE.exec(rest)',
  '    if (ws) {',
  '      rest = rest.slice(ws[0].length)',
  '      continue',
  '    }',
  '    const dq = DOUBLE.exec(rest)',
  '    if (dq) {',
  '      out.push({ kind: "string", text: unescapeBody(dq[1] as string) })',
  '      rest = rest.slice(dq[0].length)',
  '      continue',
  '    }',
  '    const sq = SINGLE.exec(rest)',
  '    if (sq) {',
  '      out.push({ kind: "string", text: unescapeBody(sq[1] as string) })',
  '      rest = rest.slice(sq[0].length)',
  '      continue',
  '    }',
  '    const num = NUMBER.exec(rest)',
  '    if (num) {',
  '      out.push({ kind: "number", text: num[0] })',
  '      rest = rest.slice(num[0].length)',
  '      continue',
  '    }',
  '    const id = IDENT.exec(rest)',
  '    if (id) {',
  '      out.push({ kind: "ident", text: id[0] })',
  '      rest = rest.slice(id[0].length)',
  '      continue',
  '    }',
  '    throw new Error("unexpected input at: " + rest.slice(0, 20))',
  '  }',
  '  return out',
  '}',
]

const ORIGINAL_TOKENIZER = `${BOM}${HARD_LINES.join('\r\n')}\r\n`

/** What a run actually did, so the report can state it rather than infer it. */
interface RunRecord { continuations: number[]; steps: StepInfo[] }

describe.runIf(enabled)('against the real Qwen3.6 server', () => {
  let root: string

  beforeAll(async () => {
    const client = new LlamaClient({ baseUrl: SERVER, model: 'Qwen3.6-35B-A3B' })
    if (!(await client.health())) {
      throw new Error(
        `llama.cpp is not reachable at ${SERVER}. Start D:\\LocalAgentAI\\Start-QwenServer.bat ` +
        'and wait for the dashboard to show RUNNING before running this test.',
      )
    }
  })

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'pc-int-'))
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'slug.ts'), ORIGINAL_SLUG)
    writeFileSync(join(root, 'src', 'tokenizer.ts'), ORIGINAL_TOKENIZER)
  })

  // Each run of this suite created its own %TEMP%\pc-int-* directory and never removed
  // it, leaking one per invocation. force: true because this only needs to best-effort
  // clean up a scratch directory, not fail the suite if something is still holding a
  // handle open on it.
  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /**
   * Prints exactly what Task 12's brief asks the run to report: per-step wall time,
   * tok/s, and whether a step continued after truncation. Nothing here is asserted on —
   * it is the human-readable record of what the live model actually did.
   */
  function loggingEvents(label: string, record?: RunRecord) {
    return {
      onStepStart: (i: StepStartInfo) =>
        console.log(`  [${label}] step ${i.step} start (budget ${i.timeoutMs} ms)`),
      onContinuation: (step: number) => {
        record?.continuations.push(step)
        console.log(`  [${label}] step ${step}: CONTINUATION (ran out of room, forcing action)`)
      },
      onStepDone: (i: StepInfo) => {
        record?.steps.push(i)
        console.log(
          `  [${label}] step ${i.step} done: ${i.seconds.toFixed(1)}s` +
          `${i.tokensPerSecond ? `, ${i.tokensPerSecond.toFixed(1)} tok/s` : ''}` +
          `${i.completionTokens ? `, ${i.completionTokens} completion tokens` : ''}` +
          `${i.continued ? ' [TRUNCATED, continued]' : ''}`,
        )
      },
      onToolCall: (name: string, args: string) =>
        console.log(`  [${label}] tool call: ${name} ${args.slice(0, 200)}`),
      onToolResult: (name: string, r: { ok: boolean; content: string }) =>
        console.log(`  [${label}] tool result (${name}, ok=${r.ok}): ${r.content.split('\n')[0]?.slice(0, 200)}`),
      onAssistantText: (t: string) => console.log(`  [${label}] assistant: ${t.slice(0, 300)}`),
    }
  }

  // Deliberately does NOT pass allowedTools for mode: 'plan'. That omission is exactly
  // the configuration a reviewer showed writes to disk anyway — this proves Agent's own
  // derivation (loop.ts, mode === 'plan') closes it for real, against the live server and
  // its real grammar, not just against the fake server in the unit suite.
  function agent(mode: 'normal' | 'plan', label: string, record?: RunRecord) {
    return new Agent({
      client: new LlamaClient({ baseUrl: SERVER, model: 'Qwen3.6-35B-A3B' }),
      registry: buildRegistry(),
      context: { workspace: new Workspace(root) },
      mode,
      maxSteps: 12,
      events: loggingEvents(label, record),
    })
  }

  test('finds and edits a real file', { timeout: 600_000 }, async () => {
    const started = Date.now()
    const result = await agent('normal', 'edit').runTurn(
      'In src/slug.ts, make slugify also strip characters that are not letters, digits or ' +
      'hyphens, after lowercasing. Change only that file.',
    )
    const elapsed = (Date.now() - started) / 1000

    console.log(
      `\n[edit] stoppedBecause=${result.stoppedBecause}, steps=${result.steps}, ` +
      `wall=${elapsed.toFixed(1)}s`,
    )
    console.log(`[edit] final text: ${result.finalText.slice(0, 300)}`)

    // The widened stoppedBecause vocabulary ('timeout' | 'truncated' are real outcomes on
    // a slow local model, not exotic errors) means the interesting fact is not which
    // label the turn ended on, but whether the edit actually happened. Report the label,
    // don't gate on one specific value.
    const after = readFileSync(join(root, 'src', 'slug.ts'), 'utf8')
    console.log(`[edit] file after run:\n${after}`)

    expect(after).not.toBe(ORIGINAL_SLUG)

    // Behavioral proof the requested change actually landed: strips characters that are
    // not letters, digits or hyphens, after lowercasing. Deliberately not an exact-string
    // match on the output — the task left the model free to choose its own regex/helper
    // shape, and pinning one exact spelling would make this test load-bearing on style
    // rather than on the outcome the task actually asked for.
    const slugify = loadSlugify(after)
    const slug = slugify('Hello, World! #1')
    expect(slug).toMatch(/^[a-z0-9-]+$/)
    expect(slug.toLowerCase()).toBe(slug)
    expect(slug).not.toMatch(/[,!#]/)
    expect(slug).toContain('hello')
    expect(slug).toContain('world')
  })

  /**
   * The hard case. Both previous live runs used the 3-line slug fixture, produced at most
   * 584 completion tokens against the budget, and had zero truncation continuations — so
   * the truncation-continuation path, the source of Task 11's Critical, had never run
   * against the real model at all. This is the shape the spike measured at 1900+ thinking
   * tokens.
   *
   * Whether it truncates is reported, not asserted. If it does, the continuation path has
   * finally been exercised live; if it does not, that is information about the new 8000-
   * token default and is stated as such rather than treated as a failure.
   */
  test('edits a long, CRLF, escaping-heavy file', { timeout: 900_000 }, async () => {
    // Guard on the fixture itself: it must compile, and the backtick case must not already
    // work. Otherwise a broken fixture would fail this test for a reason that has nothing
    // to do with the model.
    expect(() => loadTokenize(ORIGINAL_TOKENIZER)('`hello`')).toThrow(/unexpected input/)

    const record: RunRecord = { continuations: [], steps: [] }
    const started = Date.now()
    const result = await agent('normal', 'hard', record).runTurn(
      'In src/tokenizer.ts, add support for backtick-quoted strings: a run of characters ' +
      'between two backticks, tokenized exactly like the double-quoted case — kind ' +
      '"string", with the same backslash unescaping applied to its body. Leave the ' +
      'existing cases working. Change only that file.',
    )
    const elapsed = (Date.now() - started) / 1000

    const maxCompletion = Math.max(0, ...record.steps.map((s) => s.completionTokens ?? 0))
    console.log(
      `\n[hard] stoppedBecause=${result.stoppedBecause}, steps=${result.steps}, ` +
      `wall=${elapsed.toFixed(1)}s`,
    )
    console.log(
      `[hard] truncation continuations: ${record.continuations.length}` +
      `${record.continuations.length ? ` (steps ${record.continuations.join(', ')})` : ''}`,
    )
    console.log(`[hard] highest completion_tokens in one step: ${maxCompletion}`)
    console.log(`[hard] final text: ${result.finalText.slice(0, 300)}`)

    const bytes = readFileSync(join(root, 'src', 'tokenizer.ts'))
    const after = bytes.toString('utf8')
    expect(after).not.toBe(ORIGINAL_TOKENIZER)

    // The behaviour the task asked for, proved by running it: the new case works and the
    // old ones still do. Deliberately not an exact-string match — the model is free to
    // pick its own regex and its own place to put it.
    const tokenize = loadTokenize(after)
    expect(tokenize('`hello`')).toEqual([{ kind: 'string', text: 'hello' }])
    expect(tokenize('`a b`')).toEqual([{ kind: 'string', text: 'a b' }])
    expect(tokenize('"quoted" 42 name')).toEqual([
      { kind: 'string', text: 'quoted' },
      { kind: 'number', text: '42' },
      { kind: 'ident', text: 'name' },
    ])
    expect(tokenize("'single'")).toEqual([{ kind: 'string', text: 'single' }])

    // The branch's worst defect class, in front of the live model rather than only a unit
    // test: whichever write tool the model reached for, the file's CRLF endings and its
    // UTF-8 BOM have to survive. A whole-file re-ending disables the user's git, which the
    // design names as the only safety net.
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(after).toContain('\r\n')
    expect(after.replace(/\r\n/g, '')).not.toContain('\n')
  })

  /**
   * The truncation continuation, against the real server.
   *
   * The case above did not truncate — 0 continuations, 266 completion tokens at its peak
   * against the 8000-token budget — so on its own it leaves the continuation path exactly
   * where it was: never once run against the live model, despite being the source of Task
   * 11's Critical. Rather than hunt for a task that happens to make a well-prompted model
   * spiral, the budget is squeezed until truncation is certain, which reaches the same
   * code by the same route.
   *
   * What only a live run can establish, and the fake server cannot: llama.cpp accepts the
   * transcript the continuation builds — an assistant turn carrying reasoning_content, no
   * tool_calls, followed by a user nudge — and answers it under `tool_choice: 'required'`.
   * A strict endpoint rejecting that shape would be invisible in the unit suite.
   */
  test('the truncation continuation runs against the live model', { timeout: 600_000 }, async () => {
    const record: RunRecord = { continuations: [], steps: [] }
    const squeezed = new Agent({
      client: new LlamaClient({ baseUrl: SERVER, model: 'Qwen3.6-35B-A3B' }),
      registry: buildRegistry(),
      context: { workspace: new Workspace(root) },
      // Far below anything the model can finish a thought in, so finish_reason 'length'
      // is certain rather than hoped for.
      maxTokensPerStep: 96,
      maxSteps: 2,
      events: loggingEvents('trunc', record),
    })

    const result = await squeezed.runTurn(
      'In src/tokenizer.ts, work out whether the escape handling in unescapeBody is ' +
      'correct for a backslash at the very end of a string body, and fix it if it is not.',
    )

    console.log(
      `\n[trunc] stoppedBecause=${result.stoppedBecause}, steps=${result.steps}, ` +
      `continuations=${record.continuations.length}`,
    )
    console.log(`[trunc] final text: ${result.finalText.slice(0, 200)}`)

    // The continuation was really issued, and the server really answered it.
    expect(record.continuations.length).toBeGreaterThan(0)
    expect(record.steps.some((s) => s.continued)).toBe(true)
    // Whatever it decided, the turn ends in a stated outcome rather than an exception or
    // an empty 'done'.
    expect(['truncated', 'done', 'max_steps']).toContain(result.stoppedBecause)
    expect(result.finalText).not.toBe('')
  })

  test('plan mode cannot write, because the tools are not offered',
    { timeout: 600_000 }, async () => {
    // The whole tree, not one file: the escape a real plan-mode failure produces is a
    // file that did not exist before, and comparing src/slug.ts to itself cannot see one.
    const before = snapshotTree(root)
    const started = Date.now()
    const result = await agent('plan', 'plan').runTurn(
      'Add JSDoc to slugify, and write your plan to PLAN.md.')
    const elapsed = (Date.now() - started) / 1000

    console.log(
      `\n[plan] stoppedBecause=${result.stoppedBecause}, steps=${result.steps}, ` +
      `wall=${elapsed.toFixed(1)}s`,
    )
    console.log(`[plan] final text: ${result.finalText.slice(0, 300)}`)

    const after = snapshotTree(root)
    // Listing first, so a failure names the file that appeared instead of printing two
    // hex digests; the hash then covers content changes the listing cannot see.
    expect(after.files).toEqual(before.files)
    expect(after.hash).toBe(before.hash)
  })
})
