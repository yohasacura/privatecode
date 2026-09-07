import type { VNode } from 'preact'
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import {
  Archive, ArrowDown, ArrowUp, Check, ChevronDown, Download, FileDiff, FolderGit2, GitBranch, GitMerge, History,
  MoreHorizontal, RefreshCw, Search, Undo2,
} from 'lucide-preact'
import type { GitFileChange, GitRefs, GitRepoView, GitStashEntry, GitStatusResult } from '@core/host/protocol'
import type { ProtocolClient } from '../lib/client'
import { relativeTime } from '../lib/format'
import { OPERATION_LABEL, announce, describeHead, kindOf, repoPathOf, shortSha, syncSummary, type Outcome } from '../lib/git-actions'
import { letterOf } from '../lib/git-scm'
import type { GitView } from '../lib/git-views'
import { DiffView } from '../lib/diff'
import { Icon } from '../components/icons'
import { PanelEmpty, PanelError, PanelLoading, PanelNote, PanelSection } from '../components/panel'
import { Button, IconButton } from '../ui/button'
import { cn } from '../ui/cn'
import { Dialog } from '../ui/dialog'
import { Input, Textarea } from '../ui/input'
import { Menu, type MenuItem } from '../ui/menu'
import { Popover } from '../ui/popover'
import { Select } from '../ui/select'
import { Switch } from '../ui/switch'
import { toast } from '../ui/toast'
import { ConfirmDialog, NewBranchDialog, PublishDialog, PushBehindDialog, StashDialog } from './git-dialogs'

/**
 * Git Changes — Visual Studio's window of that name, as the inspector's Git tab.
 *
 * Top to bottom, the same anatomy: the repository (when the workspace holds several), the
 * branch with its picker, the outgoing/incoming count as a link into the repository
 * window, the fetch/pull/push/sync buttons; then the commit box with Commit All / Commit
 * Staged and their "and Push" / "and Sync" forms, Amend, and the stash forms; then the
 * lists — Unmerged Changes when there are conflicts, Staged Changes, Changes, Stashes —
 * with stage/unstage/undo on every row and a menu for the rest.
 *
 * The tab polls `git.status` every few seconds while it is the one showing, so an edit
 * made in another program appears without a click; the tree's own git badges keep their
 * focus-driven reload and are not doubled.
 */

const POLL_MS = 3000

type Dialog =
  | { kind: 'new-branch' }
  | { kind: 'stash' }
  | { kind: 'discard'; paths: string[]; label: string }
  | { kind: 'push-behind' }
  | { kind: 'publish' }
  | { kind: 'drop-stash'; entry: GitStashEntry }
  | { kind: 'show-stash'; entry: GitStashEntry; diff: string | null }
  | { kind: 'abort-operation'; operation: string }
  | { kind: 'init'; mount: string }

interface FileRowProps {
  file: GitFileChange
  section: 'conflict' | 'staged' | 'change'
  busy: boolean
  onOpen: () => void
  onStage: () => void
  onUnstage: () => void
  onUndo: () => void
  onMenu: () => MenuItem[]
}

function splitPath(path: string): { dir: string; name: string } {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? { dir: '', name: path } : { dir: path.slice(0, cut), name: path.slice(cut + 1) }
}

function FileRow({ file, section, busy, onOpen, onStage, onUnstage, onUndo, onMenu }: FileRowProps): VNode {
  const letter = letterOf(file.code)
  const { dir, name } = splitPath(file.path)
  const staged = section === 'staged'
  return (
    <div
      data-git-row={file.path}
      data-section={section}
      class={cn(
        'group flex min-h-7 items-center gap-2 py-0.5 pl-2.5 pr-1.5 transition-colors duration-(--duration-fast) hover:bg-raised',
        section === 'conflict' && 'text-red',
      )}
    >
      <span class={cn('flex shrink-0', section === 'conflict' ? 'text-red' : staged ? 'text-accent' : 'text-dim')} title={file.code}>
        {Icon.gitMark(letter, staged)}
      </span>
      <button
        type="button"
        class="flex min-w-0 flex-1 items-baseline gap-1.5 truncate border-0 bg-transparent p-0 text-left font-ui text-[12.5px] text-fg hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        onClick={onOpen}
        title={`${file.path} — open the diff`}
      >
        <span class="truncate">{name}</span>
        {dir !== '' && <span class="truncate text-[11px] text-faint">{dir}</span>}
      </button>
      <span class="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-(--duration-fast) group-hover:opacity-100 focus-within:opacity-100">
        {section === 'change' && (
          <>
            <IconButton size="sm" label="Undo changes" title="Undo Changes — put the file back to the last commit" disabled={busy} onClick={onUndo}><Undo2 /></IconButton>
            <IconButton size="sm" label="Stage" title="Stage — include in the next commit" disabled={busy} onClick={onStage}>{Icon.plus()}</IconButton>
          </>
        )}
        {section === 'staged' && (
          <IconButton size="sm" label="Unstage" title="Unstage — keep the change, take it out of the commit" disabled={busy} onClick={onUnstage}>{Icon.minus()}</IconButton>
        )}
        {section === 'conflict' && (
          <IconButton size="sm" label="Open merge editor" title="Open Merge Editor" disabled={busy} onClick={onOpen}><GitMerge /></IconButton>
        )}
        <Menu
          label="File actions"
          items={onMenu()}
          align="end"
          trigger={(props) => <IconButton {...props} size="sm" label="More actions"><MoreHorizontal /></IconButton>}
        />
      </span>
    </div>
  )
}

export function GitTab({ client, reloadKey, active, onOpenFile, onOpenView, onOpenSettings }: {
  client: ProtocolClient
  reloadKey: number
  /** Whether this is the tab showing — the poll runs only then. */
  active: boolean
  onOpenFile: (path: string, face?: 'file' | 'diff') => void
  onOpenView: (view: GitView) => void
  onOpenSettings?: () => void
}): VNode {
  const [status, setStatus] = useState<GitStatusResult | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [gitMissing, setGitMissing] = useState(false)
  const [selectedRoot, setSelectedRoot] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [amend, setAmend] = useState(false)
  const [stashes, setStashes] = useState<GitStashEntry[]>([])
  const [refs, setRefs] = useState<GitRefs | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [branchOpen, setBranchOpen] = useState(false)
  const [branchFilter, setBranchFilter] = useState('')
  const [sectionOpen, setSectionOpen] = useState<Record<string, boolean>>({ conflict: true, staged: true, change: true, stash: true })
  const branchAnchor = useRef<HTMLButtonElement>(null)
  const busyRef = useRef(false)
  busyRef.current = busy !== null

  const repos = status?.repos ?? []
  const repo: GitRepoView | undefined = repos.find((r) => r.root === selectedRoot) ?? repos[0]

  const load = useCallback((quiet = true) => {
    client.call('git.status', {})
      .then(async (r) => {
        setStatus(r)
        setProblem(r.problem ?? null)
        const current = r.repos.find((x) => x.root === selectedRoot) ?? r.repos[0]
        if (current !== undefined && current.stashes > 0) {
          const list = await client.call('git.stashList', { root: current.root })
          setStashes(list.stashes)
        } else {
          setStashes([])
        }
      })
      .catch((e: Error) => { if (!quiet) setProblem(e.message); else setProblem((p) => p ?? e.message) })
  }, [client, selectedRoot])

  useEffect(() => {
    client.call('git.version', {}).then((r) => setGitMissing(r.version === null)).catch(() => {})
  }, [client])

  useEffect(() => { load(false) }, [load, reloadKey])
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => { if (!busyRef.current && !document.hidden) load() }, POLL_MS)
    return () => clearInterval(id)
  }, [active, load])

  // The branch picker and the New branch dialog want every ref; loaded when either opens.
  const loadRefs = useCallback(() => {
    if (repo === undefined) return
    client.call('git.refs', { root: repo.root })
      .then((r) => { if (r.local !== undefined) setRefs({ local: r.local, remote: r.remote ?? [], tags: r.tags ?? [] }) })
      .catch(() => {})
  }, [client, repo])
  useEffect(() => { if (branchOpen || dialog?.kind === 'new-branch') loadRefs() }, [branchOpen, dialog?.kind, loadRefs])

  const files = repo?.files ?? []
  const isConflict = (f: GitFileChange): boolean => letterOf(f.code) === '!'
  const conflicts = files.filter(isConflict)
  const staged = files.filter((f) => !isConflict(f) && f.staged)
  const changes = files.filter((f) => !isConflict(f) && (f.untracked || (f.code[1] !== undefined && f.code[1] !== ' ')))

  /** Runs one operation with the panel locked, announces it, and reloads. */
  async function run<R extends Outcome>(label: string, call: () => Promise<R>, done: string): Promise<R | null> {
    if (busyRef.current) return null
    setBusy(label)
    try {
      const r = await call()
      announce(r, done)
      return r
    } catch (e) {
      toast.push({ title: `${label} failed`, description: (e as Error).message, tone: 'error' })
      return null
    } finally {
      setBusy(null)
      load()
    }
  }

  const root = repo?.root ?? ''
  const paths = (list: GitFileChange[]): string[] => list.flatMap((f) => (f.repoOldPath !== undefined ? [repoPathOf(f), f.repoOldPath] : [repoPathOf(f)]))

  const stage = (list: GitFileChange[]): void => { void run('Stage', () => client.call('git.stagePaths', { root, paths: paths(list) }), `Staged ${list.length === 1 ? list[0]!.path : `${list.length} files`}`) }
  const unstage = (list: GitFileChange[]): void => { void run('Unstage', () => client.call('git.unstagePaths', { root, paths: paths(list) }), `Unstaged ${list.length === 1 ? list[0]!.path : `${list.length} files`}`) }
  const discard = (list: GitFileChange[]): void => {
    setDialog({ kind: 'discard', paths: list.map(repoPathOf), label: list.length === 1 ? list[0]!.path : `${list.length} files` })
  }

  async function commit(all: boolean, then: 'push' | 'sync' | null): Promise<void> {
    const r = await run('Commit', () => client.call('git.commitIndex', { root, message, all, amend }), amend ? 'Commit amended' : 'Committed')
    if (r === null || !r.ok) return
    setMessage('')
    setAmend(false)
    if (then === 'push') await push({})
    if (then === 'sync') await sync()
  }

  async function push(opts: { setUpstream?: boolean; forceWithLease?: boolean; remote?: string }): Promise<boolean> {
    const r = await run('Push', () => client.call('git.push', { root, ...opts }), 'Pushed')
    if (r === null) return false
    const kind = kindOf(r)
    if (kind === 'behind') setDialog({ kind: 'push-behind' })
    else if (kind === 'no-upstream') setDialog({ kind: 'publish' })
    return r.ok
  }
  async function pull(rebase = false): Promise<boolean> {
    const r = await run('Pull', () => client.call('git.pull', { root, rebase }), 'Pulled')
    if (r !== null && kindOf(r) === 'conflict') toast.push({ title: 'The pull stopped on conflicts', description: 'Resolve them under Unmerged Changes, then Continue.', tone: 'error', duration: 8000 })
    return r?.ok === true
  }
  async function sync(): Promise<boolean> {
    const r = await run('Sync', () => client.call('git.sync', { root }), 'Synced')
    if (r === null) return false
    const kind = kindOf(r)
    if (kind === 'behind') setDialog({ kind: 'push-behind' })
    else if (kind === 'no-upstream') setDialog({ kind: 'publish' })
    else if (kind === 'conflict') toast.push({ title: 'The pull stopped on conflicts', description: 'Resolve them under Unmerged Changes, then Continue.', tone: 'error', duration: 8000 })
    return r.ok
  }
  const fetch = (): void => { void run('Fetch', () => client.call('git.fetch', { root, prune: true }), 'Fetched') }

  const switchTo = (name: string): void => {
    setBranchOpen(false)
    void run('Checkout', () => client.call('git.switch', { root, name }), `Checked out ${name}`)
  }

  const operation = (action: 'continue' | 'abort' | 'skip'): void => {
    void run(action === 'abort' ? 'Abort' : 'Continue', () => client.call('git.operation', { root, action }), action === 'abort' ? 'Aborted' : 'Continued')
  }

  const openMerge = (f: GitFileChange): void => onOpenView({ kind: 'merge', root, repoPath: repoPathOf(f), path: f.path })

  const fileMenu = (f: GitFileChange, section: 'conflict' | 'staged' | 'change'): MenuItem[] => {
    const rp = repoPathOf(f)
    const items: MenuItem[] = [
      { id: 'open', label: 'Open file', onSelect: () => onOpenFile(f.path, 'file') },
      { id: 'diff', label: 'View diff', icon: <FileDiff />, onSelect: () => onOpenFile(f.path, 'diff') },
      { separator: true },
    ]
    if (section === 'conflict') {
      items.push(
        { id: 'merge', label: 'Open Merge Editor', icon: <GitMerge />, onSelect: () => openMerge(f) },
        { id: 'keep-ours', label: 'Keep Current (ours)', onSelect: () => { void run('Resolve', () => client.call('git.keepSide', { root, path: rp, side: 'ours' }), `Kept your side of ${f.path}`) } },
        { id: 'keep-theirs', label: 'Take Incoming (theirs)', onSelect: () => { void run('Resolve', () => client.call('git.keepSide', { root, path: rp, side: 'theirs' }), `Took the incoming ${f.path}`) } },
        { id: 'resolved', label: 'Mark as resolved (stage as is)', onSelect: () => stage([f]) },
        { separator: true },
      )
    } else if (section === 'staged') {
      items.push({ id: 'unstage', label: 'Unstage', onSelect: () => unstage([f]) })
    } else {
      items.push(
        { id: 'stage', label: 'Stage', onSelect: () => stage([f]) },
        { id: 'undo', label: 'Undo Changes…', icon: <Undo2 />, danger: true, onSelect: () => discard([f]) },
      )
      if (f.untracked) {
        items.push({ id: 'ignore', label: 'Ignore this file', onSelect: () => { void run('Ignore', () => client.call('git.ignore', { root, pattern: `/${rp}` }), `Ignored ${f.path}`) } })
        const ext = rp.includes('.') ? rp.slice(rp.lastIndexOf('.')) : ''
        if (ext !== '' && !rp.endsWith('/')) {
          items.push({ id: 'ignore-ext', label: `Ignore all *${ext} files`, onSelect: () => { void run('Ignore', () => client.call('git.ignore', { root, pattern: `*${ext}` }), `Ignored *${ext}`) } })
        }
      }
    }
    items.push(
      { separator: true },
      { id: 'history', label: 'View history', icon: <History />, disabled: f.untracked, reason: f.untracked ? 'not committed yet' : '', onSelect: () => onOpenView({ kind: 'history', root, repoPath: rp, path: f.path }) },
      { id: 'blame', label: 'Blame (annotate)', disabled: f.untracked, reason: f.untracked ? 'not committed yet' : '', onSelect: () => onOpenView({ kind: 'blame', root, repoPath: rp, path: f.path }) },
      { id: 'copy', label: 'Copy path', onSelect: () => { void navigator.clipboard?.writeText(rp) } },
    )
    return items
  }

  const stashMenu = (entry: GitStashEntry): MenuItem[] => [
    { id: 'view', label: 'View changes', icon: <FileDiff />, onSelect: () => {
      setDialog({ kind: 'show-stash', entry, diff: null })
      client.call('git.stashShow', { root, index: entry.index }).then((r) => setDialog((d) => (d?.kind === 'show-stash' && d.entry.index === entry.index ? { ...d, diff: r.diff } : d))).catch(() => {})
    } },
    { separator: true },
    { id: 'apply', label: 'Apply', onSelect: () => { void run('Apply stash', () => client.call('git.stashApply', { root, index: entry.index, pop: false, restoreIndex: true }), 'Stash applied') } },
    { id: 'apply-unstaged', label: 'Apply as unstaged', onSelect: () => { void run('Apply stash', () => client.call('git.stashApply', { root, index: entry.index, pop: false, restoreIndex: false }), 'Stash applied') } },
    { id: 'pop', label: 'Pop', onSelect: () => { void run('Pop stash', () => client.call('git.stashApply', { root, index: entry.index, pop: true, restoreIndex: true }), 'Stash popped') } },
    { id: 'pop-unstaged', label: 'Pop as unstaged', onSelect: () => { void run('Pop stash', () => client.call('git.stashApply', { root, index: entry.index, pop: true, restoreIndex: false }), 'Stash popped') } },
    { separator: true },
    { id: 'drop', label: 'Drop', danger: true, onSelect: () => setDialog({ kind: 'drop-stash', entry }) },
  ]

  const canCommit = (all: boolean): boolean => busy === null && repo !== undefined && (all ? files.length > 0 : staged.length > 0) && conflicts.length === 0 && (message.trim() !== '' || amend)
  const commitMenu: MenuItem[] = [
    { id: 'all', label: 'Commit All', disabled: !canCommit(true), onSelect: () => { void commit(true, null) } },
    { id: 'staged', label: 'Commit Staged', disabled: !canCommit(false), onSelect: () => { void commit(false, null) } },
    { separator: true },
    { id: 'all-push', label: 'Commit All and Push', disabled: !canCommit(true), onSelect: () => { void commit(true, 'push') } },
    { id: 'all-sync', label: 'Commit All and Sync', disabled: !canCommit(true), onSelect: () => { void commit(true, 'sync') } },
    { id: 'staged-push', label: 'Commit Staged and Push', disabled: !canCommit(false), onSelect: () => { void commit(false, 'push') } },
    { id: 'staged-sync', label: 'Commit Staged and Sync', disabled: !canCommit(false), onSelect: () => { void commit(false, 'sync') } },
    { separator: true },
    { id: 'stash', label: 'Stash All…', icon: <Archive />, disabled: files.length === 0, onSelect: () => setDialog({ kind: 'stash' }) },
  ]
  const moreMenu: MenuItem[] = [
    { id: 'fetch-prune', label: 'Fetch (prune deleted branches)', onSelect: fetch },
    { id: 'pull-rebase', label: 'Pull with rebase', onSelect: () => { void pull(true) } },
    { id: 'push-tags', label: 'Push with tags', onSelect: () => { void run('Push', () => client.call('git.push', { root, tags: true }), 'Pushed with tags') } },
    { id: 'publish', label: 'Publish branch…', onSelect: () => setDialog({ kind: 'publish' }) },
    { separator: true },
    { id: 'repo', label: 'Open Git Repository', icon: <FolderGit2 />, onSelect: () => { if (repo) onOpenView({ kind: 'repo', root: repo.root, label: repo.label }) } },
    { id: 'new-branch', label: 'New Branch…', icon: <GitBranch />, onSelect: () => setDialog({ kind: 'new-branch' }) },
    ...(onOpenSettings !== undefined ? [{ id: 'settings', label: 'Git Settings…', onSelect: onOpenSettings } as MenuItem] : []),
  ]

  // ----------------------------------------------------------------------------------------

  if (gitMissing) {
    return (
      <div class="p-3">
        <PanelNote tone="bad">
          <b>Git is not installed.</b> Nothing here works without <code>git</code> on the PATH. Install Git for Windows, then reopen the workspace.
        </PanelNote>
      </div>
    )
  }
  if (status === null && problem === null) return <PanelLoading what="reading the repository…" />
  if (status === null) return <PanelError message={problem ?? 'git status failed'} onRetry={() => load(false)} />

  if (repo === undefined) {
    return (
      <div class="flex flex-col gap-2 p-3" data-panel="git">
        <PanelEmpty
          icon={<FolderGit2 />}
          title="Not under version control"
          hint="None of the workspace's folders is a git repository yet."
        />
        {status.unversioned.map((u) => (
          <PanelNote key={u.mount} inset>
            <div class="flex items-center justify-between gap-2">
              <span class="truncate">{u.mount}</span>
              <Button size="sm" variant="primary" onClick={() => setDialog({ kind: 'init', mount: u.mount })}>Create Git repository</Button>
            </div>
          </PanelNote>
        ))}
        {dialog?.kind === 'init' && (
          <ConfirmDialog
            open
            onCancel={() => setDialog(null)}
            title={`Create a Git repository in ${dialog.mount}?`}
            description="Runs git init. Nothing is committed yet; the files appear under Changes for the first commit."
            confirmLabel="Create repository"
            danger={false}
            onConfirm={async () => { const r = await run('Init', () => client.call('git.init', { mount: dialog.mount }), 'Repository created'); return r?.ok === true }}
          />
        )}
      </div>
    )
  }

  const head = repo.head
  const summary = syncSummary(repo)
  const locals = refs?.local.map((b) => b.name) ?? []
  const remotes = refs?.remote.map((b) => b.name) ?? []
  const remoteNames = [...new Set(refs?.remote.map((b) => b.remote ?? '').filter((n) => n !== ''))]
  const filter = branchFilter.trim().toLowerCase()
  const shownLocals = locals.filter((n) => n.toLowerCase().includes(filter))
  const shownRemotes = remotes.filter((n) => n.toLowerCase().includes(filter))
  const primaryAll = staged.length === 0
  const toggle = (key: string): void => setSectionOpen((s) => ({ ...s, [key]: !(s[key] ?? true) }))

  return (
    <div data-panel="git" class="flex h-full min-h-0 flex-col font-ui">
      {/* Header: repository, branch, sync state, network buttons */}
      <div class="flex flex-col gap-1.5 border-b border-border-soft px-2.5 py-2">
        {repos.length > 1 && (
          <Select value={repo.root} aria-label="Repository" onChange={(e) => { setSelectedRoot(e.currentTarget.value); setRefs(null) }} class="h-7 text-[12px]">
            {repos.map((r) => <option key={r.root} value={r.root}>{r.label}</option>)}
          </Select>
        )}
        <div class="flex items-center gap-1">
          <button
            ref={branchAnchor}
            type="button"
            data-action="branch-picker"
            class={cn(
              'flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border-soft bg-raised px-2 py-1 text-left text-[12.5px] hover:bg-active',
              'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
            )}
            aria-haspopup="dialog"
            aria-expanded={branchOpen}
            title={head.upstream !== null ? `tracks ${head.upstream}` : 'no upstream branch'}
            onClick={() => setBranchOpen((o) => !o)}
          >
            <GitBranch class="size-3.5 shrink-0 text-accent" />
            <span class="truncate font-medium">{describeHead(repo)}</span>
            <ChevronDown class="ml-auto size-3.5 shrink-0 text-faint" />
          </button>
          <IconButton size="sm" label="Fetch" title="Fetch — learn what the remote has, change nothing" disabled={busy !== null} onClick={fetch}><Download /></IconButton>
          <IconButton size="sm" label="Pull" title="Pull — bring the remote's commits into this branch" disabled={busy !== null} onClick={() => { void pull() }}><ArrowDown /></IconButton>
          <IconButton size="sm" label="Push" title="Push — send this branch's commits to the remote" disabled={busy !== null} onClick={() => { void push({}) }}><ArrowUp /></IconButton>
          <IconButton size="sm" label="Sync" title="Sync — pull, then push" disabled={busy !== null} onClick={() => { void sync() }}><RefreshCw /></IconButton>
          <Menu label="More git actions" items={moreMenu} align="end" trigger={(props) => <IconButton {...props} size="sm" label="More"><MoreHorizontal /></IconButton>} />
        </div>
        <div class="flex items-center gap-2 text-[11.5px] text-faint">
          {busy !== null
            ? <span class="text-accent" data-git-busy={busy}>{busy}…</span>
            : (
              <button
                type="button"
                data-action="open-repository"
                class="cursor-pointer border-0 bg-transparent p-0 text-left text-[11.5px] text-faint hover:text-accent"
                title="Open the Git Repository window"
                onClick={() => onOpenView({ kind: 'repo', root: repo.root, label: repo.label })}
              >
                {head.upstream === null
                  ? (head.unborn ? 'no commits yet' : 'no upstream — publish the branch to push')
                  : summary.text !== '' ? `${summary.ahead > 0 ? `↑${summary.ahead} ` : ''}${summary.behind > 0 ? `↓${summary.behind} ` : ''}${summary.text}` : `in sync with ${head.upstream}`}
              </button>
              )}
          {repos.length === 1 && repo.relation !== 'folder' && <span class="ml-auto truncate" title={repo.root}>{repo.label}</span>}
        </div>
      </div>

      <Popover open={branchOpen} onOpenChange={setBranchOpen} anchor={branchAnchor} label="Branches" class="w-[280px]">
        <div class="flex flex-col" data-branch-picker="">
          <div class="flex items-center gap-1.5 border-b border-border-soft px-2 py-1.5">
            <Search class="size-3.5 text-faint" />
            <Input
              class="h-6 flex-1 text-[12px]"
              placeholder="Filter branches"
              value={branchFilter}
              aria-label="Filter branches"
              onInput={(e) => setBranchFilter(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && shownLocals[0] !== undefined) switchTo(shownLocals[0]) }}
            />
          </div>
          <div class="max-h-[260px] overflow-auto py-1">
            {refs === null && <div class="px-3 py-2 text-[12px] text-faint">loading…</div>}
            {refs !== null && shownLocals.length === 0 && shownRemotes.length === 0 && <div class="px-3 py-2 text-[12px] text-faint">no branch matches</div>}
            {shownLocals.length > 0 && <div class="px-3 pb-0.5 pt-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-faint">Local</div>}
            {shownLocals.map((n) => (
              <button key={n} type="button" data-branch={n} class={cn('flex w-full items-center gap-2 px-3 py-1 text-left text-[12.5px] hover:bg-raised', n === repo.branch && 'text-accent')} onClick={() => switchTo(n)}>
                <span class="w-3.5">{n === repo.branch && <Check class="size-3.5" />}</span>
                <span class="truncate">{n}</span>
              </button>
            ))}
            {shownRemotes.length > 0 && <div class="px-3 pb-0.5 pt-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-faint">Remote</div>}
            {shownRemotes.map((n) => (
              <button key={n} type="button" data-branch={n} class="flex w-full items-center gap-2 px-3 py-1 text-left text-[12.5px] text-dim hover:bg-raised" onClick={() => switchTo(n)}>
                <span class="w-3.5" />
                <span class="truncate">{n}</span>
              </button>
            ))}
          </div>
          <div class="flex items-center gap-1 border-t border-border-soft px-2 py-1.5">
            <Button size="sm" icon={<GitBranch />} onClick={() => { setBranchOpen(false); setDialog({ kind: 'new-branch' }) }}>New branch…</Button>
            <Button size="sm" variant="ghost" onClick={() => { setBranchOpen(false); onOpenView({ kind: 'repo', root: repo.root, label: repo.label }) }}>Manage branches</Button>
          </div>
        </div>
      </Popover>

      <div class="min-h-0 flex-1 overflow-auto">
        {/* Banners */}
        {repo.operation !== null && (
          <div class="px-2.5 pt-2">
            <PanelNote tone="warn">
              <div class="flex flex-col gap-1.5">
                <b>{`${OPERATION_LABEL[repo.operation] ?? repo.operation} in progress`}</b>
                <span>
                  {conflicts.length > 0
                    ? `${conflicts.length} file${conflicts.length === 1 ? '' : 's'} conflict. Resolve ${conflicts.length === 1 ? 'it' : 'them'} under Unmerged Changes, then Continue.`
                    : 'Every conflict is resolved. Continue to finish it, or Abort to go back to where you were.'}
                </span>
                <span class="flex gap-1.5">
                  <Button size="sm" variant="primary" disabled={busy !== null || conflicts.length > 0} onClick={() => operation('continue')} data-action="continue">Continue</Button>
                  {repo.operation !== 'merge' && <Button size="sm" disabled={busy !== null} onClick={() => operation('skip')}>Skip</Button>}
                  <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => setDialog({ kind: 'abort-operation', operation: repo.operation ?? 'merge' })} data-action="abort">Abort</Button>
                </span>
              </div>
            </PanelNote>
          </div>
        )}
        {head.detached && repo.operation === null && (
          <div class="px-2.5 pt-2">
            <PanelNote tone="warn">
              <div class="flex items-center justify-between gap-2">
                <span><b>Detached HEAD.</b> You are on commit {head.oid !== null ? shortSha(head.oid) : ''}, not a branch. New commits here are kept only if a branch points at them.</span>
                <Button size="sm" onClick={() => setDialog({ kind: 'new-branch' })}>New branch…</Button>
              </div>
            </PanelNote>
          </div>
        )}
        {head.upstreamGone && (
          <div class="px-2.5 pt-2"><PanelNote inset>The upstream {head.upstream} no longer exists on the remote.</PanelNote></div>
        )}
        {repo.problem !== undefined && <div class="px-2.5 pt-2"><PanelNote tone="bad" inset>{repo.problem}</PanelNote></div>}

        {/* Commit box */}
        <div class="flex flex-col gap-1.5 px-2.5 pb-2 pt-2" data-commit-box="">
          <Textarea
            rows={2}
            class="min-h-[52px] text-[12.5px]"
            value={message}
            placeholder={amend ? 'New message for the last commit (leave empty to keep it)' : 'Enter a commit message'}
            aria-label="Commit message"
            disabled={busy !== null}
            onInput={(e) => setMessage(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && canCommit(primaryAll)) { e.preventDefault(); void commit(primaryAll, null) } }}
          />
          <div class="flex items-center gap-1.5">
            <span class="inline-flex">
              <Button
                size="sm"
                variant="primary"
                class="rounded-r-none"
                disabled={!canCommit(primaryAll)}
                loading={busy === 'Commit'}
                data-action="commit"
                title={conflicts.length > 0 ? 'Resolve the conflicts first' : primaryAll ? 'Commit every change (Ctrl+Enter)' : `Commit the ${staged.length} staged file${staged.length === 1 ? '' : 's'} (Ctrl+Enter)`}
                onClick={() => { void commit(primaryAll, null) }}
              >
                {primaryAll ? 'Commit All' : `Commit Staged${staged.length > 0 ? ` (${staged.length})` : ''}`}
              </Button>
              <Menu label="Commit options" items={commitMenu} trigger={(props) => (
                <Button {...props} size="sm" variant="primary" class="rounded-l-none border-l border-l-white/20 px-1" aria-label="Commit options"><ChevronDown /></Button>
              )} />
            </span>
            <Switch size="sm" checked={amend} onChange={setAmend} disabled={busy !== null || head.unborn} label="Amend" hint="Fold this commit into the last one, replacing its message when one is given" />
            <span class="ml-auto text-[11px] text-faint">{files.length === 0 ? 'nothing to commit' : `${files.length} change${files.length === 1 ? '' : 's'}`}</span>
          </div>
        </div>

        {/* Lists */}
        {conflicts.length > 0 && (
          <PanelSection
            title="Unmerged Changes"
            count={conflicts.length}
            actions={<IconButton size="sm" label={sectionOpen['conflict'] === false ? 'Expand' : 'Collapse'} onClick={() => toggle('conflict')}><ChevronDown class={cn('transition-transform', sectionOpen['conflict'] === false && '-rotate-90')} /></IconButton>}
          >
            {sectionOpen['conflict'] !== false && conflicts.map((f) => (
              <FileRow key={`c:${f.path}`} file={f} section="conflict" busy={busy !== null} onOpen={() => openMerge(f)} onStage={() => stage([f])} onUnstage={() => {}} onUndo={() => {}} onMenu={() => fileMenu(f, 'conflict')} />
            ))}
          </PanelSection>
        )}
        <PanelSection
          title="Staged Changes"
          count={staged.length}
          actions={(
            <>
              {staged.length > 0 && <IconButton size="sm" label="Unstage all" title="Unstage all" disabled={busy !== null} onClick={() => unstage(staged)}>{Icon.minus()}</IconButton>}
              <IconButton size="sm" label={sectionOpen['staged'] === false ? 'Expand' : 'Collapse'} onClick={() => toggle('staged')}><ChevronDown class={cn('transition-transform', sectionOpen['staged'] === false && '-rotate-90')} /></IconButton>
            </>
          )}
        >
          {sectionOpen['staged'] !== false && (staged.length === 0
            ? <div class="px-2.5 pb-1.5 text-[11.5px] text-faint">Nothing staged. Press + on a change, or Commit All.</div>
            : staged.map((f) => (
              <FileRow key={`s:${f.path}`} file={f} section="staged" busy={busy !== null} onOpen={() => onOpenFile(f.path, 'diff')} onStage={() => {}} onUnstage={() => unstage([f])} onUndo={() => {}} onMenu={() => fileMenu(f, 'staged')} />
            )))}
        </PanelSection>
        <PanelSection
          title="Changes"
          count={changes.length}
          actions={(
            <>
              {changes.length > 0 && <IconButton size="sm" label="Undo all changes" title="Undo all changes — put every file back to the last commit" disabled={busy !== null} onClick={() => discard(changes)}><Undo2 /></IconButton>}
              {changes.length > 0 && <IconButton size="sm" label="Stage all" title="Stage all" disabled={busy !== null} onClick={() => stage(changes)}>{Icon.plus()}</IconButton>}
              <IconButton size="sm" label={sectionOpen['change'] === false ? 'Expand' : 'Collapse'} onClick={() => toggle('change')}><ChevronDown class={cn('transition-transform', sectionOpen['change'] === false && '-rotate-90')} /></IconButton>
            </>
          )}
        >
          {sectionOpen['change'] !== false && (changes.length === 0
            ? <div class="px-2.5 pb-1.5 text-[11.5px] text-faint">{files.length === 0 ? 'The working tree is clean.' : 'Every change is staged.'}</div>
            : changes.map((f) => (
              <FileRow key={`w:${f.path}`} file={f} section="change" busy={busy !== null} onOpen={() => onOpenFile(f.path, 'diff')} onStage={() => stage([f])} onUnstage={() => {}} onUndo={() => discard([f])} onMenu={() => fileMenu(f, 'change')} />
            )))}
        </PanelSection>
        {(repo.stashes > 0 || stashes.length > 0) && (
          <PanelSection
            title="Stashes"
            count={stashes.length}
            actions={<IconButton size="sm" label={sectionOpen['stash'] === false ? 'Expand' : 'Collapse'} onClick={() => toggle('stash')}><ChevronDown class={cn('transition-transform', sectionOpen['stash'] === false && '-rotate-90')} /></IconButton>}
          >
            {sectionOpen['stash'] !== false && stashes.map((s) => (
              <div key={s.ref} data-stash={s.index} class={cn('group/stash flex min-h-7 items-center gap-2 py-0.5 pl-2.5 pr-1.5 hover:bg-raised')}>
                <Archive class="size-3.5 shrink-0 text-dim" />
                <span class="min-w-0 flex-1 truncate text-[12.5px]" title={s.message}>{s.message}</span>
                <span class="shrink-0 text-[10.5px] text-faint">{relativeTime(s.date)}</span>
                <Menu label="Stash actions" items={stashMenu(s)} align="end" trigger={(props) => <IconButton {...props} size="sm" label="Stash actions"><MoreHorizontal /></IconButton>} />
              </div>
            ))}
          </PanelSection>
        )}
        {status.unversioned.length > 0 && (
          <div class="px-2.5 py-2">
            {status.unversioned.map((u) => (
              <PanelNote key={u.mount} inset>
                <div class="flex items-center justify-between gap-2">
                  <span class="truncate">{u.mount} is not under version control</span>
                  <Button size="sm" onClick={() => setDialog({ kind: 'init', mount: u.mount })}>Create repository</Button>
                </div>
              </PanelNote>
            ))}
          </div>
        )}
      </div>

      {/* Dialogs */}
      <NewBranchDialog
        open={dialog?.kind === 'new-branch'}
        onClose={() => setDialog(null)}
        current={repo.branch}
        locals={locals}
        remotes={remotes}
        onCreate={async (p) => {
          const r = await run('New branch', () => client.call('git.branchCreate', { root, name: p.name, base: p.base, checkout: p.checkout, track: p.track }), `Created ${p.name}`)
          return r?.ok === true
        }}
      />
      <StashDialog
        open={dialog?.kind === 'stash'}
        onClose={() => setDialog(null)}
        hasStaged={staged.length > 0}
        onStash={async (p) => {
          const r = await run('Stash', () => client.call('git.stashPush', { root, message: p.message, keepIndex: p.keepIndex, includeUntracked: p.includeUntracked }), 'Stashed')
          return r?.ok === true
        }}
      />
      <PushBehindDialog
        open={dialog?.kind === 'push-behind'}
        onClose={() => setDialog(null)}
        onPullThenPush={async () => (await pull()) && (await push({}))}
        onPull={() => pull()}
        onForce={() => push({ forceWithLease: true })}
      />
      <PublishDialog
        open={dialog?.kind === 'publish'}
        onClose={() => setDialog(null)}
        branch={repo.branch ?? 'HEAD'}
        remotes={remoteNames.length > 0 ? remoteNames : ['origin']}
        onPublish={(remote) => push({ setUpstream: true, remote })}
      />
      {dialog?.kind === 'discard' && (
        <ConfirmDialog
          open
          onCancel={() => setDialog(null)}
          title={`Undo changes to ${dialog.label}?`}
          description="The file goes back to the last commit. An untracked file is deleted. This cannot be undone."
          confirmLabel="Undo changes"
          onConfirm={async () => { const r = await run('Undo', () => client.call('git.discard', { root, paths: dialog.paths }), `Undid changes to ${dialog.label}`); return r?.ok === true }}
        />
      )}
      {dialog?.kind === 'drop-stash' && (
        <ConfirmDialog
          open
          onCancel={() => setDialog(null)}
          title="Drop this stash?"
          description={`"${dialog.entry.message}" is deleted. This cannot be undone.`}
          confirmLabel="Drop"
          onConfirm={async () => { const r = await run('Drop stash', () => client.call('git.stashDrop', { root, index: dialog.entry.index }), 'Stash dropped'); return r?.ok === true }}
        />
      )}
      {dialog?.kind === 'abort-operation' && (
        <ConfirmDialog
          open
          onCancel={() => setDialog(null)}
          title={`Abort the ${(OPERATION_LABEL[dialog.operation] ?? dialog.operation).toLowerCase()}?`}
          description="Everything goes back to how it was before it started; any conflict resolution done so far is lost."
          confirmLabel="Abort"
          onConfirm={async () => { const r = await run('Abort', () => client.call('git.operation', { root, action: 'abort' }), 'Aborted'); return r?.ok === true }}
        />
      )}
      {dialog?.kind === 'init' && (
        <ConfirmDialog
          open
          onCancel={() => setDialog(null)}
          title={`Create a Git repository in ${dialog.mount}?`}
          description="Runs git init. Nothing is committed yet; the files appear under Changes for the first commit."
          confirmLabel="Create repository"
          danger={false}
          onConfirm={async () => { const r = await run('Init', () => client.call('git.init', { mount: dialog.mount }), 'Repository created'); return r?.ok === true }}
        />
      )}
      {dialog?.kind === 'show-stash' && (
        <Dialog open onClose={() => setDialog(null)} title={dialog.entry.message} description={relativeTime(dialog.entry.date)} size="lg">
          <div class="max-h-[60vh] overflow-auto" data-dialog="stash-diff">
            {dialog.diff === null ? <PanelLoading /> : dialog.diff.trim() === '' ? <PanelEmpty icon={<FileDiff />} title="Empty stash" /> : <DiffView content={dialog.diff} dense />}
          </div>
        </Dialog>
      )}
      {busy !== null && <span class="sr-only" role="status">{busy}…</span>}
    </div>
  )
}
