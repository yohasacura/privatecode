import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { classify, diagnose, renderDiagnosis } from '../src/doctor/diagnose.js'
import type { SessionMeta } from '../src/session/store.js'

/**
 * The self-diagnosis, and the property the whole feature rests on.
 *
 * It exists so that work nobody can show us can still teach us something: real sessions on a
 * confidential codebase, whose logs cannot leave the machine, measured where they are so
 * that only counts travel. Every one of those words is doing work — if the output can carry
 * a path, a command or a sentence of somebody's conversation, the feature is not merely
 * less useful, it is a liability, because it will be sent by someone who was told it was
 * safe.
 *
 * So the leak tests come first, and they are written as a hostile transcript: every field
 * that could carry something is filled with a marker string, and the assertion is that not
 * one of them appears in the rendered report.
 */

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-doctor-'))
  mkdirSync(join(root, '.privatecode', 'state', 'sessions'), { recursive: true })
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

interface Line {
  role: string
  content?: string
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

function session(
  id: string, lines: Line[], meta: Partial<SessionMeta> = {}, outcomes: { id: string; ok: boolean }[] = [],
): SessionMeta {
  const dir = join(root, '.privatecode', 'state', 'sessions')
  writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
  if (outcomes.length > 0) {
    writeFileSync(join(dir, `${id}.ui.jsonl`), outcomes.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8')
  }
  return {
    id,
    title: 'a title',
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    workspaceRoot: root,
    mode: 'normal',
    ...meta,
  }
}

describe('nothing from the transcript can reach the report', () => {
  test('a transcript full of secrets renders a report with none of them in it', () => {
    // Every field that carries text, carrying a marker. If any of these shows up, the
    // feature is unsafe to use for the thing it was built for.
    const SECRETS = [
      'SECRET-USER-PROSE',
      'SECRET-ASSISTANT-PROSE',
      'SECRET-TOOL-OUTPUT',
      'SECRET-ARGUMENT-PATH',
      'SECRET-SESSION-TITLE',
      'SECRET-SYSTEM-PROMPT',
    ]
    // Repeated, so the PATTERN renderer runs too — the prose half is where the temptation
    // to quote the offending value is strongest, and a leak test that only exercised the
    // table would miss exactly the code most likely to leak.
    const lines: Line[] = [
      { role: 'system', content: 'workspace at C:/SECRET-SYSTEM-PROMPT' },
      { role: 'user', content: 'please fix SECRET-USER-PROSE in the billing module' },
    ]
    const outcomes: { id: string; ok: boolean }[] = []
    for (let i = 0; i < 3; i++) {
      lines.push(
        {
          role: 'assistant',
          content: 'I will look at SECRET-ASSISTANT-PROSE',
          tool_calls: [{
            id: `c${i}`, type: 'function',
            function: { name: 'read_file', arguments: `{"path":"src/SECRET-ARGUMENT-PATH${i}.ts"}` },
          }],
        },
        { role: 'tool', tool_call_id: `c${i}`, content: `File not found: src/SECRET-TOOL-OUTPUT${i}.ts` },
      )
      outcomes.push({ id: `c${i}`, ok: false })
    }
    const metas = [session('s1', lines, { title: 'SECRET-SESSION-TITLE' }, outcomes)]

    const report = renderDiagnosis(diagnose(root, metas))

    for (const secret of SECRETS) expect(report).not.toContain(secret)
    // And the workspace path, which sits in the meta right beside everything else read.
    expect(report).not.toContain(root)
  })

  test('what it DOES carry is the tool name and the failure category', () => {
    const metas = [session('s1', [
      {
        role: 'assistant',
        tool_calls: [{
          id: 'c1', type: 'function',
          function: { name: 'read_file', arguments: '{"path":"secret.ts"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'File not found: secret.ts' },
    ], {}, [{ id: 'c1', ok: false }])]

    const report = renderDiagnosis(diagnose(root, metas))

    // The tool name survives because it is SHAPED like one; see the shape-check tests
    // below for what happens to a name that is not.
    expect(report).toContain('read_file')
    // The category is one of twelve literals declared in the module.
    expect(report).toContain('not-found')
    expect(report).not.toContain('secret.ts')
  })

  test('the report says outright that it is safe to send, because that is why it exists', () => {
    const metas = [session('s1', [{ role: 'user', content: 'hello' }])]
    const report = renderDiagnosis(diagnose(root, metas))
    // Somebody about to paste this into an email should not have to reason it out.
    expect(report).toContain('safe to send')
  })
})

describe('the counting itself', () => {
  test('counts calls, failures and exact repeats', () => {
    const call = (id: string, args: string) => ({
      role: 'assistant',
      tool_calls: [{ id, type: 'function' as const, function: { name: 'read_file', arguments: args } }],
    })
    const metas = [session('s1', [
      call('c1', '{"path":"a.ts"}'),
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
      // Byte-identical to c1: this is the waste the read-dedup memory was built for, and
      // making it a number is most of why this tool exists.
      call('c2', '{"path":"a.ts"}'),
      { role: 'tool', tool_call_id: 'c2', content: 'ok' },
      call('c3', '{"path":"b.ts"}'),
      { role: 'tool', tool_call_id: 'c3', content: 'File not found: b.ts' },
    ], {}, [{ id: 'c1', ok: true }, { id: 'c2', ok: true }, { id: 'c3', ok: false }])]

    const d = diagnose(root, metas)

    expect(d.toolCalls).toBe(3)
    expect(d.toolFailures).toBe(1)
    const readFile = d.tools.find((t) => t.name === 'read_file')
    expect(readFile?.calls).toBe(3)
    expect(readFile?.repeats).toBe(1)
    expect(readFile?.failures['not-found']).toBe(1)
  })

  test('a session opened and never used is counted as such', () => {
    // A pile of these is its own finding — it says the app is being opened and abandoned.
    const metas = [
      session('s1', [{ role: 'system', content: 'prompt' }]),
      session('s2', [{ role: 'system', content: 'prompt' }, { role: 'user', content: 'hi' }]),
    ]
    const d = diagnose(root, metas)
    expect(d.sessions).toBe(2)
    expect(d.emptySessions).toBe(1)
  })

  test('app versions are grouped, and their absence is not faked', () => {
    const metas = [
      session('s1', [{ role: 'user', content: 'a' }], { appVersion: '0.1.5' } as Partial<SessionMeta>),
      session('s2', [{ role: 'user', content: 'b' }], { appVersion: '0.1.5' } as Partial<SessionMeta>),
      session('s3', [{ role: 'user', content: 'c' }]),
    ]
    const d = diagnose(root, metas)
    expect(d.versions['0.1.5']).toBe(2)
    // The third recorded none, and nothing invents one for it — a diagnosis that guessed
    // the version would answer "did it get better after 0.1.5" with fiction.
    expect(Object.keys(d.versions)).toEqual(['0.1.5'])
  })

  test('a missing outcomes file is reported, not silently treated as success', () => {
    const metas = [session('s1', [
      {
        role: 'assistant',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'File not found: x' },
    ])] // no outcomes written

    const d = diagnose(root, metas)

    // Falls back to the text, so the failure is still seen...
    expect(d.toolFailures).toBe(1)
    // ...and says the fallback happened, so a thin report is not read as a healthy one.
    expect(d.problems.join(' ')).toContain('no recorded outcomes')
  })
})

describe('classifying a failure without quoting it', () => {
  test('the categories that matter to this project', () => {
    // The one that is a MODEL habit rather than a workspace fact, and therefore the one a
    // prompt or a schema can actually fix.
    expect(classify("The token '&&' is not a valid statement separator in this version."))
      .toBe('shell-operator')
    expect(classify('File not found: src/a.ts')).toBe('not-found')
    expect(classify('src/a.ts is outside the workspace')).toBe('outside-workspace')
    expect(classify('Invalid glob pattern "**{": unclosed \'{\'')).toBe('bad-arguments')
    expect(classify('big.bin is 12.0 MB; read_file refuses files larger than 10.0 MB'))
      .toBe('too-large')
    expect(classify('the command timed out after 60s')).toBe('timeout')
    expect(classify('something nobody predicted')).toBe('other')
  })

  test('every category is a literal, so a message can never become one', () => {
    // The type says this; the test says it in a way that survives somebody widening the
    // return type by accident.
    const kinds = new Set([
      'not-found', 'outside-workspace', 'denied', 'bad-arguments', 'too-large', 'timeout',
      'shell-operator', 'command-failed', 'not-text', 'unavailable', 'wrong-tool', 'other',
    ])
    for (const text of [
      'File not found: /home/someone/secret/app.ts',
      'permission denied for C:/Users/someone/private',
      'exit 1: build failed in /srv/customer-app',
      'literally anything at all',
    ]) {
      expect(kinds.has(classify(text))).toBe(true)
    }
  })
})

/**
 * The three values that come off DISK and are printed as themselves.
 *
 * This is where the module's claim was nearly, but not actually, true. A tool NAME is read
 * from the transcript — which is model output, not something out of our registry — and
 * `mode` and `appVersion` come from a meta file that anything can write. Each is a short
 * token in every real case, and that is exactly the kind of "obviously fine" that turns a
 * privacy guarantee into a hope.
 */
describe('values that come off disk and get printed', () => {
  test('a tool name that is not a tool name is replaced, not clipped', () => {
    const metas = [session('s1', [{
      role: 'assistant',
      tool_calls: [{
        id: 'c1', type: 'function',
        // What a hallucinated call, or a hand-edited transcript, could put here.
        function: { name: 'SECRET /home/someone/customer-app/billing.ts', arguments: '{}' },
      }],
    }])]

    const report = renderDiagnosis(diagnose(root, metas))

    expect(report).not.toContain('SECRET')
    expect(report).not.toContain('billing.ts')
    // Replaced by a literal from the module. Dull on purpose: a lost name is a small loss
    // and the only outcome that cannot become a leak.
    expect(report).toContain('unknown-tool')
  })

  test('a real tool name survives untouched', () => {
    const metas = [session('s1', [{
      role: 'assistant',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_code', arguments: '{}' } }],
    }])]
    expect(renderDiagnosis(diagnose(root, metas))).toContain('search_code')
  })

  test('a mode and a version that are not what they claim are replaced', () => {
    const metas = [session('s1', [{ role: 'user', content: 'hi' }], {
      mode: 'SECRET-MODE-C:/customer/path',
      appVersion: 'SECRET-VERSION-/srv/app',
    } as unknown as Partial<SessionMeta>)]

    const report = renderDiagnosis(diagnose(root, metas))

    expect(report).not.toContain('SECRET')
    expect(report).not.toContain('customer')
    expect(report).toContain('unrecognised-mode')
    expect(report).toContain('unrecognised-version')
  })

  test('a real version survives, so the question it exists for stays answerable', () => {
    const metas = [session('s1', [{ role: 'user', content: 'hi' }],
      { appVersion: '0.1.5' } as Partial<SessionMeta>)]
    expect(renderDiagnosis(diagnose(root, metas))).toContain('0.1.5')
  })
})

test('a gate handing work back is counted apart from the person asking for it', async () => {
  const { VERIFY_FAILED_PREFIX } = await import('../src/verify/runner.js')
  const metas = [session('s1', [
    { role: 'user', content: 'add the endpoint' },
    // The harness talks in the user's role — the chat template has nowhere else to put a
    // build log. Counting it as a person's message would say the person asked twice.
    { role: 'user', content: `${VERIFY_FAILED_PREFIX} something failed` },
    { role: 'user', content: '[a bracketed harness note]' },
  ])]

  const d = diagnose(root, metas)

  expect(d.userMessages).toBe(1)
  expect(d.harnessMessages).toBe(2)
  // And the two are not the same thing, which the single total could not say. A failed
  // build is a turn of work handed back; a bracketed note is a status line. The report
  // separates them, and the ratio worth carrying off the machine is the first one.
  expect(d.gates.find((g) => g.kind === 'verify')?.fired).toBe(1)
  // A note never becomes a check. It is counted on its own, because `beforeStep` writes one
  // BETWEEN a check and the model's answer — so a note that closed the open check handed it
  // a cost of zero and charged the real work to something the report hides.
  expect(d.gates.find((g) => g.kind === 'note')).toBeUndefined()
  expect(d.harnessNotes).toBe(1)
  const report = renderDiagnosis(d)
  expect(report).toContain('harness turns')
  expect(report).toContain('build or tests failed')
  expect(report).toContain('status note not counted above')
})

/**
 * What an adversarial review broke, pinned so it cannot come back.
 *
 * The first version checked the three disk-sourced strings for the right SHAPE. Four
 * independent reviewers broke it, and the sharpest finding needed no tampering at all: an
 * MCP tool is called `mcp__<server>__<tool>` where the server is a key out of the user's own
 * config, so a correctly configured machine printed a client's name on the ordinary path.
 */
describe('membership, not shape', () => {
  const withToolNamed = (name: string): SessionMeta[] => [session('s1', [{
    role: 'assistant',
    tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: '{}' } }],
  }])]

  test('an MCP tool collapses to the prefix, which is ours, not the server name', () => {
    // The exact leak the audit reproduced: no hallucination, no edited file, just a
    // configured server called after the client.
    const report = renderDiagnosis(diagnose(root, withToolNamed('mcp__acmebank_prod__query_ledger')))
    expect(report).not.toContain('acmebank')
    expect(report).not.toContain('query_ledger')
    // The count survives: that MCP is used, and how much, is worth knowing and says nothing
    // about whose server it is.
    expect(report).toContain('mcp-tool')
  })

  test('a hallucinated name that LOOKS like a tool is still refused', () => {
    // Reaches disk because the agent loop appends the assistant message before the registry
    // is consulted, so "it would never be called" is not a defence.
    const report = renderDiagnosis(diagnose(root, withToolNamed('read_halcyon_nda_client_src')))
    expect(report).not.toContain('halcyon')
    expect(report).toContain('unknown-tool')
  })

  test('a version with a dotted tail cannot smuggle a path', () => {
    // `0.1.5-ProjectAtlas.MergerWith.ZebraCorp.billing.ts` passed the first regex whole, as
    // did a two-thousand-character tail. Dots are what had to go.
    for (const bad of [
      '0.1.5-ProjectAtlas.MergerWith.ZebraCorp.billing.ts',
      '1.0-billingsecrets.ts',
      '9-zebracorp.acme.q3',
      `1-${'x'.repeat(2000)}`,
    ]) {
      const report = renderDiagnosis(diagnose(root, [
        session(`s-${bad.length}`, [{ role: 'user', content: 'hi' }],
          { appVersion: bad } as Partial<SessionMeta>),
      ]))
      expect(report).not.toContain('billing')
      expect(report).not.toContain('zebracorp')
      expect(report).not.toContain('ProjectAtlas')
      expect(report).toContain('unrecognised-version')
    }
  })

  test('the versions we actually ship still print', () => {
    for (const good of ['0.1.5', '1.0', '2.10.3.4', '0.1.5-beta']) {
      const report = renderDiagnosis(diagnose(root, [
        session('s1', [{ role: 'user', content: 'hi' }], { appVersion: good } as Partial<SessionMeta>),
      ]))
      expect(report).toContain(good)
    }
  })

  test('an orphan failure cannot push the failure rate over 100%', () => {
    const metas = [session('s1', [
      {
        role: 'assistant',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'File not found: a' },
      // A result whose call was never announced. Attributing it produced "1 calls, 2 failed
      // — 200%", and a percentage over a hundred discredits every number beside it.
      { role: 'tool', tool_call_id: 'ghost', content: 'File not found: b' },
    ], {}, [{ id: 'c1', ok: false }, { id: 'ghost', ok: false }])]

    const d = diagnose(root, metas)

    expect(d.toolCalls).toBe(1)
    expect(d.toolFailures).toBe(1)
    expect(d.unattributedFailures).toBe(1)
    const report = renderDiagnosis(d)
    expect(report).not.toContain('200%')
    expect(report).toContain('orphan results')
    // And no phantom row claiming zero calls.
    expect(d.tools.every((t) => t.calls > 0)).toBe(true)
  })
})

/**
 * The classifier against the messages this codebase ACTUALLY produces.
 *
 * An adversarial inventory ran `classify` over the real literals and found it was matching
 * substrings nobody writes. `outside-workspace` was structurally unreachable for all four
 * write tools, because `Workspace` says "path escapes the workspace", not "outside the
 * workspace". `bad-arguments` never once fired for invalid JSON, though its own doc comment
 * claims it covers exactly that, because the registry says "could not be parsed as JSON" and
 * the classifier looked for "could not parse". A category that cannot be reached is worse
 * than a missing one: it makes `other` look like the unknown-unknowns bucket when it is
 * really the we-spelled-it-wrong bucket.
 *
 * Every literal below is copied from the source, so this test fails when a message is
 * reworded — which is the only way the two can be kept in step.
 */
describe('classify against the real messages', () => {
  const cases: [string, string][] = [
    // core/src/workspace.ts:315, :402, :416 — all four write tools reach these.
    ['path escapes the workspace: a.ts is not inside any of its folders (app, core)', 'outside-workspace'],
    ['path escapes the workspace: ../x resolves outside D:/ws', 'outside-workspace'],
    ['path escapes the workspace: x resolves outside D:/ws once links are followed', 'outside-workspace'],
    // core/src/workspace.ts:372 — a read-only mount, which named neither denial nor permission.
    ['"docs" is attached read-only, so nothing can be written to docs/a.md.', 'denied'],
    // core/src/tools/registry.ts:70, :78
    ['Arguments for edit_file could not be parsed as JSON: Unexpected token', 'bad-arguments'],
    ['Invalid arguments for edit_file: path must be a non-empty workspace-relative path', 'bad-arguments'],
    // The ones that already worked, kept so a rewrite of the list cannot lose them.
    ['File not found: src/a.ts', 'not-found'],
    ['the command timed out after 60s', 'timeout'],
    ["The token '&&' is not a valid statement separator in this version.", 'shell-operator'],
  ]

  for (const [message, expected] of cases) {
    test(`"${message.slice(0, 46)}…" is ${expected}`, () => {
      expect(classify(message)).toBe(expected)
    })
  }
})

test('the user\'s own content cannot steer the classification', () => {
  // `edit_file` quotes the near-miss window out of THEIR file into the message. Matching the
  // whole string made the category depend on what happened to be in that window: measured,
  // the same hint returned `not-found` normally and `denied` when the quoted lines contained
  // the word "permission". Not a leak — the return type still cannot carry text — but counts
  // that move with the user's code are noise in a document forwarded as evidence.
  const hint = 'search_text was not found anywhere in the file. The closest match is:'
  expect(classify(hint)).toBe('not-found')
  expect(classify(`${hint}\n  if (!user.permission) denied();`)).toBe('not-found')
})

test('a failure survives a missing outcomes file, and is labelled as estimated', async () => {
  // The worst of the inventory's findings, and it was a disappearance rather than a
  // mis-bucketing: the fallback demanded BOTH a recognised category AND one of seven
  // keywords, and over 59 real failure literals it counted 11. The two conditions failed
  // independently — a `validate()` refusal classifies correctly and carries no keyword, so
  // it was categorised right and then counted as a success.
  const metas = [session('s1', [
    {
      role: 'assistant',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'edit_file', arguments: '{}' } }],
    },
    // No keyword from the old list anywhere in this sentence.
    { role: 'tool', tool_call_id: 'c1', content: 'Invalid arguments for edit_file: path must be a non-empty workspace-relative path' },
  ])] // deliberately no outcomes sidecar — the shape a crashed session leaves behind

  const d = diagnose(root, metas)

  expect(d.toolFailures).toBe(1)
  expect(d.tools.find((t) => t.name === 'edit_file')?.failures['bad-arguments']).toBe(1)
  // And said out loud, because a guess presented as a count is worse where it matters most:
  // the sessions missing this file are the ones that crashed.
  expect(d.estimatedFailures).toBe(1)
  expect(renderDiagnosis(d)).toContain('treat them as approximate')
})

/**
 * The stories, which are the reason this is a diagnosis and not a dashboard.
 *
 * A count says a mistake happened. A failure read together with what the model did NEXT says
 * what the model thought the mistake was, and the outcome says whether it was right. Those
 * three are what a person means by "diagnose it" — and none of them is a value, so all three
 * can leave the machine.
 *
 * Nothing here repairs anything. The next move is an OBSERVATION of what the model did; what
 * to do about it is a person's call, made with the report in hand.
 */
describe('failure, what happened next, and whether it worked', () => {
  const call = (id: string, name: string, args: string) => ({
    role: 'assistant',
    tool_calls: [{ id, type: 'function' as const, function: { name, arguments: args } }],
  })

  test('the owner\'s own example comes out as a sentence with no path in it', () => {
    // Read a path with a leading folder that is not there; then read it without. Twice, so
    // it is a pattern rather than an incident.
    const lines: Line[] = []
    const outcomes: { id: string; ok: boolean }[] = []
    for (const [i, name] of ['Program', 'Startup'].entries()) {
      const bad = `c${i}a`
      const good = `c${i}b`
      lines.push(
        call(bad, 'read_file', JSON.stringify({ path: `src/Engine/${name}.cs` })),
        { role: 'tool', tool_call_id: bad, content: `File not found: src/Engine/${name}.cs` },
        call(good, 'read_file', JSON.stringify({ path: `Engine/${name}.cs` })),
        { role: 'tool', tool_call_id: good, content: '1\tnamespace Engine;' },
      )
      outcomes.push({ id: bad, ok: false }, { id: good, ok: true })
    }
    const report = renderDiagnosis(diagnose(root, [session('s1', lines, {}, outcomes)]))

    expect(report).toContain('read_file · not-found on a place in the workspace — 2 times')
    expect(report).toContain('dropped a leading part of it, which worked 2 of 2 times')
    // The finding is the RELATION. Neither path appears.
    expect(report).not.toContain('Engine')
    expect(report).not.toContain('Program.cs')
  })

  test('a value the model was never shown is called out as invented', () => {
    // The sharpest question in the report, and the cheapest: before blaming a tool's
    // description, ask whether the model was working from anything at all.
    const lines: Line[] = []
    const outcomes: { id: string; ok: boolean }[] = []
    for (let i = 0; i < 2; i++) {
      lines.push(
        call(`x${i}`, 'read_file', JSON.stringify({ path: `src/Invented${i}.cs` })),
        { role: 'tool', tool_call_id: `x${i}`, content: `File not found: src/Invented${i}.cs` },
        call(`y${i}`, 'read_file', JSON.stringify({ path: `other/Guess${i}.cs` })),
        { role: 'tool', tool_call_id: `y${i}`, content: `File not found: other/Guess${i}.cs` },
      )
      outcomes.push({ id: `x${i}`, ok: false }, { id: `y${i}`, ok: false })
    }
    const report = renderDiagnosis(diagnose(root, [session('s1', lines, {}, outcomes)]))

    expect(report).toContain('the value had never appeared in anything it had been shown')
    expect(report).toContain('a better tool description would not have helped')
    expect(report).not.toContain('Invented')
  })

  test('a path the model HAD been shown is not called invented', () => {
    // The other half, or the finding above would be true of everything and mean nothing.
    const listing = 'src/Real.cs\nsrc/Other.cs'
    const lines: Line[] = [
      call('a1', 'list_dir', JSON.stringify({ path: 'src' })),
      { role: 'tool', tool_call_id: 'a1', content: listing },
    ]
    const outcomes = [{ id: 'a1', ok: true }]
    for (let i = 0; i < 2; i++) {
      lines.push(
        call(`b${i}`, 'read_file', JSON.stringify({ path: 'src/Real.cs' })),
        { role: 'tool', tool_call_id: `b${i}`, content: 'File not found: src/Real.cs' },
        call(`c${i}`, 'read_file', JSON.stringify({ path: 'Real.cs' })),
        { role: 'tool', tool_call_id: `c${i}`, content: 'File not found: Real.cs' },
      )
      outcomes.push({ id: `b${i}`, ok: false }, { id: `c${i}`, ok: false })
    }
    const d = diagnose(root, [session('s1', lines, {}, outcomes)])

    // It was in the listing it was given, so the fault is not that it made the name up.
    const shown = d.patterns.find((p) => p.what === 'read_file' && p.invented === 0)
    expect(shown).toBeDefined()
  })

  test('retrying the identical call is its own story', () => {
    const lines: Line[] = []
    const outcomes: { id: string; ok: boolean }[] = []
    for (let i = 0; i < 3; i++) {
      lines.push(
        call(`r${i}`, 'run_command', JSON.stringify({ commands: ['dotnet build'] })),
        { role: 'tool', tool_call_id: `r${i}`, content: 'exit 1: build failed' },
      )
      outcomes.push({ id: `r${i}`, ok: false })
    }
    const report = renderDiagnosis(diagnose(root, [session('s1', lines, {}, outcomes)]))

    // The failure taught it nothing, three times — which is a finding about the MESSAGE we
    // sent back, not about the command.
    expect(report).toContain('tried the exact same thing again')
  })

  test('a one-off is not reported as a pattern', () => {
    // A single incident is noise. The report is for what recurs; anything else fills it with
    // things nobody can act on.
    const lines: Line[] = [
      call('c1', 'read_file', JSON.stringify({ path: 'src/Once.cs' })),
      { role: 'tool', tool_call_id: 'c1', content: 'File not found: src/Once.cs' },
    ]
    const report = renderDiagnosis(diagnose(root, [session('s1', lines, {}, [{ id: 'c1', ok: false }])]))
    expect(report).not.toContain('what went wrong and what happened next')
  })
})

test('provenance is only asked where the answer means something', async () => {
  // Measured on a demo run: a command is ALWAYS "invented" — the model composes it, it was
  // never in a result — so the line fired on every command pattern and drowned the one case
  // where the word carries weight. A location could have been observed; choosing one that
  // never was is the model working from nothing.
  const lines: Line[] = []
  const outcomes: { id: string; ok: boolean }[] = []
  for (let i = 0; i < 2; i++) {
    lines.push(
      {
        role: 'assistant',
        tool_calls: [{
          id: `k${i}`, type: 'function',
          function: { name: 'run_command', arguments: JSON.stringify({ commands: ['dotnet build'] }) },
        }],
      },
      { role: 'tool', tool_call_id: `k${i}`, content: 'exit 1: build failed' },
    )
    outcomes.push({ id: `k${i}`, ok: false })
  }
  const d = diagnose(root, [session('s1', lines, {}, outcomes)])

  // Across every run_command story, not one of them: the LAST failure has no sequel, so it
  // groups as `gave-up` and is its own pattern. That split is correct and is why the
  // assertion is over all of them.
  const commandPatterns = d.patterns.filter((p) => p.what === 'run_command')
  expect(commandPatterns.length).toBeGreaterThan(0)
  expect(commandPatterns.every((p) => p.invented === 0)).toBe(true)
  expect(renderDiagnosis(d)).not.toContain('it was invented')
})
