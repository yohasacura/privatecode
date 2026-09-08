import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execa } from 'execa'
import type { GitFileChange } from './git.js'

/**
 * The repository, for the window — everything Visual Studio's Git Changes and Git Repository
 * windows do, as fixed-argv calls to the machine's `git`.
 *
 * The one rule every function keeps: git decides, this module reports. Nothing here
 * re-implements a merge or a rebase; it runs the command, reads the exit code and the
 * words, and hands back a structure the panel can act on — `conflict: true` rather than a
 * wall of stderr, `behindRemote: true` rather than "hint: Updates were rejected". Paths from
 * the UI are passed after `--`, so a file named like a flag cannot become one.
 *
 * Network calls never prompt: `GIT_TERMINAL_PROMPT=0` turns a hung "Username for" into a
 * refusal that names the remote, and the credential manager Git for Windows ships still
 * gets its own window. Messages are read in English (`LC_ALL=C`) because they are matched.
 */

const RECORD = String.fromCharCode(0x1e)
const FIELD = String.fromCharCode(0x1f)
/** git's well-known empty tree: the parent a root commit is diffed against. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const NET_TIMEOUT_MS = 180_000

export interface GitOutcome {
  ok: boolean
  problem?: string
  /** What git printed, for a card that wants to show it. */
  output?: string
}

async function git(
  cwd: string,
  args: string[],
  opts: { timeout?: number; env?: Record<string, string>; input?: string } = {},
) {
  return execa('git', args, {
    cwd,
    reject: false,
    timeout: opts.timeout ?? 30_000,
    windowsHide: true,
    env: { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_EDITOR: 'true', ...(opts.env ?? {}) },
    ...(opts.input !== undefined ? { input: opts.input } : {}),
  })
}

function words(r: { stdout: string; stderr: string }): string {
  return `${r.stderr}\n${r.stdout}`.trim()
}

function failed(r: { stdout: string; stderr: string }, fallback: string): GitOutcome {
  return { ok: false, problem: words(r) || fallback }
}

// ------------------------------------------------------------------------------------------
// Status, porcelain v2
// ------------------------------------------------------------------------------------------

export type GitOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect'

export interface GitHeadInfo {
  /** The branch, or null while detached or before the first commit names one. */
  branch: string | null
  detached: boolean
  /** No commit yet: `git init` and nothing else. */
  unborn: boolean
  oid: string | null
  upstream: string | null
  ahead: number
  behind: number
  /** The upstream is configured but no longer exists on the remote. */
  upstreamGone: boolean
}

export interface GitStatusV2 {
  head: GitHeadInfo
  stashes: number
  files: GitFileChange[]
  /** Paths git reports as unmerged: the conflict list. */
  conflicts: string[]
}

/**
 * Porcelain v2 with `--branch --show-stash -z`, which answers in one process what v1 needed
 * three for: the branch AND its upstream AND the ahead/behind count, every rename with its
 * old name in the next record, every conflict as its own `u` entry, and the stash count.
 *
 * Records are NUL-terminated; a rename (`2`) is followed by a second NUL-terminated field
 * holding the original path. `-z` is what keeps a non-ASCII name verbatim (see the v1
 * parser's note on `core.quotePath`).
 */
export function parsePorcelainV2(stdout: string): GitStatusV2 {
  const head: GitHeadInfo = {
    branch: null, detached: false, unborn: false, oid: null, upstream: null, ahead: 0, behind: 0, upstreamGone: false,
  }
  let stashes = 0
  const files: GitFileChange[] = []
  const conflicts: string[] = []

  const records = stdout.split('\0')
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]!
    if (record === '') continue
    if (record.startsWith('# ')) {
      const [key, ...rest] = record.slice(2).split(' ')
      const value = rest.join(' ')
      switch (key) {
        case 'branch.oid':
          head.oid = value === '(initial)' ? null : value
          head.unborn = value === '(initial)'
          break
        case 'branch.head':
          head.detached = value === '(detached)'
          head.branch = value === '(detached)' ? null : value
          break
        case 'branch.upstream':
          head.upstream = value
          break
        case 'branch.ab': {
          const m = /\+(\d+) -(\d+)/.exec(value)
          if (m) { head.ahead = Number(m[1]); head.behind = Number(m[2]) }
          break
        }
        case 'stash':
          stashes = Number(value) || 0
          break
        default:
          break
      }
      continue
    }
    const kind = record[0]
    if (kind === '1') {
      // 1 XY sub mH mI mW hH hI path — `sub` opens with S for a submodule entry.
      const parts = record.split(' ')
      const code = parts[1] ?? '  '
      const path = parts.slice(8).join(' ')
      files.push({ ...fileOf(path, normaliseCode(code)), ...(parts[2]?.startsWith('S') ? { gitlink: true } : {}) })
    } else if (kind === '2') {
      // 2 XY sub mH mI mW hH hI Xscore path\0origPath
      const parts = record.split(' ')
      const code = parts[1] ?? '  '
      const path = parts.slice(9).join(' ')
      const oldPath = records[i + 1] ?? ''
      i += 1
      files.push({ ...fileOf(path, normaliseCode(code)), ...(oldPath !== '' ? { oldPath } : {}), ...(parts[2]?.startsWith('S') ? { gitlink: true } : {}) })
    } else if (kind === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const parts = record.split(' ')
      const code = parts[1] ?? 'UU'
      const path = parts.slice(10).join(' ')
      files.push({ path, code, staged: false, untracked: false })
      conflicts.push(path)
    } else if (kind === '?') {
      const path = record.slice(2)
      files.push({ path, code: '??', staged: false, untracked: true })
    }
    // `!` (ignored) is never asked for.
  }
  return { head, stashes, files, conflicts }
}

/** v2 spells an unchanged side as `.`; the panel's vocabulary is v1's space. */
function normaliseCode(code: string): string {
  return code.replace(/\./g, ' ')
}

function fileOf(path: string, code: string): GitFileChange {
  return {
    path,
    code,
    staged: code[0] !== ' ' && code[0] !== '?',
    untracked: code === '??',
  }
}

export async function readStatus(cwd: string): Promise<GitStatusV2 | { problem: string }> {
  const r = await git(cwd, ['status', '--porcelain=v2', '--branch', '--show-stash', '-z', '--untracked-files=all'])
  if (r.exitCode !== 0) return { problem: words(r) || 'git status failed' }
  return parsePorcelainV2(r.stdout)
}

/**
 * Which multi-step operation the repository is in the middle of, read from the files git
 * itself leaves behind — the same test `git status` makes for its "You are currently
 * rebasing" line, without parsing prose.
 */
export async function readOperation(cwd: string): Promise<GitOperation | null> {
  const r = await git(cwd, ['rev-parse', '--git-dir'])
  if (r.exitCode !== 0) return null
  const dir = join(cwd, r.stdout.trim())
  const gitDir = existsSync(dir) ? dir : r.stdout.trim()
  if (existsSync(join(gitDir, 'MERGE_HEAD'))) return 'merge'
  if (existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'))) return 'rebase'
  if (existsSync(join(gitDir, 'CHERRY_PICK_HEAD'))) return 'cherry-pick'
  if (existsSync(join(gitDir, 'REVERT_HEAD'))) return 'revert'
  if (existsSync(join(gitDir, 'BISECT_LOG'))) return 'bisect'
  return null
}

// ------------------------------------------------------------------------------------------
// Refs: branches and tags
// ------------------------------------------------------------------------------------------

export interface GitBranchRef {
  /** `main`, or `origin/main` for a remote branch — what git calls it. */
  name: string
  sha: string
  short: string
  subject: string
  /** ISO 8601 committer date. */
  date: string
  current: boolean
  /** Local branches only: the tracking branch and how far apart the two are. */
  upstream?: string
  ahead?: number
  behind?: number
  upstreamGone?: boolean
  /** Remote branches only. */
  remote?: string
}

export interface GitTagRef {
  name: string
  /** The commit the tag points at, peeled when the tag is annotated. */
  sha: string
  short: string
  subject: string
  date: string
  annotated: boolean
}

export interface GitRefs {
  local: GitBranchRef[]
  remote: GitBranchRef[]
  tags: GitTagRef[]
}

/**
 * Every branch and tag, one process. `%(upstream:track)` prints `[ahead 1, behind 2]`,
 * `[gone]` or nothing; `%(HEAD)` marks the checked-out branch with `*`.
 */
export async function listRefs(cwd: string): Promise<GitRefs | { problem: string }> {
  const format = [
    '%(refname)', '%(refname:short)', '%(objectname)', '%(objectname:short)', '%(*objectname)',
    '%(*objectname:short)', '%(upstream:short)', '%(upstream:track)', '%(HEAD)',
    '%(subject)', '%(committerdate:iso-strict)', '%(*committerdate:iso-strict)', '%(objecttype)',
  ].join('%1f') + '%1e'
  const r = await git(cwd, ['for-each-ref', `--format=${format}`, 'refs/heads', 'refs/remotes', 'refs/tags'])
  if (r.exitCode !== 0) return { problem: words(r) || 'git for-each-ref failed' }
  const refs: GitRefs = { local: [], remote: [], tags: [] }
  for (const raw of r.stdout.split(RECORD)) {
    const line = raw.replace(/^\r?\n/, '')
    if (line.trim() === '') continue
    const f = line.split(FIELD)
    const refname = f[0] ?? ''
    const short = f[1] ?? ''
    const sha = f[2] ?? ''
    const shortSha = f[3] ?? ''
    const peeled = f[4] ?? ''
    const peeledShort = f[5] ?? ''
    const upstream = f[6] ?? ''
    const track = f[7] ?? ''
    const isHead = (f[8] ?? '') === '*'
    const subject = f[9] ?? ''
    const date = f[10] ?? ''
    const peeledDate = f[11] ?? ''
    const type = f[12] ?? ''
    if (refname.startsWith('refs/heads/')) {
      const ahead = /ahead (\d+)/.exec(track)
      const behind = /behind (\d+)/.exec(track)
      refs.local.push({
        name: short, sha, short: shortSha, subject, date, current: isHead,
        ...(upstream !== '' ? { upstream, ahead: Number(ahead?.[1] ?? 0), behind: Number(behind?.[1] ?? 0) } : {}),
        ...(track === '[gone]' ? { upstreamGone: true } : {}),
      })
    } else if (refname.startsWith('refs/remotes/')) {
      // `origin/HEAD` is a pointer, not a branch anyone checks out — and its SHORT name is
      // just `origin`, which is why the refname is the one tested.
      if (refname.endsWith('/HEAD')) continue
      const remote = short.split('/')[0] ?? ''
      refs.remote.push({ name: short, sha, short: shortSha, subject, date, current: false, remote })
    } else if (refname.startsWith('refs/tags/')) {
      const annotated = type === 'tag'
      refs.tags.push({
        name: short,
        sha: annotated && peeled !== '' ? peeled : sha,
        short: annotated && peeledShort !== '' ? peeledShort : shortSha,
        subject,
        date: annotated && peeledDate !== '' ? peeledDate : date,
        annotated,
      })
    }
  }
  return refs
}

// ------------------------------------------------------------------------------------------
// History
// ------------------------------------------------------------------------------------------

export interface GitRefLabel {
  name: string
  kind: 'head' | 'local' | 'remote' | 'tag'
}

export interface GitCommitRow {
  sha: string
  short: string
  parents: string[]
  subject: string
  authorName: string
  authorEmail: string
  /** ISO 8601. */
  authorDate: string
  committerDate: string
  refs: GitRefLabel[]
}

export interface GitLogOptions {
  /** A revision or range: `main`, `HEAD..origin/main`, `origin/main..HEAD`. Default HEAD. */
  range?: string
  /** Every ref, for the multi-branch graph. */
  all?: boolean
  firstParent?: boolean
  limit?: number
  skip?: number
  /** `--grep`, case-insensitive; a 7+ hex prefix also matches the sha. */
  search?: string
  /** Restrict to commits touching these paths (`--follow` when it is one path). */
  paths?: string[]
  author?: string
}

/** `%D` decorations, parsed into labels the graph can colour. */
export function parseDecorations(text: string): GitRefLabel[] {
  const labels: GitRefLabel[] = []
  for (const part of text.split(',').map((p) => p.trim()).filter((p) => p !== '')) {
    if (part.startsWith('HEAD -> ')) {
      labels.push({ name: 'HEAD', kind: 'head' })
      labels.push({ name: part.slice('HEAD -> '.length), kind: 'local' })
    } else if (part === 'HEAD') {
      labels.push({ name: 'HEAD', kind: 'head' })
    } else if (part.startsWith('tag: ')) {
      labels.push({ name: part.slice(5), kind: 'tag' })
    } else if (part.includes('/')) {
      labels.push({ name: part, kind: 'remote' })
    } else {
      labels.push({ name: part, kind: 'local' })
    }
  }
  return labels
}

export async function readLog(cwd: string, opts: GitLogOptions = {}): Promise<{ commits: GitCommitRow[]; problem?: string }> {
  const format = ['%H', '%h', '%P', '%an', '%ae', '%aI', '%cI', '%D', '%s'].map((p) => p).join('%x1f') + '%x1e'
  const args = ['log', `--format=${format}`, '--date=iso-strict', `--max-count=${Math.min(Math.max(opts.limit ?? 200, 1), 5000)}`]
  if (opts.skip !== undefined && opts.skip > 0) args.push(`--skip=${opts.skip}`)
  if (opts.firstParent) args.push('--first-parent')
  if (opts.all) args.push('--all')
  if (opts.search !== undefined && opts.search.trim() !== '') {
    args.push('--regexp-ignore-case', `--grep=${opts.search.trim()}`)
  }
  if (opts.author !== undefined && opts.author.trim() !== '') args.push(`--author=${opts.author.trim()}`)
  if (opts.range !== undefined && opts.range.trim() !== '') args.push(opts.range.trim())
  if (opts.paths !== undefined && opts.paths.length > 0) {
    if (opts.paths.length === 1) args.push('--follow')
    args.push('--', ...opts.paths)
  }
  const r = await git(cwd, args, { timeout: 60_000 })
  if (r.exitCode !== 0) {
    // An unborn repository has no log, which is a state rather than a failure.
    if (/does not have any commits yet|bad default revision|unknown revision/i.test(words(r))) return { commits: [] }
    return { commits: [], problem: words(r) || 'git log failed' }
  }
  const commits: GitCommitRow[] = []
  for (const raw of r.stdout.split(RECORD)) {
    const line = raw.replace(/^\r?\n/, '')
    if (line.trim() === '') continue
    const f = line.split(FIELD)
    commits.push({
      sha: f[0] ?? '',
      short: f[1] ?? '',
      parents: (f[2] ?? '').split(' ').filter((p) => p !== ''),
      authorName: f[3] ?? '',
      authorEmail: f[4] ?? '',
      authorDate: f[5] ?? '',
      committerDate: f[6] ?? '',
      refs: parseDecorations(f[7] ?? ''),
      subject: f[8] ?? '',
    })
  }
  // A sha prefix typed into the search box finds the commit even when its message does not
  // mention it: `--grep` is the message only.
  if (opts.search !== undefined && /^[0-9a-f]{5,40}$/i.test(opts.search.trim()) && commits.length === 0) {
    const one = await git(cwd, ['log', `--format=${format}`, '--max-count=1', opts.search.trim()])
    if (one.exitCode === 0 && one.stdout.trim() !== '') {
      const f = one.stdout.split(RECORD)[0]!.split(FIELD)
      commits.push({
        sha: f[0] ?? '', short: f[1] ?? '', parents: (f[2] ?? '').split(' ').filter((p) => p !== ''),
        authorName: f[3] ?? '', authorEmail: f[4] ?? '', authorDate: f[5] ?? '', committerDate: f[6] ?? '',
        refs: parseDecorations(f[7] ?? ''), subject: f[8] ?? '',
      })
    }
  }
  return { commits }
}

export interface GitChangedFile {
  path: string
  /** `M`, `A`, `D`, `R`, `C`, `T` — git's own letter. */
  status: string
  oldPath?: string
  additions: number
  deletions: number
  binary: boolean
}

/** `--name-status -z` and `--numstat -z` for the same two trees, joined by path. */
async function changedFilesBetween(cwd: string, from: string, to: string): Promise<GitChangedFile[] | { problem: string }> {
  const names = await git(cwd, ['diff', '--name-status', '-z', '-M', from, to, '--'])
  if (names.exitCode !== 0) return { problem: words(names) || 'git diff failed' }
  const nums = await git(cwd, ['diff', '--numstat', '-z', '-M', from, to, '--'])
  const counts = new Map<string, { additions: number; deletions: number; binary: boolean }>()
  if (nums.exitCode === 0) {
    const parts = nums.stdout.split('\0')
    for (let i = 0; i < parts.length; i += 1) {
      const rec = parts[i]!
      if (rec === '') continue
      const [a, d, ...rest] = rec.split('\t')
      let path = rest.join('\t')
      // A rename's numstat record has an EMPTY path followed by two NUL fields: old, new.
      if (path === '') {
        i += 2
        path = parts[i] ?? ''
      }
      const binary = a === '-' || d === '-'
      counts.set(path, { additions: binary ? 0 : Number(a), deletions: binary ? 0 : Number(d), binary })
    }
  }
  const files: GitChangedFile[] = []
  const parts = names.stdout.split('\0')
  for (let i = 0; i < parts.length; i += 1) {
    const status = parts[i]!
    if (status === '') continue
    const letter = status[0] ?? 'M'
    if (letter === 'R' || letter === 'C') {
      const oldPath = parts[i + 1] ?? ''
      const path = parts[i + 2] ?? ''
      i += 2
      const c = counts.get(path) ?? { additions: 0, deletions: 0, binary: false }
      files.push({ path, status: letter, oldPath, ...c })
    } else {
      const path = parts[i + 1] ?? ''
      i += 1
      const c = counts.get(path) ?? { additions: 0, deletions: 0, binary: false }
      files.push({ path, status: letter, ...c })
    }
  }
  return files
}

export interface GitCommitDetails {
  sha: string
  short: string
  parents: string[]
  subject: string
  body: string
  authorName: string
  authorEmail: string
  authorDate: string
  committerName: string
  committerDate: string
  refs: GitRefLabel[]
  files: GitChangedFile[]
  /** The tree the files are diffed against: the first parent, or the empty tree at the root. */
  base: string
}

export async function commitDetails(cwd: string, sha: string): Promise<GitCommitDetails | { problem: string }> {
  const format = ['%H', '%h', '%P', '%an', '%ae', '%aI', '%cn', '%cI', '%D', '%s', '%b'].join('%x1f')
  const r = await git(cwd, ['show', '--no-patch', `--format=${format}`, sha, '--'])
  if (r.exitCode !== 0) return { problem: words(r) || `no commit ${sha}` }
  const f = r.stdout.split(FIELD)
  const parents = (f[2] ?? '').split(' ').filter((p) => p !== '')
  const base = parents[0] ?? EMPTY_TREE
  const files = await changedFilesBetween(cwd, base, f[0] ?? sha)
  if ('problem' in files) return files
  return {
    sha: f[0] ?? sha,
    short: f[1] ?? '',
    parents,
    authorName: f[3] ?? '',
    authorEmail: f[4] ?? '',
    authorDate: f[5] ?? '',
    committerName: f[6] ?? '',
    committerDate: f[7] ?? '',
    refs: parseDecorations(f[8] ?? ''),
    subject: f[9] ?? '',
    body: (f[10] ?? '').replace(/\s+$/, ''),
    files,
    base,
  }
}

/** The unified diff of one path between two trees — a commit and its parent, or any two. */
export async function diffBetween(cwd: string, from: string, to: string, path?: string): Promise<{ diff: string; problem?: string }> {
  const args = ['diff', '-M', '--no-color', from, to, '--']
  if (path !== undefined) args.push(path)
  const r = await git(cwd, args, { timeout: 60_000 })
  if (r.exitCode !== 0) return { diff: '', problem: words(r) || 'git diff failed' }
  return { diff: r.stdout }
}

/** Every file that differs between two revisions, for Compare Commits / Compare Branches. */
export async function compareRevisions(cwd: string, from: string, to: string): Promise<{ files: GitChangedFile[]; problem?: string }> {
  const files = await changedFilesBetween(cwd, from, to)
  if ('problem' in files) return { files: [], problem: files.problem }
  return { files }
}

/** Commits reachable from `to` and not from `from`: what a merge would bring in. */
export async function countRange(cwd: string, from: string, to: string): Promise<number> {
  const r = await git(cwd, ['rev-list', '--count', `${from}..${to}`])
  return r.exitCode === 0 ? Number(r.stdout.trim()) || 0 : 0
}

// ------------------------------------------------------------------------------------------
// Branch operations
// ------------------------------------------------------------------------------------------

function conflicted(r: { stdout: string; stderr: string }): boolean {
  return /CONFLICT|fix conflicts|resolve all conflicts|needs merge/i.test(words(r))
}

export interface GitOpOutcome extends GitOutcome {
  /** The operation stopped on conflicts: the working tree carries markers, and the
   * repository is in the middle of it (see `readOperation`). */
  conflict?: boolean
}

/**
 * Checks a branch out. A remote branch (`origin/feature`) becomes a local branch of the
 * same short name that tracks it — what `git switch feature` does on its own when the
 * name is unambiguous, spelled out so a second remote cannot make it guess.
 */
export async function switchBranch(cwd: string, name: string): Promise<GitOpOutcome> {
  const refs = await listRefs(cwd)
  if ('problem' in refs) return { ok: false, problem: refs.problem }
  const remote = refs.remote.find((b) => b.name === name)
  if (remote !== undefined) {
    const local = name.slice((remote.remote ?? '').length + 1)
    const existing = refs.local.find((b) => b.name === local)
    const r = existing !== undefined
      ? await git(cwd, ['switch', local])
      : await git(cwd, ['switch', '-c', local, '--track', name])
    return r.exitCode === 0 ? { ok: true, output: words(r) } : { ...failed(r, 'git switch failed'), conflict: conflicted(r) }
  }
  const r = await git(cwd, ['switch', name])
  return r.exitCode === 0 ? { ok: true, output: words(r) } : { ...failed(r, 'git switch failed'), conflict: conflicted(r) }
}

export async function checkoutDetached(cwd: string, sha: string): Promise<GitOutcome> {
  const r = await git(cwd, ['switch', '--detach', sha])
  return r.exitCode === 0 ? { ok: true, output: words(r) } : failed(r, 'git switch --detach failed')
}

export interface CreateBranchOptions {
  name: string
  /** A branch, remote branch, tag or sha. Default HEAD. */
  base?: string
  checkout: boolean
  /** Set the base as upstream — only meaningful when the base is a remote branch. */
  track?: boolean
}

export async function createBranch(cwd: string, opts: CreateBranchOptions): Promise<GitOutcome> {
  const check = await git(cwd, ['check-ref-format', '--branch', opts.name])
  if (check.exitCode !== 0) return { ok: false, problem: `"${opts.name}" is not a valid branch name` }
  const base = opts.base ?? 'HEAD'
  const trackArgs = opts.track === true ? ['--track'] : ['--no-track']
  const r = opts.checkout
    ? await git(cwd, ['switch', '-c', opts.name, ...trackArgs, base])
    : await git(cwd, ['branch', ...trackArgs, opts.name, base])
  return r.exitCode === 0 ? { ok: true, output: words(r) } : failed(r, 'git branch failed')
}

export async function deleteBranch(cwd: string, name: string, force: boolean): Promise<GitOutcome> {
  const r = await git(cwd, ['branch', force ? '-D' : '-d', name])
  if (r.exitCode === 0) return { ok: true, output: words(r) }
  const out = failed(r, 'git branch -d failed')
  if (/not fully merged/i.test(out.problem ?? '')) {
    out.problem = `"${name}" has commits that are not merged anywhere else — delete it anyway to lose them`
  }
  return out
}

export async function deleteRemoteBranch(cwd: string, remote: string, name: string): Promise<GitOutcome> {
  const r = await git(cwd, ['push', remote, '--delete', name], { timeout: NET_TIMEOUT_MS })
  return r.exitCode === 0 ? { ok: true, output: words(r) } : failed(r, 'git push --delete failed')
}

export async function renameBranch(cwd: string, name: string, newName: string): Promise<GitOutcome> {
  const check = await git(cwd, ['check-ref-format', '--branch', newName])
  if (check.exitCode !== 0) return { ok: false, problem: `"${newName}" is not a valid branch name` }
  const r = await git(cwd, ['branch', '-m', name, newName])
  return r.exitCode === 0 ? { ok: true } : failed(r, 'git branch -m failed')
}

export async function setUpstream(cwd: string, branch: string, upstream: string | null): Promise<GitOutcome> {
  const r = upstream === null
    ? await git(cwd, ['branch', '--unset-upstream', branch])
    : await git(cwd, ['branch', `--set-upstream-to=${upstream}`, branch])
  return r.exitCode === 0 ? { ok: true, output: words(r) } : failed(r, 'git branch --set-upstream-to failed')
}

export async function mergeBranch(cwd: string, branch: string, opts: { noCommit?: boolean } = {}): Promise<GitOpOutcome> {
  const args = ['merge', ...(opts.noCommit === true ? ['--no-commit', '--no-ff'] : []), branch]
  const r = await git(cwd, args, { timeout: 120_000 })
  if (r.exitCode === 0) return { ok: true, output: words(r) }
  return { ...failed(r, 'git merge failed'), conflict: conflicted(r) }
}

export async function rebaseOnto(cwd: string, onto: string): Promise<GitOpOutcome> {
  const r = await git(cwd, ['rebase', onto], { timeout: 120_000 })
  if (r.exitCode === 0) return { ok: true, output: words(r) }
  return { ...failed(r, 'git rebase failed'), conflict: conflicted(r) }
}

/**
 * Continue, skip or abort whatever multi-step operation is in progress. `--continue` on a
 * rebase or a cherry-pick wants to open an editor for the commit message; `GIT_EDITOR=true`
 * accepts what git proposes, which is the message the commit already had.
 */
export async function operationStep(cwd: string, action: 'continue' | 'abort' | 'skip'): Promise<GitOpOutcome> {
  const op = await readOperation(cwd)
  if (op === null) return { ok: false, problem: 'no merge, rebase, cherry-pick or revert is in progress' }
  if (op === 'bisect') return { ok: false, problem: 'a bisect is in progress; finish it from a terminal' }
  if (op === 'merge' && action === 'skip') return { ok: false, problem: 'a merge cannot be skipped — continue or abort it' }
  const r = await git(cwd, [op, `--${action}`], { timeout: 120_000 })
  if (r.exitCode === 0) return { ok: true, output: words(r) }
  return { ...failed(r, `git ${op} --${action} failed`), conflict: conflicted(r) }
}

export async function cherryPick(cwd: string, shas: readonly string[]): Promise<GitOpOutcome> {
  if (shas.length === 0) return { ok: false, problem: 'nothing to cherry-pick' }
  const r = await git(cwd, ['cherry-pick', '-x', ...shas], { timeout: 120_000 })
  if (r.exitCode === 0) return { ok: true, output: words(r) }
  return { ...failed(r, 'git cherry-pick failed'), conflict: conflicted(r) }
}

export async function revertCommit(cwd: string, sha: string): Promise<GitOpOutcome> {
  const parents = await git(cwd, ['rev-list', '--parents', '-n', '1', sha])
  if (parents.exitCode !== 0) return failed(parents, `no commit ${sha}`)
  const count = parents.stdout.trim().split(' ').length - 1
  if (count > 1) return { ok: false, problem: 'a merge commit cannot be reverted here — it has two parents and git needs to be told which side to keep (git revert -m)' }
  const r = await git(cwd, ['revert', '--no-edit', sha], { timeout: 120_000 })
  if (r.exitCode === 0) return { ok: true, output: words(r) }
  return { ...failed(r, 'git revert failed'), conflict: conflicted(r) }
}

export async function resetTo(cwd: string, sha: string, mode: 'soft' | 'mixed' | 'hard'): Promise<GitOutcome> {
  const r = await git(cwd, ['reset', `--${mode}`, sha, '--'])
  return r.exitCode === 0 ? { ok: true, output: words(r) } : failed(r, 'git reset failed')
}

export async function createTag(cwd: string, name: string, at: string | undefined, message: string | undefined): Promise<GitOutcome> {
  const check = await git(cwd, ['check-ref-format', `refs/tags/${name}`])
  if (check.exitCode !== 0) return { ok: false, problem: `"${name}" is not a valid tag name` }
  const args = message !== undefined && message.trim() !== ''
    ? ['tag', '-a', '-m', message, name, ...(at !== undefined ? [at] : [])]
    : ['tag', name, ...(at !== undefined ? [at] : [])]
  const r = await git(cwd, args)
  return r.exitCode === 0 ? { ok: true } : failed(r, 'git tag failed')
}

export async function deleteTag(cwd: string, name: string): Promise<GitOutcome> {
  const r = await git(cwd, ['tag', '-d', name])
  return r.exitCode === 0 ? { ok: true } : failed(r, 'git tag -d failed')
}

/**
 * Rewrites the last commit: a new message, the staged changes, or both. Refused when the
 * commit has already been pushed — the rewritten one would never match the remote's.
 */
export async function amendLast(cwd: string, message: string | undefined): Promise<GitOutcome> {
  const status = await readStatus(cwd)
  if ('problem' in status) return { ok: false, problem: status.problem }
  if (status.head.unborn) return { ok: false, problem: 'there is no commit to amend yet' }
  if (status.head.upstream !== null && status.head.ahead === 0) {
    return { ok: false, problem: `the last commit is already on ${status.head.upstream} — amending it would make your history disagree with the remote's` }
  }
  const args = ['commit', '--amend', ...(message !== undefined && message.trim() !== '' ? ['-m', message] : ['--no-edit'])]
  const r = await git(cwd, args)
  return r.exitCode === 0 ? { ok: true, output: words(r) } : failed(r, 'git commit --amend failed')
}

/**
 * Squashes the newest N commits of the current branch into one, the way Visual Studio's
 * "Squash Commits" does: a soft reset to the oldest one's parent, then one commit with the
 * given message. Only a run that starts at HEAD can be squashed this way, and only with a
 * clean index — anything staged would be swept into the squash unseen.
 */
export async function squashCommits(cwd: string, shas: readonly string[], message: string): Promise<GitOutcome> {
  if (shas.length < 2) return { ok: false, problem: 'select two or more commits to squash' }
  if (message.trim() === '') return { ok: false, problem: 'a squash needs a commit message' }
  const status = await readStatus(cwd)
  if ('problem' in status) return { ok: false, problem: status.problem }
  if (status.files.some((f) => f.staged)) return { ok: false, problem: 'unstage or commit what is staged first — a squash would sweep it in' }
  if (status.conflicts.length > 0) return { ok: false, problem: 'resolve the conflicts first' }
  const top = await git(cwd, ['rev-list', '--first-parent', `--max-count=${shas.length}`, 'HEAD'])
  if (top.exitCode !== 0) return failed(top, 'git rev-list failed')
  const newest = top.stdout.trim().split(/\r?\n/)
  const wanted = new Set(shas)
  if (newest.length !== shas.length || newest.some((s) => !wanted.has(s))) {
    return { ok: false, problem: 'only the newest commits of the branch can be squashed here — the selection has to run from the tip down without gaps' }
  }
  if (status.head.upstream !== null && status.head.ahead < shas.length) {
    return { ok: false, problem: `some of these commits are already on ${status.head.upstream} — squashing them would rewrite shared history` }
  }
  const oldest = newest[newest.length - 1]!
  const parent = await git(cwd, ['rev-parse', `${oldest}^`])
  const base = parent.exitCode === 0 ? parent.stdout.trim() : null
  const reset = base === null
    ? await git(cwd, ['update-ref', '-d', 'HEAD'])
    : await git(cwd, ['reset', '--soft', base, '--'])
  if (reset.exitCode !== 0) return failed(reset, 'git reset --soft failed')
  const commit = await git(cwd, ['commit', '-m', message])
  return commit.exitCode === 0 ? { ok: true, output: words(commit) } : failed(commit, 'git commit failed')
}

// ------------------------------------------------------------------------------------------
// Network
// ------------------------------------------------------------------------------------------

export interface GitNetOutcome extends GitOutcome {
  /** The push was refused because the remote has commits this branch does not. */
  behindRemote?: boolean
  /** The branch has no upstream yet — a push needs `--set-upstream`. */
  noUpstream?: boolean
  /** The pull stopped on conflicts. */
  conflict?: boolean
  /** Authentication was refused or nothing answered. */
  unreachable?: boolean
}

function classify(r: { stdout: string; stderr: string }, fallback: string): GitNetOutcome {
  const text = words(r)
  const out: GitNetOutcome = { ok: false, problem: text || fallback }
  if (/fetch first|non-fast-forward|rejected.*behind|Updates were rejected/i.test(text)) out.behindRemote = true
  if (/has no upstream branch|no tracking information|set-upstream/i.test(text)) out.noUpstream = true
  if (conflicted(r)) out.conflict = true
  if (/could not read Username|Authentication failed|could not resolve host|unable to access|Connection refused|terminal prompts disabled|Permission denied/i.test(text)) out.unreachable = true
  return out
}

export async function fetchRemote(cwd: string, opts: { remote?: string; prune?: boolean } = {}): Promise<GitNetOutcome> {
  const args = ['fetch', ...(opts.prune === true ? ['--prune'] : []), ...(opts.remote !== undefined ? [opts.remote] : ['--all'])]
  const r = await git(cwd, args, { timeout: NET_TIMEOUT_MS })
  return r.exitCode === 0 ? { ok: true, output: words(r) } : classify(r, 'git fetch failed')
}

export async function pullRemote(cwd: string, opts: { rebase?: boolean } = {}): Promise<GitNetOutcome> {
  const args = ['pull', ...(opts.rebase === true ? ['--rebase'] : ['--no-rebase'])]
  const r = await git(cwd, args, { timeout: NET_TIMEOUT_MS })
  return r.exitCode === 0 ? { ok: true, output: words(r) } : classify(r, 'git pull failed')
}

export interface PushOptions {
  /** Publish: `push -u <remote> <branch>`. */
  setUpstream?: boolean
  remote?: string
  branch?: string
  forceWithLease?: boolean
  tags?: boolean
}

export async function pushRemote(cwd: string, opts: PushOptions = {}): Promise<GitNetOutcome> {
  const args = ['push']
  if (opts.forceWithLease === true) args.push('--force-with-lease')
  if (opts.tags === true) args.push('--tags')
  if (opts.setUpstream === true) {
    const status = await readStatus(cwd)
    const branch = opts.branch ?? ('problem' in status ? null : status.head.branch)
    if (branch === null) return { ok: false, problem: 'no branch is checked out to publish' }
    args.push('--set-upstream', opts.remote ?? 'origin', branch)
  } else if (opts.remote !== undefined) {
    args.push(opts.remote, ...(opts.branch !== undefined ? [opts.branch] : []))
  }
  const r = await git(cwd, args, { timeout: NET_TIMEOUT_MS })
  return r.exitCode === 0 ? { ok: true, output: words(r) } : classify(r, 'git push failed')
}

// ------------------------------------------------------------------------------------------
// Stashes
// ------------------------------------------------------------------------------------------

export interface GitStashEntry {
  index: number
  ref: string
  sha: string
  message: string
  date: string
}

export async function listStashes(cwd: string): Promise<{ stashes: GitStashEntry[]; problem?: string }> {
  const r = await git(cwd, ['stash', 'list', '--format=%gd%x1f%H%x1f%cI%x1f%gs%x1e'])
  if (r.exitCode !== 0) return { stashes: [], problem: words(r) || 'git stash list failed' }
  const stashes: GitStashEntry[] = []
  for (const raw of r.stdout.split(RECORD)) {
    const line = raw.replace(/^\r?\n/, '')
    if (line.trim() === '') continue
    const f = line.split(FIELD)
    const ref = f[0] ?? ''
    const m = /stash@\{(\d+)\}/.exec(ref)
    stashes.push({ index: Number(m?.[1] ?? stashes.length), ref, sha: f[1] ?? '', date: f[2] ?? '', message: f[3] ?? '' })
  }
  return { stashes }
}

export async function stashPush(cwd: string, opts: { message?: string; keepIndex?: boolean; includeUntracked?: boolean } = {}): Promise<GitOutcome> {
  const args = ['stash', 'push']
  if (opts.keepIndex === true) args.push('--keep-index')
  if (opts.includeUntracked === true) args.push('--include-untracked')
  if (opts.message !== undefined && opts.message.trim() !== '') args.push('-m', opts.message.trim())
  const r = await git(cwd, args)
  if (r.exitCode !== 0) return failed(r, 'git stash failed')
  if (/No local changes to save/i.test(words(r))) return { ok: false, problem: 'nothing to stash — the working tree is clean' }
  return { ok: true, output: words(r) }
}

export async function stashApply(cwd: string, index: number, opts: { pop: boolean; restoreIndex: boolean }): Promise<GitOpOutcome> {
  const args = ['stash', opts.pop ? 'pop' : 'apply', ...(opts.restoreIndex ? ['--index'] : []), `stash@{${index}}`]
  const r = await git(cwd, args)
  if (r.exitCode === 0) return { ok: true, output: words(r) }
  return { ...failed(r, 'git stash apply failed'), conflict: conflicted(r) }
}

export async function stashDrop(cwd: string, index: number): Promise<GitOutcome> {
  const r = await git(cwd, ['stash', 'drop', `stash@{${index}}`])
  return r.exitCode === 0 ? { ok: true, output: words(r) } : failed(r, 'git stash drop failed')
}

export async function stashShow(cwd: string, index: number): Promise<{ files: GitChangedFile[]; diff: string; problem?: string }> {
  const ref = `stash@{${index}}`
  const files = await changedFilesBetween(cwd, `${ref}^1`, ref)
  if ('problem' in files) return { files: [], diff: '', problem: files.problem }
  const patch = await git(cwd, ['stash', 'show', '-p', '--no-color', ref])
  return { files, diff: patch.exitCode === 0 ? patch.stdout : '' }
}

// ------------------------------------------------------------------------------------------
// The working tree: discard, ignore, hunks, blame
// ------------------------------------------------------------------------------------------

/**
 * Visual Studio's "Undo Changes": the file goes back to HEAD, staged or not. An untracked
 * file has no HEAD to go back to, so it is deleted — the caller has confirmed that.
 */
export async function discardChanges(cwd: string, paths: readonly string[]): Promise<GitOutcome> {
  if (paths.length === 0) return { ok: false, problem: 'nothing to discard' }
  const status = await readStatus(cwd)
  if ('problem' in status) return { ok: false, problem: status.problem }
  const untracked = new Set(status.files.filter((f) => f.untracked).map((f) => f.path))
  const tracked = paths.filter((p) => !untracked.has(p))
  const fresh = paths.filter((p) => untracked.has(p))
  if (tracked.length > 0) {
    const r = status.head.unborn
      ? await git(cwd, ['rm', '--cached', '-q', '-r', '--', ...tracked])
      : await git(cwd, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...tracked])
    if (r.exitCode !== 0) return failed(r, 'git restore failed')
  }
  if (fresh.length > 0) {
    const r = await git(cwd, ['clean', '-f', '-d', '--', ...fresh])
    if (r.exitCode !== 0) return failed(r, 'git clean failed')
  }
  return { ok: true }
}

/** Appends a pattern to the repository's `.gitignore`, creating the file if needed. */
export function ignorePattern(root: string, pattern: string): GitOutcome {
  const line = pattern.trim()
  if (line === '') return { ok: false, problem: 'nothing to ignore' }
  const file = join(root, '.gitignore')
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (existing.split(/\r?\n/).some((l) => l.trim() === line)) return { ok: true, output: 'already ignored' }
  const eol = existing.includes('\r\n') ? '\r\n' : '\n'
  const body = existing === '' || existing.endsWith('\n') ? existing : existing + eol
  writeFileSync(file, `${body}${line}${eol}`, 'utf8')
  return { ok: true }
}

/**
 * Line staging. `hunk` is one `@@ … @@` block cut out of a unified diff of the working tree
 * against HEAD — the loop that produced it is the file view's. The patch is that hunk under
 * the file's own header, applied to the INDEX (`--cached`), or taken back out of it with
 * `-R`; `undo` applies the reverse to the working tree instead, which is the hunk-sized
 * "Undo Changes".
 */
export async function applyHunk(
  cwd: string,
  path: string,
  hunk: string,
  mode: 'stage' | 'unstage' | 'undo',
): Promise<GitOutcome> {
  if (!/^@@ /m.test(hunk)) return { ok: false, problem: 'that is not a diff hunk' }
  const body = hunk.endsWith('\n') ? hunk : `${hunk}\n`
  const patch = `--- a/${path}\n+++ b/${path}\n${body}`
  const args = ['apply', '--whitespace=nowarn', '--recount']
  if (mode === 'stage') args.push('--cached')
  if (mode === 'unstage') args.push('--cached', '-R')
  if (mode === 'undo') args.push('-R')
  args.push('-')
  const r = await git(cwd, args, { input: patch })
  return r.exitCode === 0 ? { ok: true } : failed(r, 'git apply failed — the hunk no longer matches the file')
}

export interface GitBlameLine {
  line: number
  sha: string
  short: string
  author: string
  /** ISO 8601. */
  date: string
  summary: string
  text: string
}

export async function blameFile(cwd: string, path: string): Promise<{ lines: GitBlameLine[]; problem?: string }> {
  const r = await git(cwd, ['blame', '--line-porcelain', '--', path], { timeout: 60_000 })
  if (r.exitCode !== 0) return { lines: [], problem: words(r) || 'git blame failed' }
  const lines: GitBlameLine[] = []
  const meta = new Map<string, { author: string; date: string; summary: string }>()
  const rows = r.stdout.split(/\r?\n/)
  let i = 0
  while (i < rows.length) {
    const header = rows[i]!
    const m = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/.exec(header)
    if (!m) { i += 1; continue }
    const sha = m[1]!
    const line = Number(m[3])
    const info = meta.get(sha) ?? { author: '', date: '', summary: '' }
    i += 1
    let text = ''
    while (i < rows.length) {
      const row = rows[i]!
      if (row.startsWith('\t')) { text = row.slice(1); i += 1; break }
      if (row.startsWith('author ')) info.author = row.slice(7)
      else if (row.startsWith('author-time ')) info.date = new Date(Number(row.slice(12)) * 1000).toISOString()
      else if (row.startsWith('summary ')) info.summary = row.slice(8)
      i += 1
    }
    meta.set(sha, info)
    lines.push({ line, sha, short: sha.slice(0, 7), author: info.author, date: info.date, summary: info.summary, text })
  }
  return { lines }
}

// ------------------------------------------------------------------------------------------
// Remotes and configuration
// ------------------------------------------------------------------------------------------

export interface GitRemote {
  name: string
  fetchUrl: string
  pushUrl: string
}

export async function listRemotes(cwd: string): Promise<GitRemote[]> {
  const r = await git(cwd, ['remote', '-v'])
  if (r.exitCode !== 0) return []
  const byName = new Map<string, GitRemote>()
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^(\S+)\s+(.*?)\s+\((fetch|push)\)$/.exec(line.trim())
    if (!m) continue
    const entry = byName.get(m[1]!) ?? { name: m[1]!, fetchUrl: '', pushUrl: '' }
    if (m[3] === 'fetch') entry.fetchUrl = m[2]!
    else entry.pushUrl = m[2]!
    byName.set(m[1]!, entry)
  }
  return [...byName.values()]
}

export async function remoteAdd(cwd: string, name: string, url: string): Promise<GitOutcome> {
  if (!/^[\w.-]+$/.test(name)) return { ok: false, problem: 'a remote name is letters, digits, dots, dashes and underscores' }
  if (url.trim() === '') return { ok: false, problem: 'a remote needs a URL' }
  const r = await git(cwd, ['remote', 'add', name, url.trim()])
  return r.exitCode === 0 ? { ok: true } : failed(r, 'git remote add failed')
}

export async function remoteSetUrl(cwd: string, name: string, url: string): Promise<GitOutcome> {
  if (url.trim() === '') return { ok: false, problem: 'a remote needs a URL' }
  const r = await git(cwd, ['remote', 'set-url', name, url.trim()])
  return r.exitCode === 0 ? { ok: true } : failed(r, 'git remote set-url failed')
}

export async function remoteRename(cwd: string, name: string, newName: string): Promise<GitOutcome> {
  if (!/^[\w.-]+$/.test(newName)) return { ok: false, problem: 'a remote name is letters, digits, dots, dashes and underscores' }
  const r = await git(cwd, ['remote', 'rename', name, newName])
  return r.exitCode === 0 ? { ok: true } : failed(r, 'git remote rename failed')
}

export async function remoteRemove(cwd: string, name: string): Promise<GitOutcome> {
  const r = await git(cwd, ['remote', 'remove', name])
  return r.exitCode === 0 ? { ok: true } : failed(r, 'git remote remove failed')
}

/** The settings Visual Studio's Git Settings page exposes, and nothing else. */
export const CONFIG_KEYS = ['user.name', 'user.email', 'fetch.prune', 'pull.rebase', 'init.defaultBranch', 'core.autocrlf'] as const
export type GitConfigKey = typeof CONFIG_KEYS[number]

export interface GitConfigView {
  global: Partial<Record<GitConfigKey, string>>
  local: Partial<Record<GitConfigKey, string>>
  /** What git will actually use — the local value over the global over its default. */
  effective: Partial<Record<GitConfigKey, string>>
  hasIgnoreFile: boolean
  hasAttributesFile: boolean
}

export async function readConfig(cwd: string): Promise<GitConfigView> {
  const view: GitConfigView = {
    global: {}, local: {}, effective: {},
    hasIgnoreFile: existsSync(join(cwd, '.gitignore')),
    hasAttributesFile: existsSync(join(cwd, '.gitattributes')),
  }
  for (const scope of ['global', 'local'] as const) {
    const r = await git(cwd, ['config', `--${scope}`, '--list', '-z'])
    if (r.exitCode !== 0) continue
    for (const rec of r.stdout.split('\0')) {
      const cut = rec.indexOf('\n')
      if (cut === -1) continue
      const key = rec.slice(0, cut) as GitConfigKey
      if ((CONFIG_KEYS as readonly string[]).includes(key)) view[scope][key] = rec.slice(cut + 1)
    }
  }
  for (const key of CONFIG_KEYS) {
    const value = view.local[key] ?? view.global[key]
    if (value !== undefined) view.effective[key] = value
  }
  return view
}

export async function writeConfig(cwd: string, scope: 'global' | 'local', key: GitConfigKey, value: string | null): Promise<GitOutcome> {
  if (!(CONFIG_KEYS as readonly string[]).includes(key)) return { ok: false, problem: `${key} is not a setting this window edits` }
  const r = value === null || value === ''
    ? await git(cwd, ['config', `--${scope}`, '--unset', key])
    : await git(cwd, ['config', `--${scope}`, key, value])
  // Unsetting a key that was never set exits 5, which is the state that was wanted.
  if (r.exitCode === 0 || (value === null && r.exitCode === 5)) return { ok: true }
  return failed(r, 'git config failed')
}

export async function initRepository(dir: string, defaultBranch?: string): Promise<GitOutcome> {
  const args = ['init', ...(defaultBranch !== undefined && defaultBranch.trim() !== '' ? [`--initial-branch=${defaultBranch.trim()}`] : [])]
  const r = await git(dir, args)
  return r.exitCode === 0 ? { ok: true, output: words(r) } : failed(r, 'git init failed')
}

/** Whether `git` answers at all on this machine, and which version. */
export async function gitVersion(): Promise<string | null> {
  try {
    const r = await execa('git', ['--version'], { reject: false, timeout: 10_000, windowsHide: true })
    return r.exitCode === 0 ? r.stdout.trim() : null
  } catch {
    return null
  }
}
