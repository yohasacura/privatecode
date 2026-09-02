import { afterAll, afterEach, beforeEach, expect, test } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSkills, projectSkillsDir } from '../src/skills/skills.js'
import { useSkillTool } from '../src/tools/use-skill.js'
import { buildSystemPrompt } from '../src/agent/prompt.js'
import { Workspace } from '../src/workspace.js'
import type { ToolContext } from '../src/tools/types.js'
import { Session } from '../src/session/session.js'
import { LlamaClient } from '../src/llama/client.js'
import { createToolset } from '../src/tools/default-set.js'
import { startFakeServer } from './fake-server.js'

/**
 * Skills: a catalogue in the prompt, a body read on demand.
 *
 * Two properties carry the whole design and each has a test that fails if it stops holding.
 * The first is progressive disclosure — a description costs prompt tokens forever, a body
 * costs nothing until it is opened — so a skill that quietly put its body in the catalogue
 * would break the economics that make fifty skills affordable. The second is that the file
 * layout is Claude Code's, which is only useful if skills written for that tool actually
 * parse here, folded frontmatter and all.
 */

let root: string
let userDir: string
let stopServer: (() => Promise<void>) | undefined
const dirs: string[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-skills-'))
  dirs.push(root)
  userDir = join(root, 'user-skills')
})

afterEach(async () => {
  await stopServer?.()
  stopServer = undefined
})

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function writeSkill(parent: string, name: string, text: string, extras: Record<string, string> = {}): string {
  const dir = join(parent, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), text, 'utf8')
  for (const [file, body] of Object.entries(extras)) writeFileSync(join(dir, file), body, 'utf8')
  return dir
}

const ctxWith = (skills: ReturnType<typeof loadSkills>): ToolContext =>
  ({ workspace: new Workspace(root), skills })

test('a workspace with no skills loads nothing, reports nothing, and adds nothing to the prompt', () => {
  const loaded = loadSkills(root, userDir)
  expect(loaded.skills).toEqual([])
  expect(loaded.problems).toEqual([])
  expect(loaded.catalogue).toBe('')
  // The invariant this repo keeps for every optional prompt block: absent leaves the prompt
  // byte-for-byte what it was before the feature existed.
  const withOut = buildSystemPrompt({ workspaceRoot: root, mode: 'normal' })
  const withEmpty = buildSystemPrompt({ workspaceRoot: root, mode: 'normal', skills: loaded.catalogue })
  expect(withEmpty).toBe(withOut)
})

test('the catalogue carries descriptions and NOT bodies — the whole economics of the feature', () => {
  writeSkill(projectSkillsDir(root), 'release-notes', [
    '---',
    'name: release-notes',
    'description: Write the release notes for a version. Use when asked to cut a release.',
    '---',
    '# Release notes',
    'STEP ONE IS A SECRET THAT MUST NOT BE IN THE PROMPT',
  ].join('\n'))

  const loaded = loadSkills(root, userDir)
  expect(loaded.problems).toEqual([])
  expect(loaded.skills.map((s) => s.name)).toEqual(['release-notes'])
  expect(loaded.catalogue).toContain('release-notes')
  expect(loaded.catalogue).toContain('Use when asked to cut a release.')
  expect(loaded.catalogue).not.toContain('SECRET')
  // And the frame has to tell the model to open it, or a one-line label becomes the whole
  // procedure the model acts on.
  expect(loaded.catalogue).toContain('Skill')
})

test("folded frontmatter parses — it is how real skills in the wild write a two-sentence description", () => {
  writeSkill(projectSkillsDir(root), 'pdf-forms', [
    '---',
    'name: pdf-forms',
    'description: >-',
    '  Fill in a PDF form from a data file.',
    '  Use when the user asks to complete, sign or flatten a PDF.',
    '---',
    'body',
  ].join('\n'))

  const loaded = loadSkills(root, userDir)
  expect(loaded.problems).toEqual([])
  expect(loaded.skills[0]!.description)
    .toBe('Fill in a PDF form from a data file. Use when the user asks to complete, sign or flatten a PDF.')
})

test('a skill with no description is refused by name, because the catalogue line is all the model gets', () => {
  writeSkill(projectSkillsDir(root), 'nameless', '---\nname: nameless\n---\nbody')
  writeSkill(projectSkillsDir(root), 'no-frontmatter', '# just a document')
  mkdirSync(join(projectSkillsDir(root), 'not-a-skill'), { recursive: true })

  const loaded = loadSkills(root, userDir)
  expect(loaded.skills).toEqual([])
  expect(loaded.problems.some((p) => p.includes('nameless') && p.includes('description'))).toBe(true)
  expect(loaded.problems.some((p) => p.includes('no-frontmatter') && p.includes('frontmatter'))).toBe(true)
  // A folder without a SKILL.md is somebody's notes, not a broken skill: silent by design.
  expect(loaded.problems.some((p) => p.includes('not-a-skill'))).toBe(false)
})

test('a project skill shadows a user one of the same name, and the shadowing is said out loud', () => {
  writeSkill(userDir, 'deploy', '---\ndescription: the personal one\n---\nUSER BODY')
  writeSkill(projectSkillsDir(root), 'deploy', '---\ndescription: the project one\n---\nPROJECT BODY')

  const loaded = loadSkills(root, userDir)
  expect(loaded.skills).toHaveLength(1)
  expect(loaded.skills[0]!.scope).toBe('project')
  expect(loaded.problems.some((p) => p.includes('defined twice'))).toBe(true)
})

test('the frontmatter name is reported when it disagrees with the folder, and the folder wins', () => {
  writeSkill(projectSkillsDir(root), 'actual-folder', '---\nname: copied-from-elsewhere\ndescription: d\n---\nb')
  const loaded = loadSkills(root, userDir)
  expect(loaded.skills[0]!.name).toBe('actual-folder')
  expect(loaded.problems.some((p) => p.includes('copied-from-elsewhere'))).toBe(true)
})

test('Skill returns the body without repeating the frontmatter the model already saw', async () => {
  writeSkill(projectSkillsDir(root), 'review', [
    '---', 'description: Review a diff.', '---', '# Review', 'Read the diff twice.',
  ].join('\n'))
  const loaded = loadSkills(root, userDir)

  const v = useSkillTool.validate({ name: 'review' })
  expect(v.ok).toBe(true)
  const r = await useSkillTool.execute((v as { ok: true; args: { name: string } }).args, ctxWith(loaded))
  expect(r.ok).toBe(true)
  expect(r.content).toContain('Read the diff twice.')
  expect(r.content).not.toContain('description: Review a diff.')
})

test('an unknown name comes back with the list, so a near-miss costs one call and not a turn', async () => {
  writeSkill(projectSkillsDir(root), 'review-diff', '---\ndescription: d\n---\nbody')
  const loaded = loadSkills(root, userDir)
  const v = useSkillTool.validate({ name: 'review' })
  const r = await useSkillTool.execute((v as { ok: true; args: { name: string } }).args, ctxWith(loaded))
  expect(r.ok).toBe(false)
  expect(r.content).toContain('review-diff')
})

test('a bundled file can be read, and nothing outside the skill folder can', async () => {
  writeSkill(projectSkillsDir(root), 'audit', '---\ndescription: d\n---\nbody', {
    'checklist.md': 'ONE: check the thing',
  })
  writeFileSync(join(root, 'secret.txt'), 'not part of any skill', 'utf8')
  const loaded = loadSkills(root, userDir)
  expect(loaded.skills[0]!.files).toEqual(['checklist.md'])

  const ok = await useSkillTool.execute({ name: 'audit', file: 'checklist.md' }, ctxWith(loaded))
  expect(ok.ok).toBe(true)
  expect(ok.content).toContain('ONE: check the thing')

  const escaped = await useSkillTool.execute(
    { name: 'audit', file: '../../../secret.txt' }, ctxWith(loaded))
  expect(escaped.ok).toBe(false)
  expect(escaped.content).not.toContain('not part of any skill')
})

test('an edited body reaches the very next call, while the catalogue stays frozen', async () => {
  const dir = writeSkill(projectSkillsDir(root), 'evolving', '---\ndescription: first\n---\nFIRST BODY')
  const loaded = loadSkills(root, userDir)
  expect(loaded.catalogue).toContain('first')

  // The user edits the skill while the session is running. Message 0 cannot be rewritten —
  // that is the append-only rule — but the body is read from disk on every call, so the
  // procedure updates and only the DESCRIPTION waits for a new session.
  writeFileSync(join(dir, 'SKILL.md'), '---\ndescription: second\n---\nSECOND BODY', 'utf8')

  const r = await useSkillTool.execute({ name: 'evolving' }, ctxWith(loaded))
  expect(r.content).toContain('SECOND BODY')
  expect(loaded.catalogue).toContain('first')
  expect(loaded.catalogue).not.toContain('second')
})

test('a session with no skills says so rather than pretending the name was wrong', async () => {
  const r = await useSkillTool.execute({ name: 'anything' }, { workspace: new Workspace(root) })
  expect(r.ok).toBe(false)
  expect(r.content).toContain('no skills loaded')
})

test('a real turn: the catalogue reaches message 0 and Skill returns the body', async () => {
  // The unit tests above prove the loader and the tool. This one exists for the seam
  // between them — Session freezing the catalogue into the system message, and Session
  // putting the skill LIST into the tool context — which is three files of wiring that no
  // amount of testing either end can establish.
  writeSkill(projectSkillsDir(root), 'cut-release', [
    '---',
    'description: Cut a release. Use when asked to ship a version.',
    '---',
    'Bump the version, then tag it.',
  ].join('\n'))

  const bodies: { messages: { role: string; content?: string }[] }[] = []
  let call = 0
  const fake = await startFakeServer((body, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: 8000 } }
    if (req.url === '/health') return { status: 'ok' }
    bodies.push(body as { messages: { role: string; content?: string }[] })
    call++
    return call === 1
      ? {
        choices: [{
          message: {
            role: 'assistant',
            tool_calls: [{
              id: 'c1', type: 'function',
              function: { name: 'Skill', arguments: JSON.stringify({ name: 'cut-release' }) },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      }
      : {
        choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 120, completion_tokens: 5 },
      }
  })
  stopServer = fake.close

  const session = new Session({
    client: new LlamaClient({ baseUrl: fake.url, model: 'm' }),
    toolset: createToolset({}),
    workspaceRoot: root,
    mode: 'autopilot',
    skills: loadSkills(root, userDir),
  })
  await session.send('ship 0.2.0')

  const systemMessage = bodies[0]!.messages[0]!
  expect(systemMessage.role).toBe('system')
  expect(systemMessage.content).toContain('cut-release')
  expect(systemMessage.content).toContain('Use when asked to ship a version.')
  // The body was NOT in the prompt — it arrived as a tool result, which is the point.
  expect(systemMessage.content).not.toContain('Bump the version')
  const toolMessage = bodies[1]!.messages.find((m) => m.role === 'tool')
  expect(toolMessage?.content).toContain('Bump the version, then tag it.')
})
