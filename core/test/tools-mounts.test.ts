import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { buildSystemPrompt } from '../src/agent/prompt.js'
import type { Mount } from '../src/mounts.js'
import { findFilesTool } from '../src/tools/find-files.js'
import { listDirTool } from '../src/tools/list-dir.js'
import { BackgroundTasks, backgroundTaskTool } from '../src/tools/background-task.js'
import { runCommandTool } from '../src/tools/run-command.js'
import { searchCodeTool } from '../src/tools/search-code.js'
import { canonicalize, Workspace } from '../src/workspace.js'

/**
 * What the model can see once a workspace is several folders.
 *
 * The point of every case here is that ONE call covers the whole workspace. A find or a
 * search that only ever looked at the primary folder would make the other folders decorative:
 * the model would have to be told, per call, which of five places to look, and it would get
 * that wrong in a way nothing could catch.
 */

let base: string
let ws: Workspace
let mounts: Mount[]

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'pc-tools-mnt-'))
  const app = join(base, 'app')
  const engine = join(base, 'engine')
  const refs = join(base, 'refs')
  mkdirSync(join(app, 'src'), { recursive: true })
  mkdirSync(join(engine, 'src'), { recursive: true })
  mkdirSync(refs, { recursive: true })
  writeFileSync(join(app, 'src', 'main.ts'), 'export function boot() { return 1 }\n', 'utf8')
  writeFileSync(join(engine, 'src', 'boot.ts'), 'export function boot() { return 2 }\n', 'utf8')
  writeFileSync(join(refs, 'notes.md'), 'boot is documented here\n', 'utf8')
  mounts = [
    { name: 'app', root: app, access: 'write', primary: true },
    { name: 'engine', root: engine, access: 'write', primary: false },
    { name: 'refs', root: refs, access: 'read', primary: false },
  ]
  ws = new Workspace(mounts)
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

describe('list_dir', () => {
  test('the root is the list of folders, not a refusal', async () => {
    // The jail refuses `.` in a multi-folder workspace, which is right for a path and wrong
    // for a listing: `list_dir(".")` is the obvious first move and has to answer something.
    const r = await listDirTool.execute({ path: '.' }, { workspace: ws })
    expect(r.ok).toBe(true)
    expect(r.content).toContain('app/')
    expect(r.content).toContain('engine/')
    expect(r.content).toContain('refs/')
    expect(r.content).toContain('read-only reference')
  })

  test('a folder name lists that folder', async () => {
    const r = await listDirTool.execute({ path: 'engine' }, { workspace: ws })
    expect(r.ok).toBe(true)
    expect(r.content).toContain('src/')
  })
})

describe('Glob', () => {
  test('a pattern with no folder name searches every folder', async () => {
    const r = await findFilesTool.execute({ glob: '**/*.ts' }, { workspace: ws })
    expect(r.ok).toBe(true)
    expect(r.content.split('\n').sort()).toEqual(['app/src/main.ts', 'engine/src/boot.ts'])
  })

  test('a pattern that starts with a folder name searches only that folder', async () => {
    const r = await findFilesTool.execute({ glob: 'engine/**/*.ts' }, { workspace: ws })
    expect(r.ok).toBe(true)
    expect(r.content).toBe('engine/src/boot.ts')
  })

  test('a folder name on its own lists what is in it', async () => {
    const r = await findFilesTool.execute({ glob: 'refs' }, { workspace: ws })
    expect(r.ok).toBe(true)
    expect(r.content).toBe('refs/notes.md')
  })

  test('a single-folder workspace returns unprefixed paths, exactly as before', async () => {
    const single = new Workspace(mounts[0]!.root)
    const r = await findFilesTool.execute({ glob: '**/*.ts' }, { workspace: single })
    expect(r.content).toBe('src/main.ts')
  })
})

describe('Grep', () => {
  test('one search covers every folder, and each hit says which one', async () => {
    const r = await searchCodeTool.execute({ pattern: 'boot' }, { workspace: ws })
    expect(r.ok).toBe(true)
    const paths = r.content.split('\n').map((l) => l.split(':')[0])
    expect(paths).toContain('app/src/main.ts')
    expect(paths).toContain('engine/src/boot.ts')
    expect(paths).toContain('refs/notes.md')
  })

  test('a read-only folder is searched like any other — reading is the whole point of it', async () => {
    const r = await searchCodeTool.execute({ pattern: 'documented' }, { workspace: ws })
    expect(r.content).toContain('refs/notes.md')
  })

  test('scoping to a folder searches only it', async () => {
    const r = await searchCodeTool.execute({ pattern: 'boot', path: 'engine' }, { workspace: ws })
    expect(r.ok).toBe(true)
    expect(r.content).toContain('engine/src/boot.ts')
    expect(r.content).not.toContain('app/src/main.ts')
  })
})

describe('the system prompt', () => {
  test('names the folders and the addressing rule, and never a path on disk', () => {
    const prompt = buildSystemPrompt({
      workspaceRoot: mounts[0]!.root,
      mode: 'normal',
      folders: mounts.map((m) => ({ name: m.name, access: m.access })),
    })
    expect(prompt).toContain('app')
    expect(prompt).toContain('read-only reference')
    expect(prompt).toContain('app/src/thing.ts')
    expect(prompt).toContain('A path with no folder name is refused')
    // The disk layout is not the model's business and does not belong in a transcript.
    expect(prompt).not.toContain(mounts[1]!.root)
    expect(prompt).not.toContain(base)
  })

  test('a single folder produces the prompt it always did', () => {
    const before = buildSystemPrompt({ workspaceRoot: 'D:\\p', mode: 'normal' })
    const withOne = buildSystemPrompt({
      workspaceRoot: 'D:\\p', mode: 'normal', folders: [{ name: 'p', access: 'write' }],
    })
    expect(withOne).toBe(before)
    expect(before).toContain('working in the local workspace D:\\p')
  })
})

/**
 * Running a command in a workspace made of several folders.
 *
 * The reported symptom was three or four commands spent working out where the shell is and
 * what path `dotnet build` needs. The cause is that this workspace has TWO path languages and
 * nothing said so: a tool argument is folder-prefixed (`engine/Engine.csproj`), while the
 * text of a command is an ordinary shell path from wherever the shell started — which is the
 * FIRST folder. The first two tests below are the two halves of that, asserted rather than
 * described, so the shape cannot drift without something failing.
 */
describe('where a command runs', () => {
  const run = async (args: Record<string, unknown>) => {
    const v = runCommandTool.validate(args)
    if (!v.ok) throw new Error(`validate refused: ${v.error}`)
    return runCommandTool.execute(v.args, { workspace: ws })
  }

  test('a bare command starts in the first folder, and the reply says so', async () => {
    const r = await run({ command: '(Get-Location).Path' })
    expect(r.ok).toBe(true)
    // Canonicalised, because the two sides are spelled by different things: the shell prints
    // the name the filesystem reports, while `mounts[0].root` is however mkdtemp wrote it.
    // On a GitHub runner those differ — TEMP is under `RUNNER~1` and PowerShell answers
    // `runneradmin` — so written without this the test passed here and failed there. Which
    // is, exactly, the defect the code under test exists to fix.
    expect(r.content).toContain(canonicalize(mounts[0]!.root))
    // The part that closes the loop. Without it a wrong guess about the directory and a
    // genuinely missing file are the same reply, and the only way to tell them apart is
    // another command.
    expect(r.content).toContain('· in app/')
  }, 30_000)

  test('the folder prefix does NOT work inside the command text, and cwd is how you move',
    async () => {
      // Measured, and the reason the system prompt now spends three lines on it: this is
      // exactly what a model taught `engine/src/x.ts` will write first.
      const wrong = await run({ command: 'Test-Path engine/src/boot.ts' })
      expect(wrong.content).toContain('False')

      const right = await run({ command: 'Test-Path src/boot.ts', cwd: 'engine' })
      expect(right.content).toContain('True')
      expect(right.content).toContain('· in engine/')
    }, 30_000)

  test('a cwd without a folder name is refused, in words that say what to write instead',
    async () => {
      // The refusal is the one part of this that already taught the rule. It is asserted so
      // it stays that way: an error that only said "denied" would send the model back to
      // probing.
      const r = await run({ command: 'Get-Location', cwd: 'src' })
      expect(r.ok).toBe(false)
      expect(r.content).toContain('app')
      expect(r.content).toContain('engine')
    }, 30_000)

  test('a background task takes the same cwd, and the same refusal', async () => {
    // The pair has to agree. A `cwd` on one and not the other teaches the trick and then
    // takes it away: the model would be back to `cd ../engine; npm run dev` inside the
    // command, which is the same confusion somewhere harder to see.
    //
    // Driven through `execute`, not `validate`. Validate never touches the workspace, so a
    // test that stopped there would pass with the resolution wired to nothing.
    const tasks = new BackgroundTasks()
    const tool = backgroundTaskTool(tasks)
    const call = async (args: Record<string, unknown>) => {
      const v = tool.validate(args)
      if (!v.ok) throw new Error(`validate refused: ${v.error}`)
      return tool.execute(v.args, { workspace: ws })
    }
    try {
      const refused = await call({ action: 'start', command: 'Get-Location', cwd: 'src' })
      expect(refused.ok).toBe(false)
      expect(refused.content).toContain('app')
      expect(refused.content).toContain('engine')

      const started = await call({ action: 'start', command: 'Get-Location', cwd: 'engine' })
      expect(started.ok).toBe(true)
      const id = /id: (\S+?)\./.exec(started.content)?.[1]
      expect(id).toBeTruthy()
      const polled = await call({ action: 'poll', id, wait_seconds: 10 })
      expect(polled.content).toContain(canonicalize(mounts[1]!.root))
    } finally {
      await tasks.stopAll()
    }
  }, 30_000)

  test('the prompt states the rule the file-path rule contradicts', () => {
    const prompt = buildSystemPrompt({
      workspaceRoot: mounts[0]!.root,
      mode: 'normal',
      folders: mounts.map((m) => ({ name: m.name, access: m.access })),
    })
    expect(prompt).toContain('A command starts in app/ unless you set cwd')
    expect(prompt).toContain('plain shell paths')
    // Still no disk paths, which the block above this one also guards.
    expect(prompt).not.toContain(base)
  })
})

describe('the delegation paragraph', () => {
  test('appears only when a worker is actually on offer', () => {
    // Of five framings measured live, this is the one that moved the choice (8/12 against
    // three 0/6s), so it ships — but only beside a callable tool. A prompt telling the
    // model to delegate in plan mode, where the tool is filtered out, would be an
    // instruction to do the impossible.
    const withIt = buildSystemPrompt({ workspaceRoot: 'D:\p', mode: 'normal', delegation: true })
    expect(withIt).toContain('your FIRST call is Agent')

    const without = buildSystemPrompt({ workspaceRoot: 'D:\p', mode: 'normal' })
    expect(without).not.toContain('FIRST call is Agent')
    expect(without).toBe(buildSystemPrompt({ workspaceRoot: 'D:\p', mode: 'normal', delegation: false }))
  })
})
