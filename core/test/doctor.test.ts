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
    const metas = [session('s1', [
      { role: 'system', content: 'workspace at C:/SECRET-SYSTEM-PROMPT' },
      { role: 'user', content: 'please fix SECRET-USER-PROSE in the billing module' },
      {
        role: 'assistant',
        content: 'I will look at SECRET-ASSISTANT-PROSE',
        tool_calls: [{
          id: 'c1', type: 'function',
          function: { name: 'read_file', arguments: '{"path":"src/SECRET-ARGUMENT-PATH.ts"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'File not found: src/SECRET-TOOL-OUTPUT.ts' },
    ], { title: 'SECRET-SESSION-TITLE' }, [{ id: 'c1', ok: false }])]

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
  // And the ratio is the number worth carrying off the machine: how much of the work was
  // the work, and how much was the checking of it.
  expect(renderDiagnosis(d)).toContain('handed back')
})
