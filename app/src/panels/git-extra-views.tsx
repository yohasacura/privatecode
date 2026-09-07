import type { VNode } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { FileDiff, GitCommit, History } from 'lucide-preact'
import type { GitBlameLine, GitChangedFile, GitCommitDetails, GitCommitRow } from '@core/host/protocol'
import type { ProtocolClient } from '../lib/client'
import { DiffView } from '../lib/diff'
import { relativeTime } from '../lib/format'
import { openRepoFile, shortSha } from '../lib/git-actions'
import type { GitView } from '../lib/git-views'
import { PanelEmpty, PanelError, PanelLoading } from '../components/panel'
import { Button } from '../ui/button'
import { Chip } from '../ui/chip'
import { cn } from '../ui/cn'
import { useContextMenu, type MenuItem } from '../ui/menu'
import { GitRepositoryView } from './git-repository'
import { MergeEditor } from './merge-editor'

type OpenFile = (path: string, face?: 'file' | 'diff') => void
type OpenView = (view: GitView) => void

/** The right-click on a changed file in a compare or commit view: open it (the host
 * translates git's spelling to the workspace's), its history, its blame, its path. */
function changedFileMenu(client: ProtocolClient, root: string, f: GitChangedFile, onOpenFile: OpenFile, onOpenView: OpenView): MenuItem[] {
  const gone = f.status === 'D'
  return [
    { id: 'open', label: 'Open file', disabled: gone, reason: gone ? 'deleted' : '', onSelect: () => { void openRepoFile(client, root, f.path, 'file', onOpenFile) } },
    { separator: true },
    { id: 'history', label: 'View history', icon: <History />, onSelect: () => onOpenView({ kind: 'history', root, repoPath: f.path, path: f.path }) },
    { id: 'blame', label: 'Blame (annotate)', disabled: gone, reason: gone ? 'deleted' : '', onSelect: () => onOpenView({ kind: 'blame', root, repoPath: f.path, path: f.path }) },
    { separator: true },
    { id: 'copy', label: 'Copy path', onSelect: () => { void navigator.clipboard?.writeText(f.path) } },
  ]
}

/**
 * The Git views that open as tabs, and the one switch that picks them: the repository
 * window, the merge editor, a comparison of two revisions (Compare Commits, Compare with
 * current branch), a file's blame, a file's history, and one commit on its own tab.
 */

export function GitViewHost({ client, view, reloadKey, onOpenFile, onOpenView }: {
  client: ProtocolClient
  view: GitView
  reloadKey: number
  onOpenFile: (path: string, face?: 'file' | 'diff') => void
  onOpenView: (view: GitView) => void
}): VNode {
  switch (view.kind) {
    case 'repo': return <GitRepositoryView client={client} root={view.root} label={view.label} reloadKey={reloadKey} onOpenFile={onOpenFile} onOpenView={onOpenView} />
    case 'merge': return <MergeEditor client={client} root={view.root} repoPath={view.repoPath} path={view.path} />
    case 'compare': return <CompareView client={client} root={view.root} from={view.from} to={view.to} fromLabel={view.fromLabel} toLabel={view.toLabel} onOpenFile={onOpenFile} onOpenView={onOpenView} />
    case 'blame': return <BlameView client={client} root={view.root} repoPath={view.repoPath} onOpenFile={onOpenFile} onOpenView={onOpenView} />
    case 'history': return <FileHistoryView client={client} root={view.root} repoPath={view.repoPath} onOpenFile={onOpenFile} onOpenView={onOpenView} />
    case 'commit': return <CommitView client={client} root={view.root} sha={view.sha} onOpenFile={onOpenFile} onOpenView={onOpenView} />
  }
}

function StatusLetter({ status }: { status: string }): VNode {
  return <span class={cn('w-3 shrink-0 font-mono text-[11px]', status === 'A' ? 'text-green' : status === 'D' ? 'text-red' : 'text-yellow')}>{status}</span>
}

/** A list of changed files with one file's diff beside it — the shape three views share. */
function FilesAndDiff({ files, diffOf, empty, menuFor }: {
  files: GitChangedFile[]
  diffOf: (path: string) => Promise<string>
  empty: string
  /** The right-click on a file row. */
  menuFor?: (f: GitChangedFile) => MenuItem[]
}): VNode {
  const [selected, setSelected] = useState<string | null>(files[0]?.path ?? null)
  const [diff, setDiff] = useState<string | null>(null)
  const ctx = useContextMenu()
  useEffect(() => { setSelected(files[0]?.path ?? null) }, [files])
  useEffect(() => {
    if (selected === null) return
    let cancelled = false
    setDiff(null)
    diffOf(selected).then((d) => { if (!cancelled) setDiff(d) }).catch((e: Error) => { if (!cancelled) setDiff(`could not read the diff: ${e.message}`) })
    return () => { cancelled = true }
  }, [selected, diffOf])
  if (files.length === 0) return <PanelEmpty icon={<FileDiff />} title={empty} />
  return (
    <div class="flex min-h-0 flex-1">
      <div class="flex w-[300px] shrink-0 flex-col overflow-auto border-r border-border-soft py-1 text-[12px]" data-compare-files="">
        {files.map((f) => (
          <button key={f.path} type="button" data-file={f.path} class={cn('flex items-center gap-1.5 px-2.5 py-0.5 text-left hover:bg-raised', selected === f.path && 'bg-accent-soft')} onClick={() => setSelected(f.path)} onContextMenu={menuFor !== undefined ? (e) => { setSelected(f.path); ctx.open(e, menuFor(f), 'File actions') } : undefined} title={f.oldPath !== undefined ? `${f.oldPath} → ${f.path}` : f.path}>
            <StatusLetter status={f.status} />
            <span class="min-w-0 flex-1 truncate">{f.path}</span>
            {!f.binary && <span class="shrink-0 font-mono text-[10.5px]"><span class="text-green">+{f.additions}</span> <span class="text-red">−{f.deletions}</span></span>}
          </button>
        ))}
      </div>
      <div class="min-w-0 flex-1 overflow-auto px-3 py-2">
        {diff === null ? <PanelLoading /> : diff.trim() === '' ? <div class="text-[12px] text-faint">No textual change.</div> : <DiffView content={diff} dense />}
      </div>
      {ctx.menu}
    </div>
  )
}

export function CompareView({ client, root, from, to, fromLabel, toLabel, onOpenFile, onOpenView }: {
  client: ProtocolClient
  root: string
  from: string
  to: string
  fromLabel: string
  toLabel: string
  onOpenFile: OpenFile
  onOpenView: OpenView
}): VNode {
  const [files, setFiles] = useState<GitChangedFile[] | null>(null)
  const [counts, setCounts] = useState<{ ahead: number; behind: number } | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    client.call('git.compare', { root, from, to })
      .then((r) => { if (cancelled) return; if (r.problem !== undefined) setFailed(r.problem); setFiles(r.files); setCounts({ ahead: r.ahead, behind: r.behind }) })
      .catch((e: Error) => { if (!cancelled) setFailed(e.message) })
    return () => { cancelled = true }
  }, [client, root, from, to])
  if (failed !== null) return <PanelError message={failed} />
  if (files === null) return <PanelLoading what="comparing…" />
  return (
    <div data-view="git-compare" class="flex h-full min-h-0 flex-col font-ui">
      <div class="flex items-center gap-2 border-b border-border-soft px-3 py-1.5 text-[12.5px]">
        <FileDiff class="size-4 text-accent" />
        <span class="font-medium">{fromLabel}</span>
        <span class="text-faint">→</span>
        <span class="font-medium">{toLabel}</span>
        {counts !== null && (
          <span class="text-[11.5px] text-faint">
            · {toLabel} has {counts.ahead} commit{counts.ahead === 1 ? '' : 's'} {fromLabel} does not; {fromLabel} has {counts.behind} {toLabel} does not
          </span>
        )}
        <span class="ml-auto text-[11.5px] text-faint">{files.length} file{files.length === 1 ? '' : 's'} differ</span>
      </div>
      <FilesAndDiff files={files} diffOf={(path) => client.call('git.diffBetween', { root, from, to, path }).then((r) => r.diff)} empty="Nothing differs between the two" menuFor={(f) => changedFileMenu(client, root, f, onOpenFile, onOpenView)} />
    </div>
  )
}

export function CommitView({ client, root, sha, onOpenFile, onOpenView }: {
  client: ProtocolClient
  root: string
  sha: string
  onOpenFile: OpenFile
  onOpenView: OpenView
}): VNode {
  const [details, setDetails] = useState<GitCommitDetails | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    client.call('git.commitDetails', { root, sha })
      .then((r) => { if (cancelled) return; if (r.details !== undefined) setDetails(r.details); else setFailed(r.problem ?? 'no such commit') })
      .catch((e: Error) => { if (!cancelled) setFailed(e.message) })
    return () => { cancelled = true }
  }, [client, root, sha])
  if (failed !== null) return <PanelError message={failed} />
  if (details === null) return <PanelLoading what="reading the commit…" />
  return (
    <div data-view="git-commit" class="flex h-full min-h-0 flex-col font-ui">
      <div class="border-b border-border-soft px-3 py-2">
        <div class="flex items-center gap-2">
          <GitCommit class="size-4 text-accent" />
          <span class="min-w-0 flex-1 truncate text-[13px] font-medium">{details.subject}</span>
          <span class="font-mono text-[11px] text-faint">{details.short}</span>
        </div>
        <div class="mt-0.5 text-[11.5px] text-dim">{details.authorName} <span class="text-faint">&lt;{details.authorEmail}&gt; · {new Date(details.authorDate).toLocaleString()}</span></div>
        {details.refs.length > 0 && <div class="mt-1 flex flex-wrap gap-1">{details.refs.filter((r) => r.kind !== 'head').map((r) => <Chip key={`${r.kind}:${r.name}`} tone={r.kind === 'tag' ? 'yellow' : 'blue'}>{r.name}</Chip>)}</div>}
        {details.body !== '' && <pre class="mt-1.5 whitespace-pre-wrap font-ui text-[12px]">{details.body}</pre>}
        <div class="mt-1 flex gap-1">
          {details.files[0] !== undefined && <Button size="sm" variant="ghost" onClick={() => { void openRepoFile(client, root, details.files[0]!.path, 'file', onOpenFile) }}>Open first file</Button>}
        </div>
      </div>
      <FilesAndDiff files={details.files} diffOf={(path) => client.call('git.diffBetween', { root, from: details.base, to: details.sha, path }).then((r) => r.diff)} empty="This commit changed no files" menuFor={(f) => changedFileMenu(client, root, f, onOpenFile, onOpenView)} />
    </div>
  )
}

export function FileHistoryView({ client, root, repoPath, onOpenFile, onOpenView }: {
  client: ProtocolClient
  root: string
  repoPath: string
  onOpenFile: OpenFile
  onOpenView: OpenView
}): VNode {
  const [commits, setCommits] = useState<GitCommitRow[] | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [selected, setSelected] = useState<GitCommitRow | null>(null)
  const [diff, setDiff] = useState<string | null>(null)
  const ctx = useContextMenu()
  const rowMenu = (c: GitCommitRow): MenuItem[] => [
    { id: 'open', label: 'Open commit in new tab', icon: <GitCommit />, onSelect: () => onOpenView({ kind: 'commit', root, sha: c.sha, short: c.short }) },
    { id: 'compare-head', label: 'Compare with HEAD', icon: <FileDiff />, onSelect: () => onOpenView({ kind: 'compare', root, from: c.sha, to: 'HEAD', fromLabel: shortSha(c.sha), toLabel: 'working tree at HEAD' }) },
    { id: 'file', label: 'Open the file as it is now', onSelect: () => { void openRepoFile(client, root, repoPath, 'file', onOpenFile) } },
    { id: 'blame', label: 'Blame (annotate)', onSelect: () => onOpenView({ kind: 'blame', root, repoPath, path: repoPath }) },
    { separator: true },
    { id: 'copy', label: 'Copy commit ID', onSelect: () => { void navigator.clipboard?.writeText(c.sha) } },
    { id: 'copy-msg', label: 'Copy message', onSelect: () => { void navigator.clipboard?.writeText(c.subject) } },
  ]
  useEffect(() => {
    let cancelled = false
    client.call('git.log', { root, paths: [repoPath], limit: 500 })
      .then((r) => { if (cancelled) return; if (r.problem !== undefined) setFailed(r.problem); setCommits(r.commits); setSelected(r.commits[0] ?? null) })
      .catch((e: Error) => { if (!cancelled) setFailed(e.message) })
    return () => { cancelled = true }
  }, [client, root, repoPath])
  useEffect(() => {
    if (selected === null) return
    let cancelled = false
    setDiff(null)
    const base = selected.parents[0] ?? '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
    client.call('git.diffBetween', { root, from: base, to: selected.sha, path: repoPath })
      .then((r) => { if (!cancelled) setDiff(r.diff) })
      .catch((e: Error) => { if (!cancelled) setDiff(`could not read the diff: ${e.message}`) })
    return () => { cancelled = true }
  }, [client, root, repoPath, selected])
  if (failed !== null) return <PanelError message={failed} />
  if (commits === null) return <PanelLoading what="reading the file's history…" />
  return (
    <div data-view="git-history" class="flex h-full min-h-0 flex-col font-ui">
      <div class="flex items-center gap-2 border-b border-border-soft px-3 py-1.5 text-[12.5px]">
        <History class="size-4 text-accent" />
        <span class="min-w-0 truncate font-medium" title={repoPath}>{repoPath}</span>
        <span class="text-[11.5px] text-faint">{commits.length} commit{commits.length === 1 ? '' : 's'}</span>
        {selected !== null && (
          <Button size="sm" variant="ghost" class="ml-auto" onClick={() => onOpenView({ kind: 'compare', root, from: selected.sha, to: 'HEAD', fromLabel: shortSha(selected.sha), toLabel: 'working tree at HEAD' })}>Compare with HEAD</Button>
        )}
      </div>
      {commits.length === 0 ? <PanelEmpty icon={<History />} title="No commits touch this file" /> : (
        <div class="flex min-h-0 flex-1">
          <div class="flex w-[340px] shrink-0 flex-col overflow-auto border-r border-border-soft py-1" data-history-commits="">
            {commits.map((c) => (
              <button key={c.sha} type="button" data-commit={c.sha} class={cn('flex flex-col px-2.5 py-1 text-left hover:bg-raised', selected?.sha === c.sha && 'bg-accent-soft')} onClick={() => setSelected(c)} onDblClick={() => onOpenView({ kind: 'commit', root, sha: c.sha, short: c.short })} onContextMenu={(e) => { setSelected(c); ctx.open(e, rowMenu(c), 'Commit actions') }}>
                <span class="truncate text-[12.5px]">{c.subject}</span>
                <span class="text-[11px] text-faint">{c.authorName} · {relativeTime(c.authorDate)} · <span class="font-mono">{c.short}</span></span>
              </button>
            ))}
          </div>
          <div class="min-w-0 flex-1 overflow-auto px-3 py-2">
            {diff === null ? <PanelLoading /> : diff.trim() === '' ? <div class="text-[12px] text-faint">No textual change in this commit.</div> : <DiffView content={diff} dense />}
          </div>
        </div>
      )}
      {ctx.menu}
    </div>
  )
}

export function BlameView({ client, root, repoPath, onOpenFile, onOpenView }: {
  client: ProtocolClient
  root: string
  repoPath: string
  onOpenFile: OpenFile
  onOpenView: OpenView
}): VNode {
  const [lines, setLines] = useState<GitBlameLine[] | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const ctx = useContextMenu()
  const lineMenu = (l: GitBlameLine): MenuItem[] => [
    { id: 'commit', label: `Open commit ${l.short}`, icon: <GitCommit />, onSelect: () => onOpenView({ kind: 'commit', root, sha: l.sha, short: l.short }) },
    { id: 'history', label: 'View history of this file', icon: <History />, onSelect: () => onOpenView({ kind: 'history', root, repoPath, path: repoPath }) },
    { id: 'file', label: 'Open the file', onSelect: () => { void openRepoFile(client, root, repoPath, 'file', onOpenFile) } },
    { separator: true },
    { id: 'copy', label: 'Copy commit ID', onSelect: () => { void navigator.clipboard?.writeText(l.sha) } },
    { id: 'copy-line', label: 'Copy line', onSelect: () => { void navigator.clipboard?.writeText(l.text) } },
  ]
  useEffect(() => {
    let cancelled = false
    client.call('git.blame', { root, path: repoPath })
      .then((r) => { if (cancelled) return; if (r.problem !== undefined) setFailed(r.problem); else setLines(r.lines) })
      .catch((e: Error) => { if (!cancelled) setFailed(e.message) })
    return () => { cancelled = true }
  }, [client, root, repoPath])
  if (failed !== null) return <PanelError message={failed} />
  if (lines === null) return <PanelLoading what="annotating…" />
  // Runs of the same commit share one label, the way an editor margin does.
  let previous = ''
  return (
    <div data-view="git-blame" class="flex h-full min-h-0 flex-col font-ui">
      <div class="flex items-center gap-2 border-b border-border-soft px-3 py-1.5 text-[12.5px]">
        <History class="size-4 text-accent" />
        <span class="min-w-0 truncate font-medium" title={repoPath}>{repoPath}</span>
        <span class="text-[11.5px] text-faint">blame — who last touched each line</span>
      </div>
      <div class="min-h-0 flex-1 overflow-auto font-mono text-[11.5px] leading-[1.5]">
        {lines.map((l) => {
          const same = l.sha === previous
          previous = l.sha
          return (
            <div key={l.line} class={cn('flex hover:bg-raised', !same && 'border-t border-border-soft')} data-blame-line={l.line} onContextMenu={(e) => ctx.open(e, lineMenu(l), 'Line actions')}>
              <button
                type="button"
                class={cn('w-[230px] shrink-0 truncate px-2 text-left font-ui text-[11px] hover:text-accent', same ? 'text-transparent' : 'text-dim')}
                title={`${l.short} · ${l.author} · ${new Date(l.date).toLocaleString()}\n${l.summary}`}
                onClick={() => onOpenView({ kind: 'commit', root, sha: l.sha, short: l.short })}
                tabIndex={same ? -1 : 0}
              >
                <span class="text-faint">{l.short}</span> {l.author} · {relativeTime(l.date)}
              </button>
              <span class="w-10 shrink-0 select-none text-right text-faint">{l.line}</span>
              <pre class="min-w-0 flex-1 whitespace-pre px-2">{l.text}</pre>
            </div>
          )
        })}
      </div>
      {ctx.menu}
    </div>
  )
}
