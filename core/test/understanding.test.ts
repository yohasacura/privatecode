import { afterEach, describe, expect, test } from 'vitest'
import { alignReadings } from '../src/session/contract.js'
import {
  buildQuestion, compareReadings, foldAnswer, foldAnswerWithModel, readThroughLenses, type Reading,
  fromGroups, parseGroups, NONE_OF_THESE,
} from '../src/session/understanding.js'
import { LlamaClient } from '../src/llama/client.js'
import { startFakeServer } from './fake-server.js'

/**
 * The check that asks "did I understand you?" — and, more importantly, the machinery that
 * makes it IMPOSSIBLE for that question to be invented.
 *
 * The feature it replaces asked the model what it found unclear, and a small model is a poor
 * judge of what it does not know, so it produced questions about nothing. Here a question can
 * only exist where two of the model's own readings of the same request actually differed, and
 * the question's text IS one of those readings. These tests are mostly about that property.
 */

let stop: (() => Promise<void>) | undefined
afterEach(async () => { await stop?.(); stop = undefined })

const reading = (lens: Reading['lens'], ...does: string[]): Reading => ({ lens, does })

test('two readings of the same thing count as one, however the words fall', () => {
  // The whole comparison rests on this: a model restates its own line differently every time,
  // and counting those as disagreement would ask about everything.
  expect(alignReadings('The invoice number keeps its padding', 'the invoice number keeps its padding.')).toBe(true)
  expect(alignReadings('Criterion: the invoice number keeps its padding', 'the invoice number keeps its padding')).toBe(true)
  expect(alignReadings('act numbers come from a row-locked counter', 'Act numbers come from a row locked counter')).toBe(true)
})

test('and two different things stay different, even when they share words', () => {
  expect(alignReadings('invoice numbers keep their padding', 'act numbers keep their padding')).toBe(false)
  expect(alignReadings('validate the input', 'validate the output')).toBe(false)
  // The rule the audit's own matcher does not need and this one does: a short line is a
  // subset of half of everything, so containment alone must not merge them.
  expect(alignReadings('the counter', 'the counter is row-locked, gap-free and per-year')).toBe(false)
})

test('what every reading saw is shared; what only some saw is contested', () => {
  const u = compareReadings([
    reading('literal', 'rename the status column to state', 'update the two call sites'),
    reading('colleague', 'rename the status column to state', 'update the two call sites', 'add a migration for the rename'),
    reading('skeptic', 'rename the status column to state', 'update the two call sites'),
  ])
  expect(u?.shared).toEqual(['rename the status column to state', 'update the two call sites'])
  expect(u?.contested).toEqual(['add a migration for the rename'])
})

test('the most-agreed contested point is asked first', () => {
  // Two readings seeing something is likelier to be real work than one the skeptic imagined,
  // and only three questions are ever asked.
  const u = compareReadings([
    reading('literal', 'shared line about the thing'),
    reading('colleague', 'shared line about the thing', 'seen by two of them', 'only the colleague saw this'),
    reading('skeptic', 'shared line about the thing', 'seen by two of them'),
  ])
  expect(u?.contested).toEqual(['seen by two of them', 'only the colleague saw this'])
})

test('one reading is not a comparison, and says so rather than guessing', () => {
  expect(compareReadings([reading('literal', 'do the thing properly')])).toBeNull()
  expect(compareReadings([])).toBeNull()
})

test('nothing contested asks nothing — the common case, and the right silence', () => {
  const u = compareReadings([
    reading('literal', 'rename the status column to state'),
    reading('colleague', 'rename the status column to state'),
  ])
  expect(u?.contested).toEqual([])
  expect(buildQuestion(u!)).toBeNull()
})

test('the question states what was agreed and asks only about the rest', () => {
  const q = buildQuestion({
    shared: ['rename the status column to state'],
    contested: ['add a migration for the rename'],
  })
  // Stating the agreed half is how a misreading nobody flagged still gets caught: it is the
  // one place a person sees what is ABOUT to happen while it is still free to change.
  expect(q?.question).toContain('rename the status column to state')
  expect(q?.question).toContain('about to do')
  // The contested readings, plus the way to decline all of them — see NONE_OF_THESE.
  expect(q?.options).toEqual(['add a migration for the rename', NONE_OF_THESE])
  expect(q?.multiSelect).toBe(true)
  // And it says what silence means, because an unpicked option is an answer too.
  expect(q?.question).toContain('will not do')
})

test('a picked line becomes a criterion; an unpicked one is only reported back', () => {
  const u = {
    shared: ['rename the column'],
    contested: ['add a migration for the rename', 'update the API docs'],
  }
  const folded = foldAnswer(u, 'add a migration for the rename')
  expect(folded.criteria).toEqual(['add a migration for the rename'])
  // Reported back as a fact, never as a prohibition. An unticked box is a shrug, and these
  // options are readings of the REQUEST — so a contested line is often the goal restated.
  // Live, on a task about gap-free invoice numbers, the constraint version wrote itself
  // "Do not: Concurrent requests no longer produce duplicate invoice numbers", promoted it
  // into the contract, and carried it into message 0 at every compaction.
  expect(folded.notPicked).toEqual(['update the API docs'])
  expect(JSON.stringify(folded)).not.toContain('Do not')
})

test('a multi-select answer is split the way the host joins it', () => {
  const u = { shared: [], contested: ['add a migration for the rename', 'update the API docs'] }
  const folded = foldAnswer(u, 'add a migration for the rename; update the API docs')
  expect(folded.criteria).toHaveLength(2)
  expect(folded.notPicked).toEqual([])
})

test('words the person typed themselves outrank every reading and are kept verbatim', () => {
  const u = { shared: [], contested: ['add a migration for the rename'] }
  const folded = foldAnswer(u, 'neither — just change the column and leave everything else')
  expect(folded.criteria).toEqual(['neither — just change the column and leave everything else'])
  expect(folded.notPicked).toEqual(['add a migration for the rename'])
})

test('the three lenses are three DIFFERENT questions, not three samples of one', async () => {
  // The design decision this guards. Three identical prompts at this server's tuned
  // temperature measure sampling noise mixed with real ambiguity and cannot separate them;
  // three deliberate lenses put the disagreement where the ambiguity is.
  const asks: string[] = []
  const fake = await startFakeServer((body: any) => {
    const last = body.messages[body.messages.length - 1]
    asks.push(String(last.content))
    return {
      choices: [{
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: JSON.stringify({ does: ['rename the status column to state'] }),
        },
      }],
    }
  })
  stop = fake.close
  const client = new LlamaClient({ baseUrl: fake.url, model: 'test' })
  const u = await readThroughLenses(client, [{ role: 'user', content: 'earlier' }], 'rename status to state')

  // Three readings, then the grouping pass over what they produced. The readings are the
  // asks that quote the request back; the grouping pass never does.
  const lensAsks = asks.filter((a) => a.includes('before you write anything'))
  expect(lensAsks).toHaveLength(3)
  expect(new Set(lensAsks).size).toBe(3)
  // Every one of them carries the user's ORIGINAL words, never a distillation of them: a
  // summary is where the misreading would already have happened.
  for (const ask of lensAsks) expect(ask).toContain('rename status to state')
  // Three readings that agreed: nothing to ask.
  expect(u?.contested).toEqual([])
})

test('a lens that fails costs resolution, not the turn', async () => {
  let call = 0
  const fake = await startFakeServer(() => {
    call++
    if (call === 2) return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'no thanks' } }] }
    return {
      choices: [{
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: JSON.stringify({ does: ['rename the status column to state', `extra line number ${call}`] }),
        },
      }],
    }
  })
  stop = fake.close
  const client = new LlamaClient({ baseUrl: fake.url, model: 'test' })
  const u = await readThroughLenses(client, [], 'rename status to state')
  // Two readings still compare. The line they share is shared; the ones they do not are not.
  expect(u?.shared).toEqual(['rename the status column to state'])
  expect(u?.contested).toHaveLength(2)
})

test('lines too short to carry meaning are dropped rather than asked about', async () => {
  const fake = await startFakeServer(() => ({
    choices: [{
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: JSON.stringify({ does: ['fix it', 'the bug', 'rename the status column to state'] }),
      },
    }],
  }))
  stop = fake.close
  const client = new LlamaClient({ baseUrl: fake.url, model: 'test' })
  const u = await readThroughLenses(client, [], 'rename status to state')
  expect(u?.shared).toEqual(['rename the status column to state'])
  expect(u?.contested).toEqual([])
})

const line = (lens: Reading['lens'], ...does: string[]): Reading => ({ lens, does })

test('the grouping answer is numbers only, so nothing can be smuggled in', () => {
  // Provenance is the harness's job and judgement is the model's. A number that is out of
  // range, repeated, or not a number at all buys nothing.
  const groups = parseGroups(JSON.stringify({
    groups: [[1, 2], [2, 9, 'three'], [{ nope: true }], [3]],
  }), 4)
  expect(groups).toEqual([[0, 1], [2], [3]])
})

test('a line the grouping forgot becomes its own group, never a deleted one', () => {
  // The worst a bad grouping may do is ask about something that needed no asking. It must
  // never be able to make a contested point vanish.
  expect(parseGroups(JSON.stringify({ groups: [[1]] }), 3)).toEqual([[0], [1], [2]])
})

test('the skeptic ADDS a reading and can never veto the agreed one', () => {
  // The structural bug the first version had: the skeptic is under orders to say something
  // different, so a rule that waits for its agreement waits forever, and a request with
  // nothing ambiguous about it came back with an empty "shared" and three questions.
  const readings = [
    line('literal', 'rename Format to FormatNumber'),
    line('colleague', 'Format is renamed to FormatNumber'),
    line('skeptic', 'the controller formats numbers inline instead'),
  ]
  // Lines 1 and 2 are one thing; line 3 stands alone.
  const u = fromGroups(readings, [[0, 1], [2]])
  expect(u.shared).toEqual(['rename Format to FormatNumber'])
  expect(u.contested).toEqual(['the controller formats numbers inline instead'])
})

test('a point the colleague saw is asked before one only the skeptic imagined', () => {
  const readings = [
    line('literal', 'shared thing'),
    line('colleague', 'shared thing', 'also update the docs'),
    line('skeptic', 'maybe they meant the other table'),
  ]
  const u = fromGroups(readings, [[0, 1], [2], [3]])
  expect(u.contested).toEqual(['also update the docs', 'maybe they meant the other table'])
})

test('at most one skeptic-only point reaches the card', () => {
  // Asked for three it stops widening the request and starts inverting it.
  const readings = [
    line('literal', 'shared thing'),
    line('colleague', 'shared thing'),
    line('skeptic', 'other reading one', 'other reading two', 'other reading three'),
  ]
  const u = fromGroups(readings, [[0, 1], [2], [3], [4]])
  expect(u.shared).toEqual(['shared thing'])
  expect(u.contested).toEqual(['other reading one'])
})

test('a group is shown by its shortest phrasing, which is the one without the padding', () => {
  const readings = [
    line('literal', 'invoice numbers never skip a value'),
    line('colleague', 'invoice numbers never skip a value (for example 1, 2, 3 and not 1, 3, 5)'),
  ]
  const u = fromGroups(readings, [[0, 1]])
  expect(u.shared).toEqual(['invoice numbers never skip a value'])
})

test('ticking one option does not adopt a near-identical one left unticked', () => {
  // `alignReadings` folds narrow/wide pairs together on purpose — it is what makes "keeps
  // its padding" and "the padding is kept" one line. That is right when comparing READINGS
  // and wrong when reading a person's ticks: `groupLines` is under explicit instructions to
  // keep such a pair in separate groups, so the question offers them as two choices, and
  // matching the answer loosely then adopted both. The user was told "they want these" about
  // scope they had just declined, and it was audited against from then on.
  const u = {
    shared: [],
    contested: [
      'the counter never hands out the same number twice',
      'the counter never hands out the same number twice within a year',
    ],
  }

  const folded = foldAnswer(u, 'the counter never hands out the same number twice')

  expect(folded.criteria).toEqual(['the counter never hands out the same number twice'])
  expect(folded.notPicked).toEqual(['the counter never hands out the same number twice within a year'])
})

test('and ticking both still adopts both', () => {
  const u = {
    shared: [],
    contested: ['rename the column', 'rename the column and its index'],
  }
  const folded = foldAnswer(u, 'rename the column; rename the column and its index')
  expect(folded.criteria).toEqual(['rename the column', 'rename the column and its index'])
  expect(folded.notPicked).toEqual([])
})

test('one surviving core reading is not agreement', () => {
  // The only arity guard upstream counts the whole array, skeptic included, so
  // [colleague, skeptic] gets here with one core lens — and "every core reading saw it"
  // was then satisfied by that single reading agreeing with itself. Every line of the
  // deliberately EXPANSIVE lens was stated back as settled, with nothing confirming it.
  const readings: Reading[] = [
    { lens: 'colleague', does: ['rename the column', 'also regenerate the client'] },
    { lens: 'skeptic', does: ['leave the column and add a view'] },
  ]
  const groups = [[0], [1], [2]]

  const u = fromGroups(readings, groups)

  expect(u.shared).toEqual([])
  expect(u.contested).toContain('rename the column')
})

test('two core readings that agree still produce a shared line', () => {
  const readings: Reading[] = [
    { lens: 'literal', does: ['rename the column'] },
    { lens: 'colleague', does: ['rename the column'] },
    { lens: 'skeptic', does: ['add a view instead'] },
  ]
  const u = fromGroups(readings, [[0, 1], [2]])
  expect(u.shared).toEqual(['rename the column'])
})

test('"none of these" is offered, because otherwise it cannot be said', () => {
  // The card is a multi-select whose Answer button stays disabled until something is ticked,
  // so a person who wanted NONE of the contested readings had two choices: tick something
  // they did not want, or leave the turn parked forever. Reproduced in the running app.
  const q = buildQuestion({ shared: ['rename the column'], contested: ['also drop the index', 'also update the docs'] })
  expect(q).not.toBeNull()
  expect(q!.options).toEqual(['also drop the index', 'also update the docs', NONE_OF_THESE])
})

test('and picking it adopts nothing, without becoming a criterion itself', () => {
  // It is the harness's own sentence. Without an explicit exclusion it sails through
  // foldAnswer's free-text branch and becomes a done-criterion reading "None of these...".
  const u = { shared: [], contested: ['also drop the index', 'also update the docs'] }
  const folded = foldAnswer(u, NONE_OF_THESE)
  expect(folded.criteria).toEqual([])
  expect(folded.notPicked).toEqual(['also drop the index', 'also update the docs'])
})

test('picking it alongside a real option still adopts the real one', () => {
  const u = { shared: [], contested: ['also drop the index', 'also update the docs'] }
  const folded = foldAnswer(u, `also drop the index; ${NONE_OF_THESE}`)
  expect(folded.criteria).toEqual(['also drop the index'])
  expect(folded.notPicked).toEqual(['also update the docs'])
})

/**
 * The answer folds INTO the contract, it does not pile on top of it.
 *
 * The options are readings of the same request the contract was distilled from, so a ticked
 * one is usually a paraphrase of something already in there. Watched live on a task about
 * slugs: seven distilled criteria, three ticks, ten criteria — items 8, 9 and 10 restating
 * 2, 4 and 5 in slightly shorter words. Each duplicate is audited on its own, gets its own
 * plan item, and rides into message 0 at every compaction.
 */
describe('folding an answer into criteria that already exist', () => {
  const CONTRACT = [
    'src/util/slug.js exports a slug() function',
    "slug('Hello World') returns 'hello-world' (no leading/trailing hyphen, only lowercase and hyphens)",
    "slug('  spaces  ') returns 'spaces' (trimmed, no leading/trailing hyphen)",
    'node src/util/slug.test.js exits with code 0',
  ]

  test('a tick that restates a criterion confirms it instead of duplicating it', () => {
    const u = {
      shared: [],
      contested: ["slug('Hello World') returns 'hello-world'", "slug('  spaces  ') returns 'spaces'"],
    }
    const folded = foldAnswer(u, u.contested.join('; '), CONTRACT)
    // Both were wanted -- that is what the person is told -- and the contract is unchanged.
    expect(folded.criteria).toHaveLength(2)
    expect(folded.nextCriteria).toEqual(CONTRACT)
  })

  test('a tick that says strictly more sharpens the criterion in place', () => {
    const u = { shared: [], contested: ['invoice numbers are gap-free even when a transaction rolls back'] }
    const folded = foldAnswer(u, u.contested[0]!, ['invoice numbers are gap-free'])
    expect(folded.nextCriteria).toEqual(['invoice numbers are gap-free even when a transaction rolls back'])
  })

  test('a tick that says less must never narrow what done means', () => {
    // The same rule the unpicked half already follows: a checkbox is not an instruction to
    // do less. Being wrong in this direction quietly drops scope the user never withdrew.
    const u = { shared: [], contested: ['invoice numbers are gap-free'] }
    const folded = foldAnswer(u, u.contested[0]!, ['invoice numbers are gap-free even when a transaction rolls back'])
    expect(folded.nextCriteria).toEqual(['invoice numbers are gap-free even when a transaction rolls back'])
  })

  test('a reading the contract does not already carry is still added', () => {
    const u = { shared: [], contested: ['concurrent requests never produce a duplicate number'] }
    const folded = foldAnswer(u, u.contested[0]!, ['invoice numbers are gap-free'])
    expect(folded.nextCriteria).toEqual([
      'invoice numbers are gap-free',
      'concurrent requests never produce a duplicate number',
    ])
  })

  test('two ticks that restate the SAME criterion both fold into it', () => {
    // Two lenses producing near-identical restatements is exactly what `groupLines`
    // sometimes fails to merge, so both reach the question and both can be ticked.
    const u = {
      shared: [],
      contested: ['invoice numbers never skip a value', 'numbers never skip a value'],
    }
    const folded = foldAnswer(u, u.contested.join('; '), ['invoice numbers never skip a value'])
    expect(folded.nextCriteria).toEqual(['invoice numbers never skip a value'])
  })

  test('a tick the matcher does NOT read as the same thing is left as its own criterion', () => {
    // The boundary, stated so the fold cannot quietly widen later: `alignReadings` is the
    // judge of "same thing", and where it says no, nothing is merged. Verified against it
    // rather than assumed -- an earlier version of this test asserted a merge the matcher
    // never claimed.
    const a = 'the counter never repeats a number'
    const b = 'the counter never hands out a number twice'
    expect(alignReadings(a, b)).toBe(false)
    const folded = foldAnswer({ shared: [], contested: [a, b] }, [a, b].join('; '), [a])
    expect(folded.nextCriteria).toEqual([a, b])
  })

  /**
   * The string comparison alone is not enough, and that was measured in the running app
   * rather than argued: a contract reading "no leading or trailing hyphens in the slug — e.g.
   * slug('---hello---') must not return '-hello-'" was answered with the tick "slug removes
   * leading and trailing hyphens", and `alignReadings` matched NONE of three such ticks
   * against ANY of eight criteria. 8 + 3 came out as 11.
   *
   * So the model is asked -- but the question matters. Reusing `groupLines`, which asks a
   * symmetric "which of these lines mean the same thing" of three readings of one request,
   * over-merged: "concurrent requests never produce a duplicate number" was grouped into
   * "invoice numbers are gap-free" and the tick would have been dropped. The shipped question
   * is asymmetric and is the one actually being decided -- does the contract ALREADY require
   * this -- and it is told to answer 0 when unsure.
   */
  describe('when the wording is different but the requirement is not', () => {
    /** Answers with one number per tick, the way the real gate does. */
    async function withAnswer(
      restates: number[],
      existing: string[],
      contested: string[],
    ): Promise<string[]> {
      const fake = await startFakeServer(() => ({
        choices: [{
          finish_reason: 'stop',
          message: { role: 'assistant', content: JSON.stringify({ restates }) },
        }],
      }))
      try {
        const folded = await foldAnswerWithModel(
          new LlamaClient({ baseUrl: fake.url, model: 'test' }),
          { shared: [], contested },
          contested.join('; '),
          existing,
        )
        return folded.nextCriteria
      } finally {
        await fake.close()
      }
    }

    const CONTRACT = [
      "slugs contain only lowercase letters, digits and single hyphens — e.g. slug('Hello, World!') must return 'hello-world'",
      "no leading or trailing hyphens in the slug — e.g. slug('---hello---') must not return '-hello-'",
    ]
    const TICKS = [
      'slug strips punctuation so only letters, digits and hyphens remain',
      'slug removes leading and trailing hyphens',
    ]

    test('a tick the string comparison cannot see is still folded in', async () => {
      // The premise, stated so this test cannot pass for the wrong reason.
      for (const tick of TICKS) {
        expect(CONTRACT.some((c) => alignReadings(c, tick))).toBe(false)
      }
      expect(await withAnswer([1, 2], CONTRACT, TICKS)).toEqual(CONTRACT)
    })

    test('0 means the contract does not already require it, and the tick is kept', async () => {
      const next = await withAnswer([0], ['invoice numbers are gap-free'], [
        'concurrent requests never produce a duplicate number',
      ])
      expect(next).toEqual([
        'invoice numbers are gap-free',
        'concurrent requests never produce a duplicate number',
      ])
    })

    test('an unusable answer keeps the tick rather than dropping it', async () => {
      // Out of range, the wrong type, a short array: every one reads as 0. A duplicate
      // criterion is noise; a ticked line that quietly leaves the contract is scope the user
      // asked for and will not get.
      for (const restates of [[99], [-1], [], ['1' as unknown as number]]) {
        const next = await withAnswer(restates, ['invoice numbers are gap-free'], [
          'concurrent requests never produce a duplicate number',
        ])
        expect(next).toHaveLength(2)
      }
    })

    test('a tick that says strictly more still sharpens, whatever the model answered', async () => {
      const next = await withAnswer([1], ['invoice numbers are gap-free'], [
        'invoice numbers are gap-free even when a transaction rolls back',
      ])
      expect(next).toEqual(['invoice numbers are gap-free even when a transaction rolls back'])
    })

    test('a server that cannot answer falls back to the string comparison', async () => {
      const fake = await startFakeServer(() => { throw new Error('down') })
      try {
        const folded = await foldAnswerWithModel(
          new LlamaClient({ baseUrl: fake.url, model: 'test' }),
          { shared: [], contested: ['invoice numbers are gap-free'] },
          'invoice numbers are gap-free',
          ['invoice numbers are gap-free'],
        )
        // The lexical fold still merges this one -- it is byte-identical.
        expect(folded.nextCriteria).toEqual(['invoice numbers are gap-free'])
      } finally {
        await fake.close()
      }
    })
  })

  test('with no contract passed it behaves exactly as it always did', () => {
    // Every other caller and every older test relies on this: the fold is opt-in.
    const u = { shared: [], contested: ['add a migration for the rename'] }
    const folded = foldAnswer(u, 'add a migration for the rename')
    expect(folded.nextCriteria).toEqual(folded.criteria)
  })
})
