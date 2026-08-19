import { execa } from 'execa'

/**
 * The working tree, for the window.
 *
 * Distinct from `git_status`, which is the MODEL's read-only tool and returns prose for a
 * context window. This returns structure for a panel, and it can commit — the one thing the
 * model's tool deliberately cannot do.
 *
 * Why committing belongs here and not there: a commit is the moment work becomes permanent,
 * and the person is the one who decides that. Handing the model a commit tool would put the
 * decision inside a turn, where it would be made by whatever the model concluded from the
 * last tool result. The window's version is a button a human presses over a message a human
 * can read and edit first.
 *
 * Every call is `git` with a fixed argv in the workspace directory. Paths from the UI are
 * passed after `--`, so a file named like a flag cannot become one.
 */

export interface GitFileChange {
  path: string
  /** Porcelain XY, e.g. ` M`, `??`, `A `, `MM`. Kept raw so the caller can label it. */
  code: string
  staged: boolean
  untracked: boolean
  /** A rename's OLD path. The index holds two entries for a rename — the deletion of the
   * old name and the addition of the new — and unstaging only the new one would leave a
   * pure deletion staged, which is not what "take it out of the commit" means. */
  oldPath?: string
}

async function git(cwd: string, args: string[], timeout = 15_000) {
  return execa('git', args, { cwd, reject: false, timeout, windowsHide: true })
}

/** Splits porcelain v1 output. The first two characters are the status pair; a rename
 * carries `old -> new` and is reported by its NEW path, which is the one on disk. */
export function parsePorcelain(stdout: string): { branch: string | null; files: GitFileChange[] } {
  let branch: string | null = null
  const files: GitFileChange[] = []

  for (const line of stdout.split('\n')) {
    if (line === '') continue
    if (line.startsWith('## ')) {
      // `## main...origin/main [ahead 1]` or `## HEAD (no branch)`
      branch = line.slice(3).split('...')[0]!.split(' ')[0] ?? null
      continue
    }
    const code = line.slice(0, 2)
    const rest = line.slice(3)
    const arrow = rest.indexOf(' -> ')
    const path = arrow === -1 ? rest : rest.slice(arrow + 4)
    const oldPath = arrow === -1 ? undefined : rest.slice(0, arrow).replace(/^"|"$/g, '')
    files.push({
      path: path.replace(/^"|"$/g, ''),
      code,
      staged: code[0] !== ' ' && code[0] !== '?',
      untracked: code === '??',
      ...(oldPath !== undefined ? { oldPath } : {}),
    })
  }
  return { branch, files }
}

/**
 * The unified diff for one path, working tree against HEAD.
 *
 * An untracked file has no HEAD side to diff against, so git says nothing about it at all —
 * which in a panel reads as "no changes" for a file that is entirely new. `--no-index`
 * against the null device produces the real answer: every line, added.
 */
export async function gitDiff(cwd: string, path: string, untracked: boolean): Promise<string> {
  const result = untracked
    ? await git(cwd, ['diff', '--no-index', '--', '/dev/null', path])
    : await git(cwd, ['diff', 'HEAD', '--', path])
  // `--no-index` exits 1 when the files differ, which is the normal case here.
  return result.stdout
}

export interface GitActionResult {
  ok: boolean
  problem?: string
}

/**
 * Stages the named paths — `git add`, nothing more. The index is real state the user can
 * see (staged rows highlight in the tree), so staging and committing are two separate
 * decisions here, the way they are in git itself.
 */
export async function gitStage(cwd: string, paths: readonly string[]): Promise<GitActionResult> {
  if (paths.length === 0) return { ok: false, problem: 'nothing to stage' }
  const result = await git(cwd, ['add', '--', ...paths])
  return result.exitCode === 0
    ? { ok: true }
    : { ok: false, problem: result.stderr.trim() || 'git add failed' }
}

/**
 * Takes the named paths back out of the index. `git reset` needs a HEAD to reset to, which
 * a repository with no commits yet does not have — there the index entry itself is removed
 * (`rm --cached`), which is the same end state: the file is on disk, and not staged.
 */
export async function gitUnstage(cwd: string, paths: readonly string[]): Promise<GitActionResult> {
  if (paths.length === 0) return { ok: false, problem: 'nothing to unstage' }
  const reset = await git(cwd, ['reset', '-q', 'HEAD', '--', ...paths])
  if (reset.exitCode === 0) return { ok: true }
  const rm = await git(cwd, ['rm', '--cached', '-r', '-q', '--', ...paths])
  return rm.exitCode === 0
    ? { ok: true }
    : { ok: false, problem: reset.stderr.trim() || rm.stderr.trim() || 'git reset failed' }
}

/** Every path currently in the index, repo-relative. Read through `status --porcelain`
 * rather than `diff --cached` because porcelain also behaves on a repository whose HEAD
 * is unborn — the empty-repo case the panel must not crash on. */
export async function stagedPaths(cwd: string): Promise<string[]> {
  const result = await git(cwd, ['status', '--porcelain=v1'])
  if (result.exitCode !== 0) return []
  return parsePorcelain(result.stdout).files.filter((f) => f.staged).map((f) => f.path)
}

export interface GitCommitResult {
  ok: boolean
  /** Short sha on success. */
  sha?: string
  message?: string
  problem?: string
}

/**
 * Commits the INDEX — exactly what is staged, never more.
 *
 * The old version took a selection of paths and did `add` + `commit -- paths` in one
 * breath, which made the index invisible and the checkbox column the real staging area.
 * Now staging is its own visible act on the tree, and this commits what the user built
 * there. No `-a`, no pathspec: `commit -- paths` would take the WORKING TREE content of
 * those paths and silently defeat a partial staging.
 */
export async function gitCommitStaged(cwd: string, message: string): Promise<GitCommitResult> {
  if (message.trim() === '') return { ok: false, problem: 'a commit needs a message' }

  const commit = await git(cwd, ['commit', '-m', message], 30_000)
  if (commit.exitCode !== 0) {
    return { ok: false, problem: (commit.stderr.trim() || commit.stdout.trim()) || 'git commit failed' }
  }
  const head = await git(cwd, ['rev-parse', '--short', 'HEAD'])
  return {
    ok: true,
    ...(head.exitCode === 0 ? { sha: head.stdout.trim() } : {}),
    message: commit.stdout.trim().split('\n')[0] ?? '',
  }
}

/**
 * A commit message derived from the files themselves.
 *
 * Deliberately NOT generated by the model. A generation is a turn against a single-slot
 * server: pressing Commit would wait thirty seconds for a sentence the person is going to
 * rewrite anyway, and it would compete with whatever the agent is doing. This is a starting
 * point in an editable field, which is what a default is for.
 */
export function suggestCommitMessage(files: readonly GitFileChange[]): string {
  if (files.length === 0) return ''
  if (files.length === 1) {
    const only = files[0]!
    const verb = only.untracked ? 'add' : 'update'
    return `${verb} ${only.path}`
  }
  const dirs = new Set(files.map((f) => (f.path.includes('/') ? f.path.split('/')[0]! : '.')))
  const where = dirs.size === 1 ? ` in ${[...dirs][0]}` : ''
  return `update ${files.length} files${where}`
}
