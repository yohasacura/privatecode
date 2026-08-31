import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { sessionsTool } from '../src/tools/sessions.js'
import { readStoredSession } from '../src/host/session-read.js'
import { Workspace } from '../src/workspace.js'
import { VERIFY_FAILED_PREFIX } from '../src/verify/runner.js'
import { COMPACTION_ACK_TEXT, COMPACTION_BRIEFING_PREFIX } from '../src/session/compaction.js'
import type { ToolContext } from '../src/tools/types.js'

/**
 * Three named things you can do with the stored conversations.
 *
 * Written against a measured failure. `search_history` had a listing mode you entered by
 * OMITTING `query`, and asked "what did we do in all the past sessions" the live model
 * searched seven guessed words in a row — none of which could match, because the question
 * had no word in it — and then reported one past session where there were three. The mode
 * was in the description; the description was read and it did not route. So the mode is an
 * enum member, and a call that cannot work is refused with the alternative named.
 */

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-sessions-'))
  mkdirSync(join(root, '.privatecode', 'state', 'sessions'), { recursive: true })
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function write(id: string, title: string, day: string, lines: unknown[], mode = 'normal'): void {
  const dir = join(root, '.privatecode', 'state', 'sessions')
  writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
  writeFileSync(join(dir, `${id}.meta.json`), JSON.stringify({
    id, title, createdAt: `${day}T09:00:00.000Z`, updatedAt: `${day}T17:00:00.000Z`,
    workspaceRoot: root, mode,
  }, null, 2), 'utf8')
}

const person = (text: string): unknown => ({ role: 'user', content: text })
const model = (text: string): unknown => ({ role: 'assistant', content: text })
const callsTool = (name: string, args: unknown): unknown => ({
  role: 'assistant', content: '',
  tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }],
})
const toolResult = (text: string): unknown => ({ role: 'tool', tool_call_id: 'c1', content: text })

async function run(raw: unknown, sessionId?: string): Promise<string> {
  const v = sessionsTool.validate?.(raw)
  if (v === undefined) throw new Error('the tool lost its validator')
  if (!v.ok) return `REFUSED: ${v.error}`
  const ctx = {
    workspace: new Workspace(root),
    ...(sessionId !== undefined ? { sessionId } : {}),
  } as ToolContext
  return (await sessionsTool.execute(v.args, ctx)).content
}

describe('the actions are named, not implied', () => {
  test('every action is in the schema, so none of them is invisible', () => {
    const action = (sessionsTool.parameters as {
      properties: { action: { enum: string[] } }
    }).properties.action
    expect(action.enum).toEqual(['list', 'search', 'read'])
    expect((sessionsTool.parameters as { required: string[] }).required).toEqual(['action'])
  })

  test('search with no query is refused, and told to list instead', async () => {
    // The exact call the live model could not find its way out of.
    const out = await run({ action: 'search' })
    expect(out).toContain('REFUSED')
    expect(out).toContain('use action "list" instead')
  })

  test('read with no id is refused, and told where ids come from', async () => {
    expect(await run({ action: 'read' })).toContain('action "list" to get ids')
  })

  test('a query passed to a non-search action is refused, not dropped', async () => {
    // Silently ignoring it would answer a different question and look like it had answered
    // the one asked — the failure mode this whole tool exists to stop.
    expect(await run({ action: 'list', query: 'ledger' })).toContain('only applies to action')
  })
})

describe('list', () => {
  beforeEach(() => {
    write('a', 'wire up the ledger import', '2026-08-20', [person('wire up the ledger import')])
    write('b', 'make the cutover configurable', '2026-08-21', [person('cutover')])
    write('c', 'chase the flaky verify', '2026-08-21', [person('flaky')], 'autopilot')
  })

  test('no arguments at all answers "what have we worked on"', async () => {
    // Not "list needs dates", which is what the old description implied and what sent the
    // model back to guessing words.
    const out = await run({ action: 'list' })
    expect(out).toContain('wire up the ledger import')
    expect(out).toContain('chase the flaky verify')
  })

  test('it hands back ids, because read needs one', async () => {
    const out = await run({ action: 'list' })
    for (const id of ['a', 'b', 'c']) expect(out).toContain(`  ${id}  `)
    expect(out).toContain('action "read" with an id above')
  })

  test('dates select, days group, and a period reads forwards', async () => {
    const out = await run({ action: 'list', since: '2026-08-20', until: '2026-08-21' })
    expect(out).toContain('from 2026-08-20 to 2026-08-21')
    expect(out.indexOf('2026-08-20')).toBeLessThan(out.indexOf('2026-08-21'))
    expect(out).toContain('[autopilot]')
  })

  test('an empty period says how much history there is at all', async () => {
    const out = await run({ action: 'list', since: '2026-07-01', until: '2026-07-31' })
    expect(out).toContain('none')
    expect(out).toContain('3 conversations in this workspace overall')
  })
})

describe('read — the thing that did not exist', () => {
  beforeEach(() => {
    write('a', 'wire up the ledger import', '2026-08-20', [
      person('wire up the ledger import'),
      callsTool('read_file', { path: 'src/Posting.cs' }),
      toolResult('1\tnamespace Posting;\n2\tclass Engine {}'),
      model('The posting engine needs the cutover flag.'),
      { role: 'user', content: `${VERIFY_FAILED_PREFIX}\n\`dotnet build\` exited 1` },
      callsTool('edit_file', { path: 'src/Posting.cs', old: 'x', new: 'y' }),
      toolResult('edited'),
      model('Fixed and the build is green.'),
    ])
  })

  test('it returns what was said, and what was asked of the tools', async () => {
    const out = await run({ action: 'read', id: 'a' })
    expect(out).toContain('wire up the ledger import')
    expect(out).toContain('The posting engine needs the cutover flag')
    expect(out).toContain('→ read_file')
    expect(out).toContain('→ edit_file')
  })

  test('the harness is marked by which check spoke, not shown as the person', async () => {
    // The payoff from giving harness messages a kind: a build failure that drove the next
    // two turns is part of what happened, and reading it as something the person asked for
    // is how a session gets misremembered.
    const out = await run({ action: 'read', id: 'a' })
    expect(out).toContain('[verify]')
    expect(out).not.toMatch(/you\s+Automatic verification failed/)
  })

  test('tool OUTPUT is left out by default and available on request', async () => {
    expect(await run({ action: 'read', id: 'a' })).not.toContain('namespace Posting')
    expect(await run({ action: 'read', id: 'a', include_tool_results: true }))
      .toContain('namespace Posting')
  })

  test('an id nobody has says how many there are and where ids come from', async () => {
    const out = await run({ action: 'read', id: 'nope' })
    expect(out).toContain('No conversation here has that id')
    expect(out).toContain('action "list"')
  })
})

describe('one reader, so the diagnosis and a person cannot disagree', () => {
  test('a compaction\'s re-appended tail is not read twice', () => {
    // The same defect the doctor was bitten by: the swap appends the retained tail below
    // its marker, and it is already above it. A `read` that showed the last four messages
    // twice would tell somebody their session went in circles when it did not.
    const tail = [person('fix the build'), model('done')]
    write('a', 'fix the build', '2026-08-20', [
      { role: 'system', content: 'you are an agent' },
      person('start'),
      model('ok'),
      ...tail,
      // 5 messages so far; the tail starts at index 3, floor is 1, so dropped is 2.
      { __event: 'compaction', summary: 's', droppedMessages: 2, at: '2026-08-20T10:00:00.000Z' },
      { role: 'system', content: 'you are an agent' },
      { role: 'user', content: `${COMPACTION_BRIEFING_PREFIX}\n\nearlier` },
      { role: 'assistant', content: COMPACTION_ACK_TEXT },
      ...tail,
    ])
    const stored = readStoredSession(root, 'a')
    expect(stored.compactions).toBe(1)
    expect(stored.duplicatesSkipped).toBe(2)
    // "fix the build" was said once, and appears once.
    expect(stored.messages.filter((m) => m.content === 'fix the build')).toHaveLength(1)
  })

  test('a marker with no count says so rather than quietly doubling', () => {
    write('a', 't', '2026-08-20', [
      { role: 'system', content: 's' },
      person('one'),
      { __event: 'compaction', summary: 's', at: '2026-08-20T10:00:00.000Z' },
      person('one'),
    ])
    expect(readStoredSession(root, 'a').problems.join(' ')).toContain('appear twice')
  })

  test('a missing transcript is a session never used, not an error', () => {
    expect(readStoredSession(root, 'ghost').messages).toEqual([])
  })
})

test('a conversation is on the day the PERSON had, not the day UTC had', async () => {
  // Found on the owner's own history: a session worked on at 00:20 local was stored as
  // ...T21:20Z the previous day and listed under it, while its id — stamped in local time —
  // said otherwise. "What was I doing on the 29th" would have answered with the 28th's work,
  // and the id printed beside the date would have contradicted the heading.
  const local = new Date('2026-08-29T00:20:00')   // 00:20 in whatever zone this runs in
  write('night', 'the late one', '2026-01-01', [person('late night work')])
  writeFileSync(
    join(root, '.privatecode', 'state', 'sessions', 'night.meta.json'),
    JSON.stringify({
      id: 'night', title: 'the late one',
      createdAt: local.toISOString(), updatedAt: local.toISOString(),
      workspaceRoot: root, mode: 'normal',
    }, null, 2), 'utf8')

  // Asked for the 29th, it is there...
  expect(await run({ action: 'list', since: '2026-08-29', until: '2026-08-29' }))
    .toContain('the late one')
  // ...and asked for the 28th, it is not.
  expect(await run({ action: 'list', since: '2026-08-28', until: '2026-08-28' }))
    .not.toContain('the late one')
})
