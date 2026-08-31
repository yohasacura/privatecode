import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { searchHistoryTool } from '../src/tools/search-history.js'
import { Workspace } from '../src/workspace.js'
import type { ToolContext } from '../src/tools/types.js'

/**
 * "What was I working on last Tuesday."
 *
 * A search needs a word, and the whole point of asking about a DATE is that the word is what
 * you have forgotten. Until `query` became optional this tool could not answer it at all:
 * you had to guess a term that happened to appear, and a guess that missed returned "nothing
 * matches" — which reads as "nothing happened", the worst available wrong answer.
 */

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-hist-'))
  mkdirSync(join(root, '.privatecode', 'state', 'sessions'), { recursive: true })
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

/** One session on disk: the transcript the search path reads, and the meta the listing does. */
function session(
  id: string, title: string, day: string,
  messages: { role: string; content: string }[] = [{ role: 'user', content: title }],
  mode = 'normal',
): void {
  const dir = join(root, '.privatecode', 'state', 'sessions')
  writeFileSync(join(dir, `${id}.jsonl`),
    messages.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf8')
  writeFileSync(join(dir, `${id}.meta.json`), JSON.stringify({
    id, title, createdAt: `${day}T09:00:00.000Z`, updatedAt: `${day}T17:00:00.000Z`,
    workspaceRoot: root, mode,
  }, null, 2), 'utf8')
}

const ctx = (sessionId?: string): ToolContext => ({
  workspace: new Workspace(root),
  ...(sessionId !== undefined ? { sessionId } : {}),
} as ToolContext)

/** Runs the tool the way the registry does — through `validate`, so the schema is exercised. */
async function run(raw: unknown, sessionId?: string): Promise<string> {
  const v = searchHistoryTool.validate?.(raw)
  if (v === undefined) throw new Error('the tool lost its validator')
  if (!v.ok) return `REFUSED: ${v.error}`
  return (await searchHistoryTool.execute(v.args, ctx(sessionId))).content
}

describe('listing a period, with no query', () => {
  beforeEach(() => {
    session('a', 'wire up the ledger import', '2026-08-20')
    session('b', 'make the cutover date configurable', '2026-08-21')
    session('c', 'chase the flaky verify timeout', '2026-08-21', undefined, 'autopilot')
    session('d', 'something much later', '2026-09-02')
  })

  test('the dates alone select, and the days are what the answer is grouped by', async () => {
    const out = await run({ since: '2026-08-20', until: '2026-08-21' })
    expect(out).toContain('from 2026-08-20 to 2026-08-21')
    expect(out).toContain('2026-08-20')
    expect(out).toContain('2026-08-21')
    expect(out).toContain('wire up the ledger import')
    expect(out).toContain('make the cutover date configurable')
    expect(out).toContain('chase the flaky verify timeout')
    // Outside the period.
    expect(out).not.toContain('something much later')
  })

  test('a period reads forwards, because it is being asked as "what happened"', async () => {
    const out = await run({ since: '2026-08-20', until: '2026-08-21' })
    expect(out.indexOf('2026-08-20')).toBeLessThan(out.indexOf('2026-08-21'))
  })

  test('a mode that is not the ordinary one is worth a word', async () => {
    // "I ran that overnight" is most of what distinguishes one day's work from another's.
    expect(await run({ since: '2026-08-21', until: '2026-08-21' })).toContain('[autopilot]')
  })

  test('it says it did not look inside, because silence is not evidence', async () => {
    // The failure this guards: a listing read as a search turns "the word never came up in
    // these titles" into "the topic never came up", which is a stronger and false claim.
    const out = await run({ since: '2026-08-20', until: '2026-08-21' })
    expect(out).toContain('not their contents')
    expect(out).toContain('nothing was read')
  })

  test('an empty period says so, rather than returning nothing at all', async () => {
    const out = await run({ since: '2026-07-01', until: '2026-07-31' })
    expect(out).toContain('from 2026-07-01 to 2026-07-31')
    expect(out).toContain('none')
    // And it says how much history there IS: "nothing that week" and "no history at all"
    // are different answers, and a caller told only the first goes looking for a workspace
    // it is already in.
    expect(out).toContain('4 conversations in this workspace overall')
  })

  test('more than fits keeps the recent end and says what it dropped', async () => {
    for (let d = 1; d <= 9; d++) {
      session(`x${d}`, `day ${d} work`, `2026-10-0${d}`)
    }
    const out = await run({ since: '2026-10-01', until: '2026-10-09', limit: 3 })
    expect(out).toContain('day 9 work')
    expect(out).toContain('day 7 work')
    expect(out).not.toContain('day 6 work')
    expect(out).toContain('6 earlier conversations in that period not shown')
  })

  test('the conversation you are in is marked, so the answer is not confusing', async () => {
    expect(await run({ since: '2026-08-20' }, 'a')).toContain('this conversation')
  })
})

describe('the two answers stay apart', () => {
  beforeEach(() => {
    session('a', 'wire up the ledger import', '2026-08-20', [
      { role: 'user', content: 'wire up the ledger import' },
      { role: 'assistant', content: 'the posting engine needs the cutover flag' },
    ])
  })

  test('a query still searches inside, and returns passages', async () => {
    const out = await run({ query: 'cutover flag' })
    expect(out).toContain('cutover flag')
    expect(out).toContain('mention')
    // A search does NOT carry the listing's disclaimer — it did look inside.
    expect(out).not.toContain('nothing was read')
  })

  test('an EMPTY query is refused rather than quietly becoming a listing', async () => {
    // Absent means "list"; empty means the model meant to search and had nothing to search
    // for. Listing for the second would answer a question nobody asked and look like it had.
    const out = await run({ query: '   ' })
    expect(out.startsWith('REFUSED')).toBe(true)
    expect(out).toContain('or left out entirely')
  })

  test('a misspelled date is still refused in listing mode', async () => {
    // The reason it was always refused: a bad date compares as a plain string and silently
    // selects nothing — a wrong answer wearing the shape of a right one.
    expect(await run({ since: '20-08-2026' })).toContain('must be a date')
  })
})
