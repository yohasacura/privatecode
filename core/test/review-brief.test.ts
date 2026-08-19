import { afterEach, expect, test } from 'vitest'
import { buildReviewBrief, reviewVerdict, REVIEW_SYSTEM } from '../src/session/contract.js'
import { LlamaClient } from '../src/llama/client.js'
import { startFakeServer } from './fake-server.js'

/**
 * What the independent reader is given — and the two blindnesses it used to have by
 * construction rather than by accident.
 *
 * It saw the contract and the diff. So it judged the change against a DISTILLATION of the
 * request, which means a misreading that happened during that distillation was invisible to
 * it: the diff answers the contract, the contract is wrong, and the review says fine. And it
 * saw only the lines that moved, which is enough for an off-by-one and nothing at all for
 * "this calls the wrong helper" — the code a diff depends on is exactly the code a diff
 * does not show.
 */

let stop: (() => Promise<void>) | undefined
afterEach(async () => { await stop?.(); stop = undefined })

const contract = {
  goal: 'Invoice numbers are gap-free',
  criteria: ['numbers are allocated inside the transaction'],
  constraints: [],
}

test('the user\'s own words come first, and outrank the summary of them', () => {
  const brief = buildReviewBrief(contract, '--- a/x\n+++ b/x', 'make invoice numbers gap-free please')
  expect(brief).toContain('make invoice numbers gap-free please')
  // Order matters: the distillation is presented as somebody's summary, so a reviewer that
  // notices the two disagree knows which one is the request.
  expect(brief.indexOf('make invoice numbers gap-free please')).toBeLessThan(brief.indexOf('TASK CONTRACT'))
  expect(brief).toContain('the words above win')
})

test('with no recorded request it is simply the contract, as before', () => {
  const brief = buildReviewBrief(contract, '--- a/x\n+++ b/x')
  expect(brief).not.toContain('the words above win')
  expect(brief).toContain('TASK CONTRACT')
  expect(brief).toContain('--- a/x')
})

test('a long diff is clipped, and says so rather than ending mid-hunk', () => {
  const brief = buildReviewBrief(contract, 'x'.repeat(200_000))
  expect(brief).toContain('diff clipped at')
})

test('the reader is told to look AROUND the change, which is where the defects are', () => {
  // The instruction that pays for the read tools. Without it the model treats the diff as
  // the whole world, which is what it had been doing because it was.
  expect(REVIEW_SYSTEM).toContain('open files')
  expect(REVIEW_SYSTEM).toContain('AROUND')
  // And the guard against a reviewer that invents work to look useful.
  expect(REVIEW_SYSTEM).toContain('empty list is a fine')
})

test('the verdict is forced over whatever the reader looked at', async () => {
  let seen: any
  const fake = await startFakeServer((body: any) => {
    seen = body
    return {
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          tool_calls: [{
            id: 'c1',
            type: 'function',
            function: {
              name: 'review_verdict',
              arguments: JSON.stringify({
                issues: [{ where: 'src/invoice.ts allocate()', what: 'the counter is read outside the transaction' }],
              }),
            },
          }],
        },
      }],
    }
  })
  stop = fake.close
  const client = new LlamaClient({ baseUrl: fake.url, model: 'test' })
  const issues = await reviewVerdict(client, [
    { role: 'user', content: 'the brief' },
    { role: 'assistant', content: 'I opened src/invoice.ts' },
  ])
  expect(issues).toEqual([{ where: 'src/invoice.ts allocate()', what: 'the counter is read outside the transaction' }])
  // Everything it looked at is still in front of it when it answers — the point of splitting
  // the looking from the verdict is that the verdict sees the looking.
  expect(seen.messages).toHaveLength(3)
  expect(String(seen.messages[1].content)).toContain('I opened src/invoice.ts')
  expect(seen.tool_choice).toBe('required')
})

test('a reader that answers in prose leaves the turn unreviewed, not broken', async () => {
  const fake = await startFakeServer(() => ({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'looks fine to me' } }],
  }))
  stop = fake.close
  const client = new LlamaClient({ baseUrl: fake.url, model: 'test' })
  expect(await reviewVerdict(client, [{ role: 'user', content: 'the brief' }])).toBeNull()
})
