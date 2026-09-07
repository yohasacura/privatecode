/**
 * The Git views that open as TABS beside the chat, the way a file does: the repository
 * window (branches, graph, commit details), the merge editor for one conflicted file, a
 * comparison of two revisions, a file's blame and a file's history. Each has a key the tab
 * strip dedupes on and a name the tab shows.
 */

export type GitView =
  | { kind: 'repo'; root: string; label: string }
  | { kind: 'merge'; root: string; repoPath: string; path: string }
  | { kind: 'compare'; root: string; from: string; to: string; fromLabel: string; toLabel: string }
  | { kind: 'blame'; root: string; repoPath: string; path: string }
  | { kind: 'history'; root: string; repoPath: string; path: string }
  | { kind: 'commit'; root: string; sha: string; short: string }

export function viewKey(v: GitView): string {
  switch (v.kind) {
    case 'repo': return `git:repo:${v.root}`
    case 'merge': return `git:merge:${v.root}:${v.repoPath}`
    case 'compare': return `git:compare:${v.root}:${v.from}..${v.to}`
    case 'blame': return `git:blame:${v.root}:${v.repoPath}`
    case 'history': return `git:history:${v.root}:${v.repoPath}`
    case 'commit': return `git:commit:${v.root}:${v.sha}`
  }
}

function base(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

export function viewTitle(v: GitView): string {
  switch (v.kind) {
    case 'repo': return `Git · ${v.label}`
    case 'merge': return `Merge · ${base(v.repoPath)}`
    case 'compare': return `${v.fromLabel} ↔ ${v.toLabel}`
    case 'blame': return `Blame · ${base(v.repoPath)}`
    case 'history': return `History · ${base(v.repoPath)}`
    case 'commit': return `Commit ${v.short}`
  }
}

/** Dispatched on `window` to bring the inspector's Git tab forward from anywhere — the
 * status bar's branch chip, mostly. */
export const SHOW_GIT_EVENT = 'privatecode:show-git'

export function isGitViewKey(key: string): boolean {
  return key.startsWith('git:')
}
