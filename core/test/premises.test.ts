import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  normaliseCode, parsePremises, premiseFailureMessage, quoteIsInFile, statePremises, verifyPremises,
} from '../src/session/premises.js'
import { Workspace } from '../src/workspace.js'
import { LlamaClient } from '../src/llama/client.js'
import { startFakeServer } from './fake-server.js'

/**
 * The half of "the model thought wrong" that has a hard oracle.
 *
 * Disagreement between readings cannot find a belief every reading shares — the model being
 * confidently wrong about what the code does. The code itself can: state the lines you are
 * relying on, and the harness looks them up. A string search, not a judgement, so there is
 * nothing to talk out of it.
 */

let root: string
let libRoot: string
const roots: string[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-premises-'))
  libRoot = mkdtempSync(join(tmpdir(), 'pc-premises-lib-'))
  roots.push(root, libRoot)
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(
    join(root, 'src', 'invoice.ts'),
    'export class InvoiceService {\n' +
    '  format(n: number): string {\n' +
    '    return `INV-${String(n).padStart(6, "0")}`\n' +
    '  }\n' +
    '}\n',
    'utf8',
  )
  writeFileSync(join(libRoot, 'engine.ts'), 'export const version = 1\n', 'utf8')
})

let stop: (() => Promise<void>) | undefined
afterEach(async () => {
  await stop?.()
  stop = undefined
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true })
})

const premise = (file: string, quote: string) => ({ file, quote, why: 'the change relies on it' })

test('a quote that is really in the file passes', () => {
  const ws = new Workspace(root)
  const check = verifyPremises([premise('src/invoice.ts', 'padStart(6, "0")')], ws)
  expect(check.verified).toHaveLength(1)
  expect(check.unverified).toEqual([])
})

test('reindented and rewrapped is still the same belief', () => {
  // The model pulls a line out of a nested block and rewraps it to fit its answer. Calling
  // that a false premise would make the check cry wolf until somebody switched it off.
  const ws = new Workspace(root)
  const check = verifyPremises([
    premise('src/invoice.ts', 'format(n: number): string {\nreturn `INV-${String(n).padStart(6, "0")}`\n}'),
  ], ws)
  expect(check.unverified).toEqual([])
})

test('a changed identifier is NOT the same belief, and is caught', () => {
  // The whole point. Everything that carries meaning is compared exactly, so a remembered
  // argument name or a flipped operator fails to match — which is the hallucinated-API case.
  const ws = new Workspace(root)
  const check = verifyPremises([premise('src/invoice.ts', 'format(value: number): string')], ws)
  expect(check.verified).toEqual([])
  expect(check.unverified[0]?.problem).toContain('not in that file')
  // And it says the formatting is not the reason, or the model spends its next turn
  // re-indenting the quote instead of re-reading the code.
  expect(check.unverified[0]?.problem).toContain('indentation')
})

test('a method the model invented outright is caught', () => {
  const ws = new Workspace(root)
  const check = verifyPremises([premise('src/invoice.ts', 'validateInvoiceNumber(n: number): void')], ws)
  expect(check.unverified).toHaveLength(1)
})

test('an unreadable path is reported as a PATH problem, not as a false belief', () => {
  // Different failures mean different things to the model, and told the wrong one it fixes
  // the wrong thing: a naming mistake sends it re-reading code that was fine.
  const ws = new Workspace(root)
  const check = verifyPremises([premise('src/nope.ts', 'anything at all')], ws)
  expect(check.unverified[0]?.problem).toContain('could not be read')
  expect(check.unverified[0]?.problem).toContain('folder prefix')
})

test('a file in an ATTACHED folder resolves through the workspace, not through join()', () => {
  // The bug this repeats deliberately: project notes spent their whole life refusing every
  // note because they used join(primaryRoot, path), which names nothing in a multi-folder
  // workspace. Anything that turns a model path into a disk path must go through Workspace.
  const ws = new Workspace([
    { name: 'app', root, access: 'write', primary: true },
    { name: 'lib', root: libRoot, access: 'write', primary: false },
  ])
  expect(verifyPremises([premise('lib/engine.ts', 'export const version = 1')], ws).verified).toHaveLength(1)
  expect(verifyPremises([premise('app/src/invoice.ts', 'padStart(6, "0")')], ws).verified).toHaveLength(1)
})

test('whitespace is folded and nothing else is', () => {
  expect(normaliseCode('  a  b\n\tc  ')).toBe('a b c')
  expect(normaliseCode('a(b, c)')).toBe('a(b, c)')
})

test('a quote too short to mean anything is dropped before it can pass', () => {
  // Two characters match half of any file, so a premise built on them proves nothing.
  const parsed = parsePremises(JSON.stringify({
    premises: [
      { file: 'a.ts', quote: 'n)', why: 'x' },
      { file: 'src/invoice.ts', quote: 'padStart(6, "0")', why: 'padding' },
    ],
  }))
  expect(parsed).toHaveLength(1)
  expect(parsed?.[0]?.quote).toBe('padStart(6, "0")')
})

test('the failure message names what DID check out, so it does not read as "all wrong"', () => {
  // A message that sounds like everything is wrong sends the model rewriting code that was
  // fine — the same reason the verify runner words its own failure carefully.
  const text = premiseFailureMessage({
    verified: [premise('src/invoice.ts', 'padStart(6, "0")'), premise('src/invoice.ts', 'class InvoiceService')],
    unverified: [{ premise: premise('src/invoice.ts', 'validate(n)'), problem: 'those lines are not in that file' }],
  })
  expect(text).toContain('2 of your other assumptions did check out')
  expect(text).toContain('validate(n)')
  expect(text.startsWith('Not run:')).toBe(true)
  // The instruction is narrow: go and look, then carry on. Not "start over".
  expect(text).toContain('Read those places again')
})

test('the model is asked for the lines, and told they will be looked up', async () => {
  let asked = ''
  const fake = await startFakeServer((body: any) => {
    asked = String(body.messages[body.messages.length - 1].content)
    return {
      choices: [{
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          // The gate now forces its shape with `response_format`, so the answer arrives as
          // JSON content instead of a tool call -- see `forced-json.ts`.
          content: JSON.stringify({
            premises: [{ file: 'src/invoice.ts', quote: 'padStart(6, "0")', why: 'padding' }],
          }),
        },
      }],
    }
  })
  stop = fake.close
  const client = new LlamaClient({ baseUrl: fake.url, model: 'test' })
  const premises = await statePremises(client, [{ role: 'user', content: 'earlier' }])
  expect(premises).toHaveLength(1)
  // Saying the quotes are checked is not decoration: it is the one instruction that changes
  // what the model produces, because copying and remembering cost it the same otherwise.
  expect(asked).toContain('look them up')
  // The shape is forced by `response_format` now, so the prompt names no tool -- what it
  // must still say is that the lines will be looked up, which is the whole deterrent.
  expect(asked).toContain('JSON only')
})

test('a refusal to answer costs the check, never the turn', async () => {
  const fake = await startFakeServer(() => ({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'I would rather not' } }],
  }))
  stop = fake.close
  const client = new LlamaClient({ baseUrl: fake.url, model: 'test' })
  expect(await statePremises(client, [])).toBeNull()
})

test('lines quoted from separate places still count, as long as every line is real', () => {
  // A live failure that was NOT a false belief: asked for what it was going by, the model
  // returned three real lines from three parts of the file with everything between them
  // elided, joined into one quote. Refusing that is how a check like this earns a reputation
  // for crying wolf and gets switched off.
  const ws = new Workspace(root)
  const check = verifyPremises([premise(
    'src/invoice.ts',
    'export class InvoiceService {\nformat(n: number): string {\nreturn `INV-${String(n).padStart(6, "0")}`',
  )], ws)
  expect(check.verified).toHaveLength(1)
})

test('but one invented line among real ones still fails the whole premise', () => {
  // The property the looser pass must not give away. Adjacency was never load-bearing; the
  // existence of every line is.
  const ws = new Workspace(root)
  const check = verifyPremises([premise(
    'src/invoice.ts',
    'export class InvoiceService {\nvalidateBeforeFormatting(n: number): void {',
  )], ws)
  expect(check.unverified).toHaveLength(1)
})

test('a lone brace proves nothing and cannot carry a premise on its own', () => {
  const ws = new Workspace(root)
  expect(quoteIsInFile('}\n}\n})', 'anything at all')).toBe(false)
  // And it is ignored rather than failing a premise that also carries real evidence.
  expect(verifyPremises([premise('src/invoice.ts', 'format(n: number): string {\n}')], ws).verified)
    .toHaveLength(1)
})

test('a comment cannot stand as evidence for code', () => {
  // The hole this closes: the check was a substring search over the whole file, so a
  // commented-out old implementation — or a TODO naming a method somebody meant to add —
  // confirmed a premise about a method that does not exist. That is the exact failure the
  // premise check exists to catch, passing.
  const ws = new Workspace(root)
  writeFileSync(
    join(root, 'src', 'invoice.ts'),
    'export class InvoiceService {\n' +
    '  // TODO: add validateInvoiceNumber(n: number): void\n' +
    '  /** Callers rely on ensureSequential() being applied upstream. */\n' +
    '  format(n: number): string { return String(n) }\n' +
    '}\n',
    'utf8',
  )
  const check = verifyPremises([
    premise('src/invoice.ts', 'validateInvoiceNumber(n: number): void'),
    premise('src/invoice.ts', 'ensureSequential()'),
  ], ws)
  expect(check.verified).toEqual([])
  expect(check.unverified).toHaveLength(2)
  // And it says WHICH kind of failure, because re-quoting another comment will not help.
  for (const u of check.unverified) expect(u.problem).toContain('only in a COMMENT')
})

test('code that really is code still verifies, comments and all', () => {
  const ws = new Workspace(root)
  expect(verifyPremises([premise('src/invoice.ts', 'padStart(6, "0")')], ws).verified).toHaveLength(1)
})

test('the evidence floor applies to the strict pass too, not only the loose one', () => {
  // A quote of `})` is a substring of nearly every file. The floor used to guard only the
  // line-by-line pass, and the strict pass ran first — so the guarantee this project wrote a
  // test for did not actually hold on the path that mattered.
  expect(quoteIsInFile('})', 'const f = (a) => ({})')).toBe(false)
  expect(quoteIsInFile('}', 'anything with a brace }')).toBe(false)
})

test('a quote that is mostly short scraps is not evidence', () => {
  // The loose pass drops lines under the floor rather than checking them, so an invented
  // seven-character line used to be skipped while its neighbours carried the premise.
  const content = 'if (ready) { doTheThing() } else { bail() }'
  expect(quoteIsInFile('if (ready) {\nnope()\n}\n}\n}', content)).toBe(false)
})

/**
 * A quote that spans a comment line.
 *
 * The file was comment-stripped before matching and the quote was not, so every comment line
 * inside an otherwise-genuine quote became required evidence that could not possibly be
 * found — and the failure was reported as "those lines are only in a COMMENT there", the one
 * message that does not describe what happened. The whole batched step then halted and threw
 * away every queued edit. In a codebase this comment-dense, that is most multi-line quotes.
 */
const COMMENTED = 'export class InvoiceService {\n' +
  '  // Allocates the next number for the year. Callers must hold the row lock.\n' +
  '  async allocate(year: number): Promise<number> {\n' +
  '    const row = await db.query("select last from counters where year = $1", [year])\n' +
  '    return (row?.last ?? 0) + 1\n' +
  '  }\n' +
  '}\n'

test('a real quote spanning a comment line verifies, instead of being called a comment', () => {
  writeFileSync(join(root, 'src', 'alloc.ts'), COMMENTED, 'utf8')
  const ws = new Workspace(root)
  const quote =
    '  // Allocates the next number for the year. Callers must hold the row lock.\n' +
    '  async allocate(year: number): Promise<number> {\n' +
    '    const row = await db.query("select last from counters where year = $1", [year])\n' +
    '    return (row?.last ?? 0) + 1\n'

  const check = verifyPremises([premise('src/alloc.ts', quote)], ws)

  expect(check.unverified).toEqual([])
  expect(check.verified).toHaveLength(1)
})

test('a quote that is ONLY a comment is still named as one', () => {
  // The case that branch was written for, and it has to keep working: a note about what
  // something does is not evidence that it does it.
  writeFileSync(join(root, 'src', 'alloc.ts'), COMMENTED, 'utf8')
  const ws = new Workspace(root)
  const check = verifyPremises(
    [premise('src/alloc.ts', '  // Allocates the next number for the year. Callers must hold the row lock.')],
    ws,
  )

  expect(check.verified).toEqual([])
  expect(check.unverified[0]!.problem).toContain('COMMENT')
})

test('an invented CODE line inside a real quote is still caught', () => {
  // Stripping comments from the quote removes comment lines from the requirement. It must
  // not remove code lines, or the check has been loosened into uselessness.
  writeFileSync(join(root, 'src', 'alloc.ts'), COMMENTED, 'utf8')
  const ws = new Workspace(root)
  const quote =
    '  // Allocates the next number for the year. Callers must hold the row lock.\n' +
    '  async allocate(year: number): Promise<number> {\n' +
    '    const row = await db.query("select last from counters where year = $1 FOR UPDATE", [year])\n'

  const check = verifyPremises([premise('src/alloc.ts', quote)], ws)

  expect(check.verified).toEqual([])
  expect(check.unverified[0]!.problem).toContain('not in that file')
})
