import type { GitNetOutcome, GitOpOutcome, GitOutcome, GitRepoView } from '@core/host/protocol'
import type { ProtocolClient } from './client'
import { toast } from '../ui/toast'

/**
 * What every Git button shares: run one call, say how it went, refresh.
 *
 * A git operation ends in one of a few shapes the panel must tell apart — done, refused
 * with words, stopped on conflicts, refused because the remote moved on, refused because
 * the branch has no upstream — and each shape has its own next step in Visual Studio's
 * flow (a merge editor, a "Pull then Push" question, a "Publish branch" question). The
 * shape is decided HERE, once, so the Git tab, the Repository view and the status bar all
 * read an outcome the same way.
 */

export type Outcome = GitOutcome | GitOpOutcome | GitNetOutcome

export type OutcomeKind = 'ok' | 'conflict' | 'behind' | 'no-upstream' | 'unreachable' | 'failed'

export function kindOf(r: Outcome): OutcomeKind {
  if (r.ok) return 'ok'
  const net = r as GitNetOutcome
  const op = r as GitOpOutcome
  if (op.conflict === true) return 'conflict'
  if (net.behindRemote === true) return 'behind'
  if (net.noUpstream === true) return 'no-upstream'
  if (net.unreachable === true) return 'unreachable'
  return 'failed'
}

/** The last line git printed — the one that says what happened — for a toast. */
export function lastLine(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('hint:'))
  return lines[lines.length - 1]
}

/**
 * Announces an outcome. Success is a short toast; a refusal is a red one carrying git's
 * words; the three "not yet" shapes are left to the caller, which has a dialog for each.
 * Returns the kind so the caller can branch on it.
 */
export function announce(r: Outcome, done: string): OutcomeKind {
  const kind = kindOf(r)
  if (kind === 'ok') {
    const detail = lastLine(r.output)
    toast.push({ title: done, tone: 'success', ...(detail !== undefined && detail !== done ? { description: detail } : {}) })
  } else if (kind === 'failed' || kind === 'unreachable') {
    toast.push({ title: kind === 'unreachable' ? 'The remote did not answer' : 'Git said no', description: r.problem ?? 'unknown error', tone: 'error', duration: 8000 })
  }
  return kind
}

/** `abc1234` from a full sha, for labels. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

/** How the header describes where HEAD is. */
export function describeHead(repo: GitRepoView): string {
  if (repo.head.unborn) return `${repo.branch ?? 'main'} · no commits yet`
  if (repo.head.detached) return `detached at ${repo.head.oid !== null ? shortSha(repo.head.oid) : 'HEAD'}`
  return repo.branch ?? 'no branch'
}

/** `↑1 ↓2`-style summary, or '' when in sync. */
export function syncSummary(repo: GitRepoView): { ahead: number; behind: number; text: string } {
  const { ahead, behind } = repo.head
  const parts: string[] = []
  if (ahead > 0) parts.push(`${ahead} outgoing`)
  if (behind > 0) parts.push(`${behind} incoming`)
  return { ahead, behind, text: parts.join(' / ') }
}

/** The name an operation in progress is shown under. */
export const OPERATION_LABEL: Record<string, string> = {
  merge: 'Merge', rebase: 'Rebase', 'cherry-pick': 'Cherry-pick', revert: 'Revert', bisect: 'Bisect',
}

/** The repository-relative spelling of a status row, which every `git.*` call takes. */
export function repoPathOf(file: { path: string; repoPath?: string }): string {
  return file.repoPath ?? file.path
}

/**
 * Opens a file the way git names it — repository-relative — as a tab. The host says where
 * that is in the workspace: for a repository nested in a folder, or a folder that is a
 * subdirectory of its repository, git's spelling and the workspace's are not the same
 * string, and opening `src/app.ts` from a commit in `work/one` used to open `src/app.ts`
 * at the workspace root, or nothing. A file outside every folder cannot be opened here,
 * and says so.
 */
export async function openRepoFile(
  client: ProtocolClient,
  root: string,
  repoPath: string,
  face: 'file' | 'diff',
  onOpenFile: (path: string, face?: 'file' | 'diff') => void,
): Promise<void> {
  try {
    const r = await client.call('git.address', { root, paths: [repoPath] })
    const path = Array.isArray(r.paths) ? r.paths[0] ?? null : null
    if (path === null) {
      toast.push({ title: `${repoPath} is outside this workspace's folders`, description: 'Add the folder that holds it to the workspace to open it here.', tone: 'error' })
      return
    }
    onOpenFile(path, face)
  } catch (e) {
    toast.push({ title: 'Could not open the file', description: (e as Error).message, tone: 'error' })
  }
}
