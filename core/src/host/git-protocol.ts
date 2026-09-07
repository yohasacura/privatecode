import type {
  GitBlameLine, GitBranchRef, GitChangedFile, GitCommitDetails, GitCommitRow, GitConfigKey, GitConfigView, GitHeadInfo,
  GitLogOptions, GitNetOutcome, GitOpOutcome, GitOperation, GitOutcome, GitRefs, GitRemote, GitStashEntry, GitTagRef,
} from './git-repo.js'

/**
 * The wire for the Git panel and the Git Repository view — every call the window makes
 * beyond the tree's own stage/unstage/commit (those stay in `protocol.ts`).
 *
 * Every request names the repository by `root`, the absolute toplevel `git.status` reported,
 * and the host re-verifies that the root is one this workspace actually touches before git
 * is asked anything (see `git-rpc.ts`). Paths are REPOSITORY-relative, forward slashes —
 * git's own spelling, straight from `git.status` — not workspace-addressed: the panel works
 * per repository, the way Visual Studio's does, and a translation layer between two
 * spellings of the same file is where earlier bugs lived.
 */

export type {
  GitBlameLine, GitBranchRef, GitChangedFile, GitCommitDetails, GitCommitRow, GitConfigKey, GitConfigView, GitHeadInfo,
  GitLogOptions, GitNetOutcome, GitOpOutcome, GitOperation, GitOutcome, GitRefs, GitRemote, GitStashEntry, GitTagRef,
}

export interface GitRootParams { root: string }

export interface GitRefsResult extends Partial<GitRefs> { problem?: string }

export interface GitLogParams extends GitRootParams, GitLogOptions {}
export interface GitLogResult { commits: GitCommitRow[]; problem?: string }

export interface GitCommitDetailsParams extends GitRootParams { sha: string }
export interface GitCommitDetailsResult { details?: GitCommitDetails; problem?: string }

/** One path's diff between two trees; without `path`, the whole diff. */
export interface GitDiffBetweenParams extends GitRootParams { from: string; to: string; path?: string }
export interface GitDiffBetweenResult { diff: string; problem?: string }

export interface GitCompareParams extends GitRootParams { from: string; to: string }
export interface GitCompareResult {
  files: GitChangedFile[]
  /** Commits `to` has that `from` does not, and the other way round. */
  ahead: number
  behind: number
  problem?: string
}

/** `git show <rev>:<path>` — a file as it was in a commit, for the compare views. */
export interface GitShowFileParams extends GitRootParams { rev: string; path: string }
export interface GitShowFileResult { text: string; problem?: string }

export interface GitSwitchParams extends GitRootParams { name: string }
export interface GitCheckoutDetachedParams extends GitRootParams { sha: string }
export interface GitBranchCreateParams extends GitRootParams { name: string; base?: string; checkout: boolean; track?: boolean }
export interface GitBranchDeleteParams extends GitRootParams { name: string; force?: boolean; /** Delete `name` on this remote instead of locally. */ remote?: string }
export interface GitBranchRenameParams extends GitRootParams { name: string; newName: string }
export interface GitSetUpstreamParams extends GitRootParams { branch: string; upstream: string | null }
export interface GitMergeParams extends GitRootParams { branch: string; noCommit?: boolean }
export interface GitRebaseParams extends GitRootParams { onto: string }
export interface GitOperationParams extends GitRootParams { action: 'continue' | 'abort' | 'skip' }
export interface GitCherryPickParams extends GitRootParams { shas: string[] }
export interface GitRevertParams extends GitRootParams { sha: string }
export interface GitResetParams extends GitRootParams { sha: string; mode: 'soft' | 'mixed' | 'hard' }
export interface GitTagCreateParams extends GitRootParams { name: string; at?: string; message?: string }
export interface GitTagDeleteParams extends GitRootParams { name: string }
export interface GitAmendParams extends GitRootParams { message?: string }
export interface GitSquashParams extends GitRootParams { shas: string[]; message: string }

/**
 * Commits what is staged (`all: false`) or everything the panel lists (`all: true` — every
 * change is staged first, untracked files included, which is what the list the person is
 * looking at says a Commit All will carry). `amend` folds it into the last commit.
 */
export interface GitCommitIndexParams extends GitRootParams { message: string; all?: boolean; amend?: boolean }
export interface GitCommitIndexResult { ok: boolean; sha?: string; problem?: string }

/** Repository-relative paths, exactly as `git.status` spelled them. */
export interface GitPathsParams extends GitRootParams { paths: string[] }

export interface GitFetchParams extends GitRootParams { remote?: string; prune?: boolean }
export interface GitPullParams extends GitRootParams { rebase?: boolean }
export interface GitPushParams extends GitRootParams { setUpstream?: boolean; remote?: string; branch?: string; forceWithLease?: boolean; tags?: boolean }
export interface GitSyncParams extends GitRootParams { rebase?: boolean }

export interface GitStashListResult { stashes: GitStashEntry[]; problem?: string }
export interface GitStashPushParams extends GitRootParams { message?: string; keepIndex?: boolean; includeUntracked?: boolean }
export interface GitStashApplyParams extends GitRootParams { index: number; pop: boolean; restoreIndex: boolean }
export interface GitStashDropParams extends GitRootParams { index: number }
export interface GitStashShowParams extends GitRootParams { index: number }
export interface GitStashShowResult { files: GitChangedFile[]; diff: string; problem?: string }

export interface GitIgnoreParams extends GitRootParams { pattern: string }
export interface GitHunkParams extends GitRootParams { path: string; hunk: string; mode: 'stage' | 'unstage' | 'undo' }
export interface GitBlameParams extends GitRootParams { path: string }
export interface GitBlameResult { lines: GitBlameLine[]; problem?: string }

export interface GitRemotesResult { remotes: GitRemote[] }
export interface GitRemoteAddParams extends GitRootParams { name: string; url: string }
export interface GitRemoteSetUrlParams extends GitRootParams { name: string; url: string }
export interface GitRemoteRenameParams extends GitRootParams { name: string; newName: string }
export interface GitRemoteRemoveParams extends GitRootParams { name: string }

export interface GitConfigResult extends GitConfigView { problem?: string }
export interface GitConfigSetParams extends GitRootParams { scope: 'global' | 'local'; key: GitConfigKey; value: string | null }

/** `git init` in one of the workspace's folders, named the way `workspace.get` names it. */
export interface GitInitParams { mount: string; defaultBranch?: string }
export interface GitVersionResult { version: string | null }

/**
 * The three sides of a conflicted file, for the merge editor: the common ancestor, ours
 * (`:2:`), theirs (`:3:`), plus the working copy with git's markers in it, and the names
 * git gives the two sides in those markers.
 */
export interface GitConflictParams extends GitRootParams { path: string }
export interface GitConflictResult {
  base: string
  ours: string
  theirs: string
  working: string
  /** e.g. `main` and `feature`, or `HEAD` and a sha while rebasing. */
  oursLabel: string
  theirsLabel: string
  operation: GitOperation | null
  problem?: string
}
/** Writes the merged text and marks the path resolved (`git add`). */
export interface GitResolveParams extends GitRootParams { path: string; text: string }
/** Resolves a conflict wholesale with one side. */
export interface GitKeepSideParams extends GitRootParams { path: string; side: 'ours' | 'theirs' }

export interface GitMethodMap {
  'git.refs': { params: GitRootParams; result: GitRefsResult }
  'git.log': { params: GitLogParams; result: GitLogResult }
  'git.commitDetails': { params: GitCommitDetailsParams; result: GitCommitDetailsResult }
  'git.diffBetween': { params: GitDiffBetweenParams; result: GitDiffBetweenResult }
  'git.compare': { params: GitCompareParams; result: GitCompareResult }
  'git.showFile': { params: GitShowFileParams; result: GitShowFileResult }
  'git.switch': { params: GitSwitchParams; result: GitOpOutcome }
  'git.checkoutDetached': { params: GitCheckoutDetachedParams; result: GitOutcome }
  'git.branchCreate': { params: GitBranchCreateParams; result: GitOutcome }
  'git.branchDelete': { params: GitBranchDeleteParams; result: GitOutcome }
  'git.branchRename': { params: GitBranchRenameParams; result: GitOutcome }
  'git.setUpstream': { params: GitSetUpstreamParams; result: GitOutcome }
  'git.merge': { params: GitMergeParams; result: GitOpOutcome }
  'git.rebase': { params: GitRebaseParams; result: GitOpOutcome }
  'git.operation': { params: GitOperationParams; result: GitOpOutcome }
  'git.cherryPick': { params: GitCherryPickParams; result: GitOpOutcome }
  'git.revert': { params: GitRevertParams; result: GitOpOutcome }
  'git.reset': { params: GitResetParams; result: GitOutcome }
  'git.tagCreate': { params: GitTagCreateParams; result: GitOutcome }
  'git.tagDelete': { params: GitTagDeleteParams; result: GitOutcome }
  'git.amend': { params: GitAmendParams; result: GitOutcome }
  'git.squash': { params: GitSquashParams; result: GitOutcome }
  'git.commitIndex': { params: GitCommitIndexParams; result: GitCommitIndexResult }
  'git.stagePaths': { params: GitPathsParams; result: GitOutcome }
  'git.unstagePaths': { params: GitPathsParams; result: GitOutcome }
  'git.discard': { params: GitPathsParams; result: GitOutcome }
  'git.fetch': { params: GitFetchParams; result: GitNetOutcome }
  'git.pull': { params: GitPullParams; result: GitNetOutcome }
  'git.push': { params: GitPushParams; result: GitNetOutcome }
  'git.sync': { params: GitSyncParams; result: GitNetOutcome }
  'git.stashList': { params: GitRootParams; result: GitStashListResult }
  'git.stashPush': { params: GitStashPushParams; result: GitOutcome }
  'git.stashApply': { params: GitStashApplyParams; result: GitOpOutcome }
  'git.stashDrop': { params: GitStashDropParams; result: GitOutcome }
  'git.stashShow': { params: GitStashShowParams; result: GitStashShowResult }
  'git.ignore': { params: GitIgnoreParams; result: GitOutcome }
  'git.hunk': { params: GitHunkParams; result: GitOutcome }
  'git.blame': { params: GitBlameParams; result: GitBlameResult }
  'git.remotes': { params: GitRootParams; result: GitRemotesResult }
  'git.remoteAdd': { params: GitRemoteAddParams; result: GitOutcome }
  'git.remoteSetUrl': { params: GitRemoteSetUrlParams; result: GitOutcome }
  'git.remoteRename': { params: GitRemoteRenameParams; result: GitOutcome }
  'git.remoteRemove': { params: GitRemoteRemoveParams; result: GitOutcome }
  'git.config': { params: GitRootParams; result: GitConfigResult }
  'git.configSet': { params: GitConfigSetParams; result: GitOutcome }
  'git.init': { params: GitInitParams; result: GitOutcome }
  'git.version': { params: Record<string, never>; result: GitVersionResult }
  'git.conflict': { params: GitConflictParams; result: GitConflictResult }
  'git.resolve': { params: GitResolveParams; result: GitOutcome }
  'git.keepSide': { params: GitKeepSideParams; result: GitOutcome }
}
