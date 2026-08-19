import { afterEach, expect, test } from 'vitest'
import { alignReadings } from '../src/session/contract.js'
import {
  buildQuestion, compareReadings, foldAnswer, readThroughLenses, type Reading,
  fromGroups, parseGroups,
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
  expect(q?.options).toEqual(['add a migration for the rename'])
  expect(q?.multiSelect).toBe(true)
  // And it says what silence means, because an unpicked option is an answer too.
  expect(q?.question).toContain('will not do')
})

test('a picked line becomes a criterion; an unpicked one becomes a constraint', () => {
  const u = {
    shared: ['rename the column'],
    contested: ['add a migration for the rename', 'update the API docs'],
  }
  const folded = foldAnswer(u, 'add a migration for the rename')
  expect(folded.criteria).toEqual(['add a migration for the rename'])
  // The half that is easy to drop and expensive to lose: "no, not that" is a decision made
  // once, and unrecorded it arrives again next turn with nothing to point at.
  expect(folded.constraints).toHaveLength(1)
  expect(folded.constraints[0]).toContain('update the API docs')
  expect(folded.constraints[0]).toContain('Do not')
})

test('a multi-select answer is split the way the host joins it', () => {
  const u = { shared: [], contested: ['add a migration for the rename', 'update the API docs'] }
  const folded = foldAnswer(u, 'add a migration for the rename; update the API docs')
  expect(folded.criteria).toHaveLength(2)
  expect(folded.constraints).toEqual([])
})

test('words the person typed themselves outrank every reading and are kept verbatim', () => {
  const u = { shared: [], contested: ['add a migration for the rename'] }
  const folded = foldAnswer(u, 'neither — just change the column and leave everything else')
  expect(folded.criteria).toEqual(['neither — just change the column and leave everything else'])
  expect(folded.constraints[0]).toContain('add a migration for the rename')
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
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          tool_calls: [{
            id: `c${asks.length}`,
            type: 'function',
            function: {
              name: 'record_reading',
              arguments: JSON.stringify({ does: ['rename the status column to state'] }),
            },
          }],
        },
      }],
    }
  })
  stop = fake.close
  const client = new LlamaClient({ baseUrl: fake.url, model: 'test' })
  const u = await readThroughLenses(client, [{ role: 'user', content: 'earlier' }], 'rename status to state')

  // Three readings, then the grouping pass over what they produced.
  const lensAsks = asks.filter((a) => a.includes('record_reading'))
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
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          tool_calls: [{
            id: `c${call}`,
            type: 'function',
            function: {
              name: 'record_reading',
              arguments: JSON.stringify({ does: ['rename the status column to state', `extra line number ${call}`] }),
            },
          }],
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
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        tool_calls: [{
          id: 'c1',
          type: 'function',
          function: {
            name: 'record_reading',
            arguments: JSON.stringify({ does: ['fix it', 'the bug', 'rename the status column to state'] }),
          },
        }],
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
