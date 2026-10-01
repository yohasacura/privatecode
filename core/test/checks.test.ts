import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session, type StageInfo } from '../src/session/session.js'
import { checksPolicy, isCodePath } from '../src/session/checks.js'
import { LlamaClient } from '../src/llama/client.js'
import { createToolset } from '../src/tools/default-set.js'
import { PermissionEngine } from '../src/permissions/engine.js'
import { RawResponse, startFakeServer } from './fake-server.js'

/**
 * What the harness does by itself, and when (`session/checks.ts`).
 *
 * Three promises. Checks OFF — the default in the app — means nothing at all runs unasked:
 * no contract folded into the request, no plan, no build, no audit, not even on a turn that
 * wrote nothing and said "done". Checks ON is about CODE: a request that changes none, and
 * prose written into the project, are left alone, and the audit judges work rather than
 * every turn that happens to follow an unfinished task. And `/check` and `/review` run on
 * demand whatever the switch says — `/review` without a contract makes its own from the
 * person's words and reads everything changed since the last review.
 */

let root: string
let stop: (() => Promise<void>) | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-checks-'))
  mkdirSync(join(root, '.privatecode'), { recursive: true })
})
afterEach(async () => {
  await stop?.()
  stop = undefined
  rmSync(root, { recursive: true, force: true })
})

const TASK =
  'Create src/summary.ts exporting a function that explains what this workspace is for, in ' +
  'at least three short paragraphs. Then confirm the file exists by reading it back. Keep ' +
  'the wording plain and do not touch any other file in the workspace while you do it.'

const LETTER =
  'Напиши письмо клиенту: мы переносим сдачу проекта на неделю, потому что нашли ошибку в ' +
  'расчётах и хотим её исправить до релиза. Тон вежливый, без лишних извинений. Сохрани ' +
  'письмо в letters/delay.md, чтобы я мог его потом отправить.'

const CODE_CONTRACT = {
  goal: 'src/summary.ts exists and explains the workspace',
  rules: [], criteria: ['src/summary.ts exists', 'it has three paragraphs'],
  constraints: [], interfaces: '', kind: 'feature', changesCode: true,
}
const LETTER_CONTRACT = {
  goal: 'a polite letter about the delay', rules: [],
  criteria: ['the letter names the one-week delay', 'it gives the reason'],
  constraints: [], interfaces: '', kind: 'other', changesCode: false,
}

const write = (path: string, content: string) => ({
  choices: [{
    message: {
      role: 'assistant', content: null,
      tool_calls: [{ id: `w-${path}`, type: 'function', function: { name: 'Write', arguments: JSON.stringify({ path, content }) } }],
    },
    finish_reason: 'tool_calls',
  }],
  usage: { prompt_tokens: 900, completion_tokens: 40 },
})
const text = (s: string) => ({
  choices: [{ message: { role: 'assistant', content: s }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1000, completion_tokens: 10 },
})

interface Fake {
  url: string
  /** The forced-JSON schemas asked for, in order: which checks ran. */
  seen: string[]
  /** Every chat request body, for what the model and the reviewer were actually shown. */
  bodies: { messages?: { role: string; content?: string | null }[] }[]
}

/**
 * A fake that answers each kind of request by what it IS: a check by its schema name, the
 * main loop by call order. `answers` overrides a schema's reply.
 */
async function serve(steps: () => unknown, answers: Record<string, unknown> = {}): Promise<Fake> {
  const seen: string[] = []
  const bodies: Fake['bodies'] = []
  const fake = await startFakeServer((body, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: 32_000 } }
    if (req.url === '/health') return { status: 'ok' }
    if (req.url?.startsWith('/slots/')) return new RawResponse(501, '{"error":{"code":501}}', 'application/json')
    bodies.push(body)
    const name = (body.response_format as { json_schema?: { name?: string } } | undefined)?.json_schema?.name
    if (name !== undefined) {
      seen.push(name)
      if (answers[name] !== undefined) return text(JSON.stringify(answers[name]))
      if (name === 'contract') return text(JSON.stringify(CODE_CONTRACT))
      if (name === 'acceptance') return text(JSON.stringify({ items: [{ index: 1, evidence: 'written', met: true }, { index: 2, evidence: 'three paragraphs', met: true }] }))
      if (name === 'review') return text(JSON.stringify({ goalMet: true, goalGap: '', issues: [] }))
      if (name === 'premises') return text(JSON.stringify({ premises: [] }))
      return text(JSON.stringify({ does: ['a summary file exists'] }))
    }
    return steps()
  })
  stop = fake.close
  return { url: fake.url, seen, bodies }
}

function build(url: string, opts: {
  stages?: StageInfo[]; verifies?: string[]; gates?: 'fast'; checks?: 'on' | 'off'
} = {}): Session {
  return new Session({
    client: new LlamaClient({ baseUrl: url, model: 'm' }),
    toolset: createToolset({}),
    workspaceRoot: root,
    mode: 'autopilot',
    engine: new PermissionEngine({ layers: [], mode: 'autopilot', workspaceRoot: root }),
    verify: { command: 'cmd /c exit 0', timeoutMs: 20_000, source: 'test' },
    onVerify: (i) => opts.verifies?.push(i.command),
    onStage: (s) => opts.stages?.push(s),
    ...(opts.gates !== undefined ? { gates: opts.gates } : {}),
    ...(opts.checks !== undefined ? { checks: opts.checks } : {}),
  })
}

/** The person's message as the model received it. */
function firstUserMessage(session: Session): string {
  return String(session.messages().find((m) => m.role === 'user')?.content ?? '')
}

describe('the policy table', () => {
  test('off is nothing, whatever the profile', () => {
    for (const profile of ['thorough', 'fast', 'off'] as const) {
      expect(Object.values(checksPolicy(false, profile)).every((v) => v === false)).toBe(true)
    }
  })

  test('on, the profile decides — and only thorough reviews and nudges by itself', () => {
    expect(checksPolicy(true, 'thorough')).toMatchObject({ contract: true, review: true, planNudges: true, firstWrite: true })
    expect(checksPolicy(true, 'fast')).toMatchObject({ contract: true, leanContract: true, audit: true, review: false, planNudges: false })
    expect(checksPolicy(true, 'off')).toMatchObject({ contract: false, audit: false, buildAfterEdit: true, buildAtEnd: true })
  })

  test('prose is not code; config and markup are', () => {
    for (const p of ['letters/delay.md', 'NOTES.txt', 'docs\\guide.rst', 'mail.eml', 'report.docx', '.privatecode/skills/x/run.ts']) {
      expect(isCodePath(p), p).toBe(false)
    }
    for (const p of ['src/a.ts', 'App.cs', 'settings.json', 'deploy.yaml', 'index.html', 'page.mdx', 'Makefile', 'fixtures/data.csv']) {
      expect(isCodePath(p), p).toBe(true)
    }
  })
})

describe('checks off', () => {
  test('a task-shaped request runs free: no contract, no plan, no build, no audit', async () => {
    let call = 0
    const fake = await serve(() => { call++; return call === 1 ? write('src/summary.ts', 'export {}\n') : text('All done — the file is written.') })
    const stages: StageInfo[] = []
    const verifies: string[] = []
    const session = build(fake.url, { stages, verifies, checks: 'off' })
    expect(session.gateMode).toBe('manual')

    await session.send(TASK)

    expect(fake.seen).toEqual([])
    expect(verifies).toEqual([])
    expect(stages).toEqual([])
    expect(session.meta.contract).toBeUndefined()
    expect(session.todos()).toEqual([])
    // The request reaches the model as the person wrote it.
    expect(firstUserMessage(session)).not.toContain('TASK CONTRACT')
    expect(firstUserMessage(session)).toContain('Create src/summary.ts')
    // And the prompt does not claim a check that will not come.
    expect(session.messages()[0]?.content).not.toMatch(/runs by itself/)

    // Asked by hand, the build runs.
    await session.runGate('build')
    expect(verifies).toEqual(['cmd /c exit 0'])
  })

  test('a turn that wrote nothing and says "done" does not open the audit', async () => {
    // The contract comes from a stretch with the checks on, which ends without claiming to
    // be finished — so the contract is still open when the checks are switched off.
    let call = 0
    const fake = await serve(() => {
      call++
      if (call === 1) return write('src/summary.ts', 'export {}\n')
      if (call === 2) return text('Still working on it, more to come.')
      return text('All done. Here is the release note you asked for.')
    })
    const session = build(fake.url, { checks: 'on' })
    await session.send(TASK)
    expect(session.meta.contract).toBeDefined()

    session.gateMode = 'manual'
    const before = fake.seen.length
    await session.send('now draft a short release note')
    expect(fake.seen.slice(before)).toEqual([])
  })

  test('/review makes its own contract from your words and reads everything since the last review', async () => {
    let call = 0
    const fake = await serve(() => {
      call++
      if (call === 1) return write('src/one.ts', 'export const one = 1\n'.repeat(5))
      if (call === 2) return text('Added one.')
      if (call === 3) return write('src/two.ts', 'export const two = 2\n'.repeat(5))
      if (call === 4) return text('Added two.')
      return text('Read it; nothing else to check.')
    })
    const stages: StageInfo[] = []
    const session = build(fake.url, { stages, checks: 'off' })

    await session.send('add src/one.ts')
    await session.send('and src/two.ts beside it')
    expect(fake.seen).toEqual([])

    const asked = await session.runGate('review')
    expect(fake.seen).toEqual(['contract', 'review'])
    expect(asked.outcome).toBe('no findings')
    // The reader was given both requests and both files, not only the last turn's.
    const brief = fake.bodies
      .flatMap((b) => b.messages ?? [])
      .find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('You are reviewing'))
    expect(brief?.content).toContain('add src/one.ts')
    expect(brief?.content).toContain('and src/two.ts beside it')
    expect(brief?.content).toContain('src/one.ts (created this turn)')
    expect(brief?.content).toContain('src/two.ts (created this turn)')

    // Reviewed is reviewed: asked again with nothing new, it says so without a generation.
    const again = await session.runGate('review')
    expect(again.outcome).toContain('nothing to review')
    expect(fake.seen).toEqual(['contract', 'review'])
  })
})

describe('checks on', () => {
  test('a request that changes no code runs free, and retires the task before it', async () => {
    let call = 0
    const answers: Record<string, unknown> = {}
    const fake = await serve(() => {
      call++
      if (call === 1) return write('src/summary.ts', 'export {}\n')
      if (call === 2) return text('Done.')
      if (call === 3) return write('letters/delay.md', 'Уважаемый клиент,\n\n'.repeat(200))
      return text('Всё готово. Письмо сохранено в letters/delay.md.')
    }, answers)
    const stages: StageInfo[] = []
    const verifies: string[] = []
    const session = build(fake.url, { stages, verifies, checks: 'on' })

    // A code task first, so there is a contract for the letter to replace.
    await session.send(TASK)
    expect(session.meta.contract?.changesCode).toBe(true)

    const seenBefore = fake.seen.length
    const verifiesBefore = verifies.length
    const stagesBefore = stages.length
    // The distiller judges the letter: no code.
    answers['contract'] = LETTER_CONTRACT
    await session.send(LETTER)

    // Only the distillation ran: no plan, no build, no audit, no review of a letter.
    expect(fake.seen.slice(seenBefore)).toEqual(['contract'])
    expect(verifies.length).toBe(verifiesBefore)
    const letterStages = stages.slice(stagesBefore)
    expect(letterStages.map((s) => `${s.stage}:${s.state}`)).toEqual(['contract:started', 'contract:done'])
    expect(letterStages.at(-1)?.outcome).toMatch(/not a change to code/)
    // Not folded into the request, not kept — and the code task's contract is gone too.
    const letter = session.messages()
      .filter((m) => m.role === 'user').map((m) => String(m.content))
      .find((c) => c.includes('Напиши письмо'))
    expect(letter).toBeDefined()
    expect(letter).not.toContain('TASK CONTRACT')
    expect(session.meta.contract).toBeUndefined()
  })

  test('prose written into the project builds, audits and reviews nothing', async () => {
    let call = 0
    const fake = await serve(() => {
      call++
      return call === 1 ? write('docs/notes.md', 'paragraph\n'.repeat(400)) : text('All done, the notes are written.')
    })
    const verifies: string[] = []
    const session = build(fake.url, { verifies, checks: 'on' })

    await session.send(TASK)

    expect(fake.seen).toEqual(['contract'])
    expect(verifies).toEqual([])
  })

  test('code written is built, audited and reviewed', async () => {
    let call = 0
    const fake = await serve(() => {
      call++
      if (call === 1) return write('src/summary.ts', 'export const s = 1\n'.repeat(200))
      return text('All done, the file is written.')
    })
    const verifies: string[] = []
    const session = build(fake.url, { verifies, checks: 'on' })

    await session.send(TASK)

    expect(fake.seen).toEqual(['contract', 'acceptance', 'review'])
    expect(verifies).toContain('cmd /c exit 0')
  })

  test('a short follow-up is not audited against the previous task it did not replace', async () => {
    let call = 0
    const fake = await serve(() => {
      call++
      if (call === 1) return write('src/summary.ts', 'export {}\n')
      if (call <= 3) return text('Done.')
      return text('All done — here is the release note: version 2 explains the workspace.')
    }, {
      acceptance: { items: [{ index: 1, evidence: 'written', met: true }, { index: 2, evidence: 'nothing shows three paragraphs', met: false }] },
    })
    const session = build(fake.url, { checks: 'on', gates: 'fast' })
    await session.send(TASK)
    // The audit ran and left the task open.
    expect(fake.seen.filter((s) => s === 'acceptance').length).toBeGreaterThan(0)
    expect(session.meta.contract?.satisfied).not.toBe(true)

    const before = fake.seen.length
    await session.send('now draft a short release note')
    expect(fake.seen.slice(before)).toEqual([])
  })

  test('/review runs the reviewer even in the fast profile', async () => {
    let call = 0
    // A change big enough for an independent reader to have something to read.
    const fake = await serve(() => { call++; return call === 1 ? write('src/summary.ts', 'export const p = 1\n'.repeat(300)) : text('done, the file is written') })
    const stages: StageInfo[] = []
    const session = build(fake.url, { stages, gates: 'fast', checks: 'on' })

    await session.send(TASK)
    // By itself, `fast` audits and does not review.
    expect(fake.seen).toContain('acceptance')
    expect(fake.seen).not.toContain('review')

    const asked = await session.runGate('review')
    expect(fake.seen).toContain('review')
    expect(asked.outcome).not.toContain('nothing to review')
    expect(stages.some((s) => s.stage === 'review' && s.state === 'done')).toBe(true)
  })
})
