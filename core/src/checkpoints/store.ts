import { execa } from 'execa'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ensurePrivateDir, PRIVATE_DIR, statePath } from '../private-dir.js'
import type { SnapshotUnit } from './units.js'

/**
 * A snapshot of the workspace before and after every turn, so a long unattended run can be
 * undone rather than merely regretted.
 *
 * It is a real git repository — just not the user's. `GIT_DIR` points at
 * `.privatecode/checkpoints.git` and `GIT_WORK_TREE` at the workspace root, which buys four
 * things that a hand-rolled snapshot format would each have to earn separately:
 *
 * - It never touches the user's own `.git`. Git refuses to descend into a directory named
 *   `.git`, so their repository is invisible to this one; their index, their stash and their
 *   uncommitted work are not involved at any point.
 * - It works in a workspace that is not a repository at all, which is most of the ones worth
 *   protecting.
 * - It honours their `.gitignore` for free, so a checkpoint does not swallow build output.
 * - `diff --stat` between any two points comes for nothing, and the work log is built on it.
 *
 * The history lives under `.privatecode/`, which the permission engine denies to every
 * model-issued write. That is what makes this an undo the agent cannot quietly rewrite.
 */

export interface Checkpoint {
  /** Short commit id — the handle every other method and the protocol use. */
  id: string
  at: string
  /** Which turn this captures the result of. Absent for the session baseline. */
  sessionId?: string
  turn?: number
  /**
   * Which step of that turn, for a snapshot taken while the turn was STILL RUNNING; absent
   * on the one taken when it ended.
   *
   * This is what tells them apart in a list. A turn used to contribute exactly one
   * checkpoint, so `turn 3` identified a point; now a long turn contributes several, and
   * without this they would all read as "turn 3" — several identical-looking rows to choose
   * a rewind from, which is worse than not offering the choice.
   */
  step?: number
  /** One line for a list: `3 files, +42 -7`, or `baseline`. */
  summary: string
}

/**
 * Applied ON TOP of the user's own `.gitignore`, never instead of it.
 *
 * It exists for the case that motivates the whole feature: a workspace that is not a git
 * repository, and therefore has no ignore rules at all. Without this the first checkpoint of
 * an ordinary node project would try to snapshot forty thousand files in `node_modules`, and
 * the feature would be unusable exactly where it is most needed.
 */
const DEFAULT_EXCLUDES = [
  '# Written by PrivateCode. Applied in addition to the workspace\'s own .gitignore.',
  'node_modules/',
  'bower_components/',
  'vendor/bundle/',
  'target/',
  'dist/',
  'build/',
  'out/',
  '.next/',
  '.nuxt/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '*.pyc',
  '.gradle/',
  '.terraform/',
  '*.log',
  '',
].join('\n')

const CHECKPOINT_DIR = 'checkpoints.git'
const EXCLUDE_FILE = 'checkpoints.exclude'

/** A snapshot of a large workspace is seconds, not minutes; past this something is wrong. */
const GIT_TIMEOUT_MS = 120_000

/** Author identity for the shadow repo. Set per-command so a missing global git config —
 * common on a fresh machine — cannot make `commit` fail. */
const IDENTITY = [
  '-c', 'user.name=PrivateCode',
  '-c', 'user.email=privatecode@localhost',
  // A user's `commit.gpgsign=true` would otherwise make every checkpoint prompt for a
  // passphrase, in a repository they will never push.
  '-c', 'commit.gpgsign=false',
]

export class CheckpointStore {
  readonly problems: string[] = []
  readonly root: string
  private readonly gitDir: string
  /** Where `.privatecode/` lives. The same as `root` for a plain workspace; the PRIMARY
   * folder for an attached one, so nothing of ours is ever written into someone else's
   * project just because they let the agent work there. */
  private readonly stateRoot: string
  /** Generated exclusions — the nested repositories this unit must not swallow. Written to
   * `$GIT_DIR/info/exclude` on every init, because the shape of a workspace changes. */
  private readonly excluded: readonly string[]
  /**
   * Repositories found the hard way: git refused to index one (a clone with no commit yet
   * — "does not have a commit checked out", which fails the WHOLE `add -A` and with it every
   * checkpoint), or would have swallowed one as a gitlink. The unit scan does not walk
   * `vendor/`, `build/` and the like, so a repository there is invisible to it; git sees it
   * anyway. Kept in `info/exclude` under its own marker so a launch does not rediscover them.
   */
  private discovered: string[] = []
  private ready: boolean | null = null

  constructor(spec: string | SnapshotUnit) {
    if (typeof spec === 'string') {
      this.root = spec
      this.stateRoot = spec
      this.gitDir = statePath(spec, CHECKPOINT_DIR)
      this.excluded = []
      return
    }
    this.root = spec.root
    this.stateRoot = spec.stateRoot
    this.gitDir = spec.gitDir
    this.excluded = spec.excluded
  }

  /**
   * Whether checkpoints can be taken here at all.
   *
   * Resolved once, lazily, and remembered. A missing git, or a workspace this process cannot
   * write to, DEGRADES the feature: every other method becomes a no-op and one problem is
   * recorded. Losing the undo history is bad; refusing to run a session because of it would
   * be worse.
   */
  async available(): Promise<boolean> {
    if (this.ready !== null) return this.ready
    this.ready = await this.init()
    return this.ready
  }

  /**
   * Snapshots the work tree, or returns `null` when nothing changed.
   *
   * `null` is not a failure and callers must treat it as ordinary: a turn that only read
   * files changes nothing, and the previous checkpoint already describes that state exactly.
   */
  async take(label: { sessionId?: string; turn?: number; step?: number } = {}): Promise<Checkpoint | null> {
    if (!(await this.available())) return null

    // `step` names a snapshot taken WHILE a turn is still running. A turn used to be at most
    // forty steps, so one checkpoint at the end of it was never more than a few minutes of
    // work; now a turn can run for hours, and a single point to come back to across all of
    // it is not an undo. See `Session`'s mid-turn checkpoint.
    const message = label.turn === undefined
      ? 'baseline'
      : `turn ${label.turn}${label.step !== undefined ? ` step ${label.step}` : ''}` +
        `${label.sessionId ? ` (${label.sessionId})` : ''}`

    if (!(await this.addAll())) return null

    // An EMPTY baseline is allowed, and only the baseline.
    //
    // A brand-new project is an empty folder, so the session's first `take({})` had nothing
    // to commit and returned null — and with no commits in the repo, `list(1)` was empty too.
    // The session therefore had no baseline at all, and "Put back" could never work in the
    // one workspace where it matters most: the one the agent built from nothing. There was no
    // commit representing "nothing existed yet", so there was nothing to restore to.
    //
    // `--allow-empty` makes that state representable. `restoreFile` already deletes a file
    // absent from the target checkpoint, which is exactly right against an empty root: the
    // file did not exist then, so putting it back means removing it.
    //
    // Confined to the baseline (`label.turn === undefined`) on purpose. Letting every
    // read-only turn commit an empty snapshot would fill History with rows that describe
    // nothing, which is what returning null for an unchanged tree exists to avoid.
    const isBaseline = label.turn === undefined
    const commit = await this.git(
      [...IDENTITY, 'commit', '--quiet', ...(isBaseline ? ['--allow-empty'] : []), '-m', message],
      { allowFail: true },
    )
    // `commit` exits non-zero with "nothing to commit" when the tree is unchanged, which is
    // the common case for a read-only turn -- distinguished from a real failure by asking
    // git whether anything is staged rather than by parsing its prose.
    if (commit === null) {
      const pending = await this.git(['diff', '--cached', '--name-only'])
      if (pending === null || pending.trim() === '') return null
      this.problems.push('a checkpoint could not be committed; the workspace is not being snapshotted')
      return null
    }

    const head = await this.git(['rev-parse', '--short', 'HEAD'])
    if (head === null) return null
    const id = head.trim()
    return {
      id,
      at: new Date().toISOString(),
      ...(label.sessionId !== undefined ? { sessionId: label.sessionId } : {}),
      ...(label.turn !== undefined ? { turn: label.turn } : {}),
      summary: await this.summarize(id),
    }
  }

  /**
   * Newest first, each with the size of what it captured.
   *
   * `--shortstat` in the same `log` call rather than a `show` per entry: the summary a
   * person reads is "3 files, +42 -7", and fetching that one commit at a time would be
   * fifty git invocations to draw one panel. The first version skipped it entirely and
   * showed the raw commit subject — `turn 1 (s-20260804-151432-6895)` — which is the
   * session id, in a panel about files.
   */
  async list(limit = 50): Promise<Checkpoint[]> {
    if (!(await this.available())) return []
    const out = await this.git([
      'log', '-n', String(limit), '--format=%x1e%h%x1f%aI%x1f%s', '--shortstat',
    ], { allowFail: true })
    if (out === null) return [] // a repository with no commits yet

    const entries: Checkpoint[] = []
    // `%x1e` starts each record, so a commit's own shortstat lines stay attached to it.
    for (const record of out.split('')) {
      if (record.trim() === '') continue
      const [header, ...rest] = record.split('\n')
      const [id, at, subject] = (header ?? '').split('')
      if (!id || !at) continue
      const turn = /^turn (\d+)/.exec(subject ?? '')
      const step = /^turn \d+ step (\d+)/.exec(subject ?? '')
      entries.push({
        id,
        at,
        ...(turn ? { turn: Number(turn[1]) } : {}),
        ...(step ? { step: Number(step[1]) } : {}),
        summary: shortstatLabel(rest.join('\n')),
      })
    }
    return entries
  }

  /** `git diff --stat`, from one checkpoint to another (default: to the working tree). */
  async diffStat(from: string, to?: string): Promise<string> {
    if (!(await this.available())) return ''
    const range = to === undefined ? [from] : [from, to]
    return (await this.git(['diff', '--stat', ...range], { allowFail: true })) ?? ''
  }

  /**
   * Restores the work tree to `id`.
   *
   * The order below is the entire safety argument. The current state is snapshotted FIRST,
   * so a rewind is itself undoable — the failure this guards against is someone rewinding to
   * the wrong checkpoint and losing an hour of good work along with the bad.
   *
   * `git clean -fd` and NOT `-x`: ignored files (`node_modules/`, build output) are left
   * alone, so a rewind never costs a rebuild. What it does delete is files created since the
   * checkpoint — which is the point, and why this is only ever a person's explicit act.
   */
  async rewind(id: string): Promise<{ restored: Checkpoint; undo: Checkpoint }> {
    if (!(await this.available())) {
      throw new Error('checkpoints are not available in this workspace')
    }
    const known = await this.git(['cat-file', '-t', id], { allowFail: true })
    if (known === null || known.trim() !== 'commit') {
      throw new Error(`no checkpoint "${id}"`)
    }

    // Where "back" is. `take()` returns null when nothing has changed since the last
    // checkpoint, which is the NORMAL case here — a rewind usually follows a turn that was
    // just snapshotted — and it does not mean there is nowhere to return to: the existing
    // HEAD already describes this exact state. Reporting `null` there would have told the
    // user their rewind was one-way at the moment it was most obviously not.
    const undo = (await this.take({})) ?? (await this.head())
    if (undo === null) throw new Error('the checkpoint store has no history to return to')
    await this.resetTo(id)

    return {
      restored: { id, at: new Date().toISOString(), summary: await this.summarize(id) },
      undo,
    }
  }

  /**
   * The reset half of `rewind`, for a caller that has already taken its own undo point.
   *
   * `CheckpointSet` takes ONE undo point across every unit before it starts, so letting each
   * unit's `rewind` take another would leave a trail of per-unit commits that belong to no
   * checkpoint anyone can name.
   */
  async resetTo(id: string): Promise<void> {
    if (!(await this.available())) {
      throw new Error('checkpoints are not available in this workspace')
    }
    if ((await this.git(['reset', '--hard', '--quiet', id])) === null) {
      throw new Error(`could not restore checkpoint ${id}`)
    }
    await this.git(['clean', '-fd', '--quiet'], { allowFail: true })
  }

  /** This unit's current checkpoint, or `null` in a store with no history yet. */
  async headCheckpoint(): Promise<Checkpoint | null> {
    if (!(await this.available())) return null
    return this.head()
  }

  /**
   * Puts ONE file back to how it was at `id`, leaving everything else alone.
   *
   * The whole-workspace `rewind` is the right tool when a turn went wrong; it is the wrong
   * one when a turn got four files right and the fifth wrong, which is the common case and
   * the one that used to have no answer except reverting all five and asking again.
   *
   * A file that did not EXIST at that checkpoint is deleted rather than left behind: "put it
   * back as it was" and "as it was, there was no such file" are the same sentence, and
   * leaving a stray new file is how a revert quietly does not revert.
   */
  async restoreFile(id: string, path: string): Promise<{ removed: boolean }> {
    if (!(await this.available())) {
      throw new Error('checkpoints are not available in this workspace')
    }
    const known = await this.git(['cat-file', '-t', id], { allowFail: true })
    if (known === null || known.trim() !== 'commit') {
      throw new Error(`no checkpoint "${id}"`)
    }

    const existed = await this.git(['cat-file', '-e', `${id}:${path}`], { allowFail: true })
    if (existed === null) {
      // Not in that checkpoint: the file is new since, so putting it back means removing it.
      await this.git(['rm', '-f', '--quiet', '--ignore-unmatch', '--', path], { allowFail: true })
      rmSync(join(this.root, path), { force: true })
      return { removed: true }
    }
    if ((await this.git(['checkout', id, '--', path])) === null) {
      throw new Error(`could not restore ${path} from ${id}`)
    }
    return { removed: false }
  }

  // ---------------------------------------------------------------------------------------

  private async init(): Promise<boolean> {
    try {
      await execa('git', ['--version'], { timeout: 10_000, windowsHide: true })
    } catch {
      this.problems.push('git was not found, so this session keeps no checkpoints and cannot roll back')
      return false
    }
    try {
      ensurePrivateDir(this.stateRoot)
      const excludePath = join(this.stateRoot, PRIVATE_DIR, EXCLUDE_FILE)
      // Written once and never rewritten: a user who edits it keeps their edit, the same
      // contract `ensurePrivateDir` uses for its own .gitignore.
      if (!existsSync(excludePath)) writeFileSync(excludePath, DEFAULT_EXCLUDES, 'utf8')

      if (!existsSync(join(this.gitDir, 'HEAD'))) {
        const init = await execa('git', ['init', '--quiet', '--bare', this.gitDir], {
          timeout: GIT_TIMEOUT_MS, windowsHide: true, reject: false,
        })
        if (init.exitCode !== 0) {
          this.problems.push(`could not create the checkpoint store: ${init.stderr || 'git init failed'}`)
          return false
        }
        // `--bare` gives a repository with no work tree of its own, which is exactly right:
        // the work tree is supplied per command and is the user's workspace.
        await execa('git', ['--git-dir', this.gitDir, 'config', 'core.bare', 'false'], {
          timeout: GIT_TIMEOUT_MS, windowsHide: true, reject: false,
        })
        // A snapshot store wants byte-for-byte fidelity, and git's line-ending translation
        // is the opposite of that. `core.autocrlf=true` is the Windows default and is set
        // globally on this machine: with it, a rewind rewrites the line endings of every
        // file it restores — a "put it back" that silently changes every line of the
        // workspace. Caught by a test asserting the exact bytes came back.
        for (const [key, value] of [['core.autocrlf', 'false'], ['core.eol', 'native'], ['core.safecrlf', 'false']]) {
          await execa('git', ['--git-dir', this.gitDir, 'config', key!, value!], {
            timeout: GIT_TIMEOUT_MS, windowsHide: true, reject: false,
          })
        }
      }

      // Set on every init rather than only at creation, for the same reason `info/exclude`
      // just below is: a path baked in once goes stale silently. It pointed at an absolute
      // path written when the store was created, so anything that moved this folder
      // afterwards left every exclusion switched off with no symptom — which is the
      // "a checkpoint swallowed my build output" failure, arriving without a message.
      await execa('git', ['--git-dir', this.gitDir, 'config', 'core.excludesFile', excludePath], {
        timeout: GIT_TIMEOUT_MS, windowsHide: true, reject: false,
      })

      // Rewritten on every init rather than only at creation: someone clones a repository
      // into their project and the set of nested repositories has changed. A stale exclusion
      // list is the gitlink hole again, silently. What survives the rewrite is the section
      // of repositories git itself turned up (`addAll`), read back before it is written.
      this.discovered = this.readDiscovered()
      this.writeExclude()
      return true
    } catch (e) {
      this.problems.push(`checkpoints are unavailable: ${(e as Error).message}`)
      return false
    }
  }

  /** The checkpoint the work tree currently sits on, or `null` in an empty repository. */
  private async head(): Promise<Checkpoint | null> {
    const out = await this.git(['log', '-n', '1', '--format=%h%x1f%aI%x1f%s'], { allowFail: true })
    if (out === null || out.trim() === '') return null
    const [id, at, subject] = out.trim().split('')
    if (!id || !at) return null
    return { id, at, summary: subject ?? '' }
  }

  /**
   * `git add -A`, made to survive the repositories the unit scan cannot see.
   *
   * Two things git says about an embedded repository, both read from stderr because git has
   * no other channel for them. `error: 'vendor/x/' does not have a commit checked out` is a
   * clone without a commit yet; it fails the whole add, and with it every checkpoint of the
   * workspace — reported as "checkpoints are not created when there are git repositories in
   * the folders". `warning: adding embedded git repository: vendor/y` is a repository with
   * commits, recorded as a gitlink that a rewind cannot restore inside. Either way the answer
   * is the same: exclude the path, drop any gitlink already in the index, add again, and say
   * so once. The exclusion persists (`info/exclude`), so the next launch does not repeat it.
   */
  private async addAll(): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const r = await this.run(['add', '-A'])
      const found = new Set<string>()
      for (const m of r.stderr.matchAll(/^error: '(.+?)\/?' does not have a commit checked out$/gm)) found.add(m[1]!)
      for (const m of r.stderr.matchAll(/^warning: adding embedded git repository: (.+)$/gm)) found.add(m[1]!.trim())
      const fresh = [...found].map((p) => `/${p.replace(/\\/g, '/').replace(/\/+$/, '')}/`).filter((p) => !this.excluded.includes(p) && !this.discovered.includes(p))
      if (fresh.length === 0 || attempt === 1) {
        if (r.exitCode !== 0) {
          this.problems.push(`checkpoint git add failed: ${r.stderr || `exit ${r.exitCode}`}`)
          return false
        }
        return true
      }
      this.discovered.push(...fresh)
      this.writeExclude()
      for (const p of fresh) {
        // A gitlink git has already put in the index stays there until it is told to go;
        // the exclusion only stops it being added again.
        // `-f`: a gitlink git just staged counts as "staged content different from both the
        // file and HEAD", and without force `rm --cached` refuses to drop it.
        await this.run(['rm', '--cached', '-f', '-q', '-r', '--ignore-unmatch', '--', p.slice(1, -1)])
        this.problems.push(`${p.slice(1, -1)} is a git repository of its own inside this folder; checkpoints leave it out, and a rewind does not restore anything inside it`)
      }
    }
    return false
  }

  private static readonly DISCOVERED_MARKER = '# discovered: repositories git refused to index or would have swallowed; found while snapshotting'

  /** What a previous launch discovered, from the section under the marker; nothing else. */
  private readDiscovered(): string[] {
    try {
      const text = readFileSync(join(this.gitDir, 'info', 'exclude'), 'utf8')
      const at = text.indexOf(CheckpointStore.DISCOVERED_MARKER)
      if (at === -1) return []
      return text.slice(at + CheckpointStore.DISCOVERED_MARKER.length).split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'))
    } catch {
      return []
    }
  }

  private writeExclude(): void {
    const infoExclude = join(this.gitDir, 'info', 'exclude')
    mkdirSync(dirname(infoExclude), { recursive: true })
    writeFileSync(
      infoExclude,
      '# Generated by PrivateCode. These directories are their own git repositories and\n' +
      '# are snapshotted separately; a checkpoint that swallowed one would record a\n' +
      '# pointer to a commit instead of its files, and a rewind would restore nothing\n' +
      '# inside it. Edit .privatecode/checkpoints.exclude instead — this file is rewritten.\n' +
      // Our own directory, named rather than relied upon. It is already hidden by the `*`
      // in its own `.gitignore`, and that is exactly the kind of load-bearing coincidence
      // worth removing: an exclusion that holds only because a courtesy file happens to
      // exist is one edit away from silently not holding, and the symptom would be a
      // checkpoint quietly swallowing every session file in the workspace.
      `${PRIVATE_DIR}/\n` +
      this.excluded.map((e) => `${e}\n`).join('') +
      `${CheckpointStore.DISCOVERED_MARKER}\n` +
      this.discovered.map((e) => `${e}\n`).join(''),
      'utf8',
    )
  }

  /** One git command against the shadow repo, with everything it said. */
  private async run(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    try {
      const r = await execa('git', ['--git-dir', this.gitDir, '--work-tree', this.root, ...args], {
        cwd: this.root, timeout: GIT_TIMEOUT_MS, windowsHide: true, reject: false,
      })
      return { exitCode: r.exitCode ?? 1, stdout: r.stdout, stderr: r.stderr }
    } catch (e) {
      return { exitCode: 1, stdout: '', stderr: (e as Error).message }
    }
  }

  /** Runs one git command against the shadow repo. `null` means it failed. */
  private async git(args: string[], opts: { allowFail?: boolean } = {}): Promise<string | null> {
    try {
      const result = await execa('git', ['--git-dir', this.gitDir, '--work-tree', this.root, ...args], {
        cwd: this.root,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        reject: false,
      })
      if (result.exitCode !== 0) {
        if (!opts.allowFail) {
          this.problems.push(`checkpoint git ${args[0]} failed: ${result.stderr || `exit ${result.exitCode}`}`)
        }
        return null
      }
      return result.stdout
    } catch (e) {
      if (!opts.allowFail) this.problems.push(`checkpoint git ${args[0]} failed: ${(e as Error).message}`)
      return null
    }
  }

  /**
   * `3 files, +42 -7`, from the SAME command `list` uses.
   *
   * `git show --shortstat` was the obvious choice and is subtly different: on a ROOT commit
   * it prints no stat at all, while `git log --shortstat` prints the whole tree. So the
   * baseline read "baseline" when it was taken and "1 file, +1 -0" when it was listed —
   * the same checkpoint described two ways depending on which screen you were looking at.
   * A test comparing the two caught it.
   */
  private async summarize(id: string): Promise<string> {
    const stat = await this.git(['log', '-n', '1', '--format=', '--shortstat', id], { allowFail: true })
    return shortstatLabel(stat ?? '')
  }
}

/**
 * Turns git's `--shortstat` line into the phrase the panel shows.
 *
 * Shared by `take` and `list` so the same checkpoint cannot read one way when it is created
 * and another way when it is listed. An empty stat is the first commit in the repository:
 * everything is new, nothing is a change, and "baseline" is what that is.
 */
function shortstatLabel(stat: string): string {
  const line = stat.trim().split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? ''
  if (line === '') return 'baseline'
  const files = /(\d+) files? changed/.exec(line)?.[1]
  const added = /(\d+) insertions?/.exec(line)?.[1] ?? '0'
  const removed = /(\d+) deletions?/.exec(line)?.[1] ?? '0'
  return files ? `${files} file${files === '1' ? '' : 's'}, +${added} -${removed}` : line
}
