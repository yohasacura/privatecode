import type { GitRepoView } from '@core/host/protocol'

/**
 * Git, as the tree wears it.
 *
 * The working tree used to be its own section under the file tree — a second list of the
 * same files, with checkboxes. The owner's ruling: git lives ON the files. Each changed
 * file carries one letter on its row (the way editors do it), a staged file's row
 * highlights (staging is the selection), and the letter's shape is the Changes/Staged
 * distinction the panel never had.
 */

export type GitLetter = 'M' | 'A' | 'D' | 'R' | 'U' | '!'

export interface GitMark {
  letter: GitLetter
  /** In the index — this file is part of the next commit, and its row highlights.
   * NEVER true for a conflict (`!`), however porcelain's index column reads: see
   * `gitMarks`. */
  staged: boolean
  /** The worktree still differs from the index — there is something left to stage.
   * `MM` is both: staged once, edited again since. */
  dirty: boolean
  untracked: boolean
  /** The repository that owns it — what a stage/unstage call is addressed through. */
  repoRoot: string
  /** A rename's OLD path: unstaging must send both names, or the old name's staged
   * deletion survives alone and the next commit deletes the file. */
  oldPath?: string
}

/**
 * One letter per file, the convention every editor taught people: M-odified, A-dded,
 * D-eleted, R-enamed, U-ntracked, and `!` for a conflict, which is the one state that
 * must not look routine.
 */
export function letterOf(code: string): GitLetter {
  if (code === '??') return 'U'
  // Conflict pairs: both sides touched it. `AA`/`DD` are conflicts too, not add/delete.
  if (code.includes('U') || code === 'AA' || code === 'DD') return '!'
  const index = code[0] ?? ' '
  const work = code[1] ?? ' '
  const c = work !== ' ' ? work : index
  switch (c) {
    case 'A': return 'A'
    case 'D': return 'D'
    case 'R': return 'R'
    case 'C': return 'A'
    default: return 'M'
  }
}

/** Every changed file across every repository, keyed by its workspace-addressed path. */
export function gitMarks(repos: readonly GitRepoView[]): ReadonlyMap<string, GitMark> {
  const marks = new Map<string, GitMark>()
  for (const repo of repos) {
    for (const f of repo.files) {
      const letter = letterOf(f.code)
      marks.set(f.path, {
        letter,
        // A conflict is its own state, never "staged" — decided HERE so every surface
        // that reads a mark tells the same story. Porcelain gives `UU`/`AA`/`DD` a
        // non-space index column, so the host reports them staged; the mark used to copy
        // that through, and a single conflicted file got the "chosen for the commit"
        // accent bar on its row while the commit box two inches above it — which filters
        // conflicts out of its count, Stage all and Unstage all — read "Nothing staged
        // yet" and refused to commit.
        staged: f.staged && letter !== '!',
        dirty: f.untracked || (f.code[1] !== undefined && f.code[1] !== ' '),
        untracked: f.untracked,
        repoRoot: repo.root,
        ...(f.oldPath !== undefined ? { oldPath: f.oldPath } : {}),
      })
    }
  }
  return marks
}

/** A deleted file has no row in a tree that lists the disk — so it gets a GHOST row in
 * its parent directory: struck through, still carrying its letter and its diff. Without
 * this, the one change you most want to notice is the one the tree cannot show. */
export interface GhostRow {
  name: string
  path: string
}

/**
 * Ghost rows grouped by parent directory (`''` is the root). Sources: git's `D` files,
 * and the session's own deletions — which also covers workspaces under no version
 * control. A path present in both appears once.
 */
export function ghostRows(
  marks: ReadonlyMap<string, GitMark>,
  sessionDeleted: readonly string[],
): ReadonlyMap<string, GhostRow[]> {
  const dead = new Set<string>()
  for (const [path, mark] of marks) {
    if (mark.letter === 'D') dead.add(path)
  }
  for (const path of sessionDeleted) dead.add(path)

  const byDir = new Map<string, GhostRow[]>()
  for (const path of dead) {
    const cut = path.lastIndexOf('/')
    const dir = cut === -1 ? '' : path.slice(0, cut)
    const name = cut === -1 ? path : path.slice(cut + 1)
    const list = byDir.get(dir) ?? []
    list.push({ name, path })
    byDir.set(dir, list)
  }
  for (const list of byDir.values()) list.sort((a, b) => a.name.localeCompare(b.name))
  return byDir
}

/** What a mark's tooltip says — the row has one letter, the hover has the words. */
export function describeMark(mark: GitMark): string {
  const what = {
    M: 'modified', A: 'added', D: 'deleted', R: 'renamed', U: 'untracked — new file',
    '!': 'CONFLICT — resolve it before committing',
  }[mark.letter]
  // No staged/not-staged clause for a conflict: neither word is true of it. It cannot be
  // in the commit, and "not staged" would read as an invitation to press a `+` the row
  // deliberately does not offer (staging a conflict declares it resolved with the markers
  // still in the file). The letter's own words are the whole story.
  if (mark.letter === '!') return what
  if (mark.staged && mark.dirty) return `${what} · staged, then edited again — the newer edit is not in the commit yet`
  if (mark.staged) return `${what} · staged for the next commit`
  return `${what} · not staged`
}
