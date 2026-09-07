import type { VNode } from 'preact'
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import {
  ArrowDown, ArrowUp, ChevronDown, ChevronRight, Eye, EyeOff, FileDiff, GitBranch, GitCommit, GitMerge, MoreHorizontal,
  Pencil, RefreshCw, Search, Tag, X,
} from 'lucide-preact'
import type { GitBranchRef, GitChangedFile, GitCommitDetails, GitCommitRow, GitRefs, GitRepoView, GitTagRef } from '@core/host/protocol'
import type { ProtocolClient } from '../lib/client'
import { DiffView } from '../lib/diff'
import { relativeTime } from '../lib/format'
import { announce, kindOf, shortSha, type Outcome } from '../lib/git-actions'
import { LANE_COLOURS, layoutGraph, type GraphRow } from '../lib/git-graph'
import type { GitView } from '../lib/git-views'
import { PanelEmpty, PanelError, PanelLoading, PanelNote } from '../components/panel'
import { Button, IconButton } from '../ui/button'
import { Chip } from '../ui/chip'
import { cn } from '../ui/cn'
import { Input } from '../ui/input'
import { Menu, type MenuItem } from '../ui/menu'
import { toast } from '../ui/toast'
import { ConfirmDialog, NewBranchDialog, PublishDialog, PushBehindDialog, ResetDialog, TagDialog, TextDialog } from './git-dialogs'

/**
 * Git Repository — Visual Studio's window of that name, as a tab beside the chat.
 *
 * Three parts, like the original: the branches and tags on the left (local, remote, tags;
 * a filter; a context menu on every one), the graph in the middle (Incoming and Outgoing
 * above the branch's history when it tracks a remote; the lanes drawn from parents; labels
 * for branches and tags; first-parent, label and outgoing/incoming-only filters; a search
 * box), and the selected commit below (message, author, files, each file's diff), with
 * the commit's actions on a right-click: checkout, new branch, tag, cherry-pick, revert,
 * reset, compare two, squash a run, copy the id.
 *
 * Selecting a branch on the left shows ITS history without checking it out — a double
 * click, or Checkout on the menu, does that.
 */

const PAGE = 200
const ROW_H = 26
const LANE_W = 14
const LANE_COLOUR = ['var(--accent)', 'var(--green)', 'var(--yellow)', 'var(--blue)', 'var(--red)', '#b07fd6', '#4fb3bf', '#d98b4a']

type Dialog =
  | { kind: 'new-branch'; base: string }
  | { kind: 'tag'; sha: string; short: string; subject: string }
  | { kind: 'reset'; sha: string; short: string; subject: string }
  | { kind: 'delete-branch'; name: string; remote?: string; force: boolean }
  | { kind: 'rename-branch'; name: string }
  | { kind: 'squash'; shas: string[]; message: string }
  | { kind: 'amend'; message: string }
  | { kind: 'detach'; sha: string; short: string }
  | { kind: 'revert'; sha: string; short: string; subject: string }
  | { kind: 'cherry-pick'; shas: string[] }
  | { kind: 'merge'; branch: string; current: string }
  | { kind: 'rebase'; onto: string; current: string }
  | { kind: 'push-behind' }
  | { kind: 'publish' }

function Graph({ row, colourOf }: { row: GraphRow; colourOf: (c: number) => string }): VNode {
  const w = Math.max(row.width, 1) * LANE_W
  const x = (lane: number): number => lane * LANE_W + LANE_W / 2
  return (
    <svg width={w} height={ROW_H} viewBox={`0 0 ${w} ${ROW_H}`} class="shrink-0" data-graph="" aria-hidden="true">
      {row.edges.map((e, i) => {
        const x1 = x(e.from)
        const x2 = x(e.to)
        const d = e.from === e.to
          ? `M${x1} ${ROW_H / 2} V${ROW_H}`
          : `M${x1} ${ROW_H / 2} C${x1} ${ROW_H}, ${x2} ${ROW_H / 2}, ${x2} ${ROW_H}`
        return <path key={i} d={e.passing ? `M${x1} 0 V${ROW_H}` : d} stroke={colourOf(e.colour)} stroke-width="1.6" fill="none" opacity={e.passing ? 0.7 : 1} />
      })}
      {/* Lines arriving from above into this commit's dot: every lane that ended here. */}
      <path d={`M${x(row.lane)} 0 V${ROW_H / 2}`} stroke={colourOf(row.colour)} stroke-width="1.6" fill="none" />
      <circle cx={x(row.lane)} cy={ROW_H / 2} r="3.4" fill={colourOf(row.colour)} />
    </svg>
  )
}

function RefLabel({ name, kind, current }: { name: string; kind: 'head' | 'local' | 'remote' | 'tag'; current: boolean }): VNode | null {
  if (kind === 'head') return null
  return (
    <Chip tone={kind === 'tag' ? 'yellow' : kind === 'remote' ? 'neutral' : current ? 'accent' : 'blue'} icon={kind === 'tag' ? <Tag /> : <GitBranch />} class="max-w-[160px]" title={name}>
      <span class="truncate">{name}</span>
    </Chip>
  )
}

export function GitRepositoryView({ client, root, label, reloadKey, onOpenFile, onOpenView }: {
  client: ProtocolClient
  root: string
  label: string
  reloadKey: number
  onOpenFile: (path: string, face?: 'file' | 'diff') => void
  onOpenView: (view: GitView) => void
}): VNode {
  const [repo, setRepo] = useState<GitRepoView | null>(null)
  const [refs, setRefs] = useState<GitRefs | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [viewing, setViewing] = useState<string | null>(null) // a ref name, or null for HEAD
  const [commits, setCommits] = useState<GitCommitRow[]>([])
  const [incoming, setIncoming] = useState<GitCommitRow[]>([])
  const [outgoing, setOutgoing] = useState<GitCommitRow[]>([])
  const [exhausted, setExhausted] = useState(false)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [firstParent, setFirstParent] = useState(false)
  const [labels, setLabels] = useState({ local: true, remote: true, tag: true })
  const [syncOnly, setSyncOnly] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [details, setDetails] = useState<GitCommitDetails | null>(null)
  const [detailFile, setDetailFile] = useState<string | null>(null)
  const [fileDiff, setFileDiff] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState({ local: true, remote: true, tags: false })
  const [detailsOpen, setDetailsOpen] = useState(true)
  const busyRef = useRef(false)
  busyRef.current = busy !== null

  const current = repo?.branch ?? null
  const head = repo?.head

  const loadRepo = useCallback(async () => {
    try {
      const [status, r] = await Promise.all([client.call('git.status', {}), client.call('git.refs', { root })])
      const mine = status.repos.find((x) => x.root === root) ?? null
      setRepo(mine)
      if (r.local !== undefined) setRefs({ local: r.local, remote: r.remote ?? [], tags: r.tags ?? [] })
      setProblem(mine === null ? 'this repository is no longer part of the workspace' : (r.problem ?? null))
    } catch (e) {
      setProblem((e as Error).message)
    }
  }, [client, root])

  const loadLog = useCallback(async (append: boolean) => {
    setLoading(!append)
    try {
      const range = viewing ?? 'HEAD'
      const base = { root, firstParent, ...(search.trim() !== '' ? { search: search.trim() } : {}) }
      const skip = append ? commits.length : 0
      const [main, inc, out] = await Promise.all([
        client.call('git.log', { ...base, limit: PAGE, skip, ...(showAll ? { all: true } : { range }) }),
        viewing === null && head?.upstream ? client.call('git.log', { ...base, range: `HEAD..${head.upstream}`, limit: 100 }) : Promise.resolve({ commits: [] }),
        viewing === null && head?.upstream ? client.call('git.log', { ...base, range: `${head.upstream}..HEAD`, limit: 100 }) : Promise.resolve({ commits: [] }),
      ])
      if (main.problem !== undefined) setProblem(main.problem)
      setCommits((prev) => (append ? [...prev, ...main.commits] : main.commits))
      setExhausted(main.commits.length < PAGE)
      setIncoming(inc.commits)
      setOutgoing(out.commits)
    } catch (e) {
      setProblem((e as Error).message)
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, root, viewing, firstParent, search, showAll, head?.upstream, commits.length])

  useEffect(() => { void loadRepo() }, [loadRepo, reloadKey])
  useEffect(() => { void loadLog(false) }, [root, viewing, firstParent, search, showAll, head?.upstream, reloadKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // The selected commit's details and, on a file, its diff.
  useEffect(() => {
    const sha = selected[0]
    if (sha === undefined || selected.length !== 1) { setDetails(null); setDetailFile(null); setFileDiff(null); return }
    let cancelled = false
    client.call('git.commitDetails', { root, sha })
      .then((r) => { if (!cancelled) { setDetails(r.details ?? null); setDetailFile(null); setFileDiff(null); if (r.problem !== undefined) toast.push({ title: r.problem, tone: 'error' }) } })
      .catch((e: Error) => { if (!cancelled) toast.push({ title: e.message, tone: 'error' }) })
    return () => { cancelled = true }
  }, [client, root, selected])
  useEffect(() => {
    if (details === null || detailFile === null) return
    let cancelled = false
    setFileDiff(null)
    client.call('git.diffBetween', { root, from: details.base, to: details.sha, path: detailFile })
      .then((r) => { if (!cancelled) setFileDiff(r.diff) })
      .catch((e: Error) => { if (!cancelled) setFileDiff(`could not read the diff: ${e.message}`) })
    return () => { cancelled = true }
  }, [client, root, details, detailFile])

  async function run<R extends Outcome>(name: string, call: () => Promise<R>, done: string): Promise<R | null> {
    if (busyRef.current) return null
    setBusy(name)
    try {
      const r = await call()
      const kind = announce(r, done)
      if (kind === 'conflict') toast.push({ title: `${name} stopped on conflicts`, description: 'Resolve them on the Git tab under Unmerged Changes, then Continue.', tone: 'error', duration: 8000 })
      if (kind === 'behind') setDialog({ kind: 'push-behind' })
      if (kind === 'no-upstream') setDialog({ kind: 'publish' })
      return r
    } catch (e) {
      toast.push({ title: `${name} failed`, description: (e as Error).message, tone: 'error' })
      return null
    } finally {
      setBusy(null)
      await loadRepo()
      await loadLog(false)
    }
  }

  const graph = useMemo(() => {
    const rows = layoutGraph(commits.map((c) => ({ sha: c.sha, parents: c.parents })))
    return new Map(rows.map((r) => [r.sha, r]))
  }, [commits])
  const colourOf = (c: number): string => LANE_COLOUR[c % LANE_COLOURS] ?? 'var(--accent)'

  const select = (sha: string, e: MouseEvent): void => {
    if (e.ctrlKey || e.metaKey) setSelected((s) => (s.includes(sha) ? s.filter((x) => x !== sha) : [...s, sha]))
    else if (e.shiftKey && selected.length > 0) {
      const order = [...incoming, ...outgoing, ...commits].map((c) => c.sha)
      const a = order.indexOf(selected[0]!)
      const b = order.indexOf(sha)
      if (a >= 0 && b >= 0) setSelected(order.slice(Math.min(a, b), Math.max(a, b) + 1))
      else setSelected([sha])
    } else setSelected([sha])
  }

  // ---- menus -----------------------------------------------------------------------------

  const branchMenu = (b: GitBranchRef): MenuItem[] => {
    const isCurrent = b.current
    const remote = b.remote
    const items: MenuItem[] = [
      { id: 'view', label: 'View history', onSelect: () => { setViewing(b.name); setShowAll(false) } },
      { id: 'checkout', label: isCurrent ? 'Checked out' : 'Checkout', disabled: isCurrent, onSelect: () => { void run('Checkout', () => client.call('git.switch', { root, name: b.name }), `Checked out ${b.name}`) } },
      { id: 'new', label: 'New branch from here…', icon: <GitBranch />, onSelect: () => setDialog({ kind: 'new-branch', base: b.name }) },
      { separator: true },
    ]
    if (!isCurrent && current !== null) {
      items.push(
        { id: 'merge', label: `Merge '${b.name}' into '${current}'`, icon: <GitMerge />, onSelect: () => setDialog({ kind: 'merge', branch: b.name, current }) },
        { id: 'rebase', label: `Rebase '${current}' onto '${b.name}'`, onSelect: () => setDialog({ kind: 'rebase', onto: b.name, current }) },
        { id: 'compare', label: 'Compare with current branch', icon: <FileDiff />, onSelect: () => onOpenView({ kind: 'compare', root, from: current, to: b.name, fromLabel: current, toLabel: b.name }) },
        { separator: true },
      )
    }
    if (remote === undefined) {
      items.push(
        { id: 'push', label: 'Push', icon: <ArrowUp />, onSelect: () => { void run('Push', () => client.call('git.push', { root, remote: 'origin', branch: b.name }), `Pushed ${b.name}`) } },
        { id: 'rename', label: 'Rename…', icon: <Pencil />, onSelect: () => setDialog({ kind: 'rename-branch', name: b.name }) },
        { id: 'delete', label: 'Delete…', danger: true, disabled: isCurrent, reason: isCurrent ? 'check out another branch first' : '', onSelect: () => setDialog({ kind: 'delete-branch', name: b.name, force: false }) },
      )
    } else {
      items.push(
        { id: 'tip', label: 'Checkout tip commit (detached)', onSelect: () => setDialog({ kind: 'detach', sha: b.sha, short: b.short }) },
        { id: 'delete-remote', label: `Delete from ${remote}…`, danger: true, onSelect: () => setDialog({ kind: 'delete-branch', name: b.name.slice(remote.length + 1), remote, force: false }) },
      )
    }
    return items
  }

  const tagMenu = (t: GitTagRef): MenuItem[] => [
    { id: 'view', label: 'View history', onSelect: () => { setViewing(t.name); setShowAll(false) } },
    { id: 'detach', label: 'Checkout (detached)', onSelect: () => setDialog({ kind: 'detach', sha: t.sha, short: t.short }) },
    { id: 'new', label: 'New branch from here…', icon: <GitBranch />, onSelect: () => setDialog({ kind: 'new-branch', base: t.name }) },
    { separator: true },
    { id: 'delete', label: 'Delete tag', danger: true, onSelect: () => { void run('Delete tag', () => client.call('git.tagDelete', { root, name: t.name }), `Deleted ${t.name}`) } },
  ]

  const commitMenu = (c: GitCommitRow): MenuItem[] => {
    const many = selected.length > 1 && selected.includes(c.sha)
    const isHead = head?.oid === c.sha
    const items: MenuItem[] = []
    if (many) {
      const chosen = [...selected]
      items.push(
        { id: 'compare', label: 'Compare Commits', icon: <FileDiff />, disabled: chosen.length !== 2, reason: chosen.length !== 2 ? 'select exactly two' : '', onSelect: () => {
          const [a, b] = chosen as [string, string]
          onOpenView({ kind: 'compare', root, from: b, to: a, fromLabel: shortSha(b), toLabel: shortSha(a) })
        } },
        { id: 'squash', label: `Squash ${chosen.length} Commits…`, onSelect: () => {
          const messages = commits.filter((x) => chosen.includes(x.sha)).map((x) => x.subject)
          setDialog({ kind: 'squash', shas: chosen, message: messages.join('\n\n') })
        } },
        { id: 'cherry-many', label: `Cherry-Pick ${chosen.length} Commits`, onSelect: () => setDialog({ kind: 'cherry-pick', shas: [...chosen].reverse() }) },
        { separator: true },
      )
    }
    items.push(
      { id: 'open', label: 'Open in new tab', onSelect: () => onOpenView({ kind: 'commit', root, sha: c.sha, short: c.short }) },
      { id: 'detach', label: 'Checkout (detached)', disabled: isHead, onSelect: () => setDialog({ kind: 'detach', sha: c.sha, short: c.short }) },
      { id: 'branch', label: 'New Branch…', icon: <GitBranch />, onSelect: () => setDialog({ kind: 'new-branch', base: c.sha }) },
      { id: 'tag', label: 'Create Tag…', icon: <Tag />, onSelect: () => setDialog({ kind: 'tag', sha: c.sha, short: c.short, subject: c.subject }) },
      { separator: true },
      { id: 'cherry', label: 'Cherry-Pick', onSelect: () => setDialog({ kind: 'cherry-pick', shas: [c.sha] }) },
      { id: 'revert', label: 'Revert', disabled: c.parents.length > 1, reason: c.parents.length > 1 ? 'a merge commit has two parents; revert it from a terminal with -m' : '', onSelect: () => setDialog({ kind: 'revert', sha: c.sha, short: c.short, subject: c.subject }) },
      { id: 'reset', label: 'Reset…', disabled: isHead, reason: isHead ? 'already here' : '', onSelect: () => setDialog({ kind: 'reset', sha: c.sha, short: c.short, subject: c.subject }) },
      { separator: true },
      { id: 'copy', label: 'Copy Commit ID', onSelect: () => { void navigator.clipboard?.writeText(c.sha) } },
      { id: 'copy-msg', label: 'Copy message', onSelect: () => { void navigator.clipboard?.writeText(c.subject) } },
    )
    if (isHead && !many) items.push({ separator: true }, { id: 'amend', label: 'Edit message (amend)…', icon: <Pencil />, onSelect: () => setDialog({ kind: 'amend', message: c.subject }) })
    return items
  }

  // ---- rendering ---------------------------------------------------------------------------

  if (problem !== null && repo === null) return <PanelError message={problem} onRetry={() => { void loadRepo() }} />
  if (repo === null || refs === null) return <PanelLoading what="reading the repository…" />

  const f = filter.trim().toLowerCase()
  const locals = refs.local.filter((b) => b.name.toLowerCase().includes(f))
  const remotes = refs.remote.filter((b) => b.name.toLowerCase().includes(f))
  const tags = refs.tags.filter((t) => t.name.toLowerCase().includes(f))
  const remoteNames = [...new Set(refs.remote.map((b) => b.remote ?? '').filter((n) => n !== ''))]
  const viewingLabel = showAll ? 'All branches' : (viewing ?? current ?? 'HEAD')
  const hasSyncSections = viewing === null && !showAll && head?.upstream !== null && head?.upstream !== undefined
  const shownCommits = syncOnly ? [] : commits

  const commitRow = (c: GitCommitRow, section: 'incoming' | 'outgoing' | 'history'): VNode => {
    const row = section === 'history' ? graph.get(c.sha) : undefined
    const isSelected = selected.includes(c.sha)
    const isHead = head?.oid === c.sha
    return (
      <div
        key={`${section}:${c.sha}`}
        data-commit={c.sha}
        role="row"
        aria-selected={isSelected}
        class={cn(
          'group flex h-[26px] cursor-default select-none items-center gap-2 pr-1.5 text-[12.5px] hover:bg-raised',
          isSelected && 'bg-accent-soft hover:bg-accent-soft',
        )}
        onClick={(e) => select(c.sha, e)}
        onDblClick={() => onOpenView({ kind: 'commit', root, sha: c.sha, short: c.short })}
        onContextMenu={(e) => { e.preventDefault(); if (!isSelected) setSelected([c.sha]) }}
      >
        <span class="flex h-full shrink-0 items-center pl-1.5">
          {row !== undefined ? <Graph row={row} colourOf={colourOf} /> : <GitCommit class="size-3.5 text-dim" />}
        </span>
        <span class="flex min-w-0 flex-1 items-center gap-1.5">
          {c.refs.filter((r) => (r.kind === 'local' && labels.local) || (r.kind === 'remote' && labels.remote) || (r.kind === 'tag' && labels.tag)).map((r) => (
            <RefLabel key={`${r.kind}:${r.name}`} name={r.name} kind={r.kind} current={r.name === current} />
          ))}
          <span class={cn('truncate', isHead && 'font-semibold')} title={c.subject}>{c.subject}</span>
        </span>
        <span class="w-[110px] shrink-0 truncate text-[11.5px] text-dim" title={c.authorEmail}>{c.authorName}</span>
        <span class="w-[74px] shrink-0 text-right text-[11px] text-faint" title={new Date(c.authorDate).toLocaleString()}>{relativeTime(c.authorDate)}</span>
        <span class="w-[60px] shrink-0 font-mono text-[11px] text-faint">{c.short}</span>
        {/* The trigger sits inside the row, whose click selects: the menu must not reselect. */}
        <span onClick={(e) => e.stopPropagation()} onDblClick={(e) => e.stopPropagation()}>
          <Menu label="Commit actions" items={commitMenu(c)} align="end" trigger={(props) => (
            <IconButton {...props} size="sm" label="Commit actions" class="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"><MoreHorizontal /></IconButton>
          )} />
        </span>
      </div>
    )
  }

  const sectionHeader = (title: string, count: number, action?: VNode): VNode => (
    <div class="flex items-center gap-2 border-y border-border-soft bg-panel px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-faint">
      <span>{title}</span>
      <span class="font-mono">{count}</span>
      {action !== undefined && <span class="ml-auto">{action}</span>}
    </div>
  )

  return (
    <div data-view="git-repository" class="flex h-full min-h-0 font-ui">
      {/* Branches / Tags */}
      <aside class="flex w-[240px] shrink-0 flex-col border-r border-border-soft" data-git-branches="">
        <div class="flex items-center gap-1.5 border-b border-border-soft px-2 py-1.5">
          <Search class="size-3.5 text-faint" />
          <Input class="h-6 flex-1 text-[12px]" placeholder="Filter branches and tags" aria-label="Filter branches and tags" value={filter} onInput={(e) => setFilter(e.currentTarget.value)} />
        </div>
        <div class="min-h-0 flex-1 overflow-auto py-1">
          <button type="button" class={cn('flex w-full items-center gap-1 px-2 py-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-faint hover:text-fg')} onClick={() => setOpen((o) => ({ ...o, local: !o.local }))} aria-expanded={open.local}>
            {open.local ? <ChevronDown class="size-3" /> : <ChevronRight class="size-3" />} Local <span class="font-mono">{locals.length}</span>
          </button>
          {open.local && locals.map((b) => (
            <div key={b.name} data-branch={b.name} class={cn('group flex items-center gap-1.5 py-0.5 pl-4 pr-1 text-[12.5px] hover:bg-raised', viewing === b.name && 'bg-accent-soft', b.current && 'font-semibold text-accent')}>
              <button type="button" class="flex min-w-0 flex-1 items-center gap-1.5 text-left" title={`${b.name}${b.upstream !== undefined ? ` → ${b.upstream}` : ''}\n${b.subject}`} onClick={() => { setViewing(b.name); setShowAll(false) }} onDblClick={() => { void run('Checkout', () => client.call('git.switch', { root, name: b.name }), `Checked out ${b.name}`) }}>
                <GitBranch class="size-3.5 shrink-0" />
                <span class="truncate">{b.name}</span>
                {(b.ahead ?? 0) > 0 && <span class="text-[10.5px] text-faint">↑{b.ahead}</span>}
                {(b.behind ?? 0) > 0 && <span class="text-[10.5px] text-faint">↓{b.behind}</span>}
                {b.upstreamGone === true && <span class="text-[10.5px] text-red" title="the upstream no longer exists">gone</span>}
              </button>
              <IconButton size="sm" label={showAll ? 'Showing every branch' : 'Toggle in history'} title="Show all branches in the graph" active={showAll} class="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => setShowAll((s) => !s)}>{showAll ? <Eye /> : <EyeOff />}</IconButton>
              <Menu label="Branch actions" items={branchMenu(b)} align="end" trigger={(props) => <IconButton {...props} size="sm" label="Branch actions" class="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"><MoreHorizontal /></IconButton>} />
            </div>
          ))}
          <button type="button" class="mt-1 flex w-full items-center gap-1 px-2 py-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-faint hover:text-fg" onClick={() => setOpen((o) => ({ ...o, remote: !o.remote }))} aria-expanded={open.remote}>
            {open.remote ? <ChevronDown class="size-3" /> : <ChevronRight class="size-3" />} Remotes <span class="font-mono">{remotes.length}</span>
          </button>
          {open.remote && remotes.map((b) => (
            <div key={b.name} data-branch={b.name} class={cn('group flex items-center gap-1.5 py-0.5 pl-4 pr-1 text-[12.5px] text-dim hover:bg-raised', viewing === b.name && 'bg-accent-soft')}>
              <button type="button" class="flex min-w-0 flex-1 items-center gap-1.5 text-left" title={b.subject} onClick={() => { setViewing(b.name); setShowAll(false) }} onDblClick={() => { void run('Checkout', () => client.call('git.switch', { root, name: b.name }), `Checked out ${b.name}`) }}>
                <GitBranch class="size-3.5 shrink-0" />
                <span class="truncate">{b.name}</span>
              </button>
              <Menu label="Branch actions" items={branchMenu(b)} align="end" trigger={(props) => <IconButton {...props} size="sm" label="Branch actions" class="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"><MoreHorizontal /></IconButton>} />
            </div>
          ))}
          <button type="button" class="mt-1 flex w-full items-center gap-1 px-2 py-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-faint hover:text-fg" onClick={() => setOpen((o) => ({ ...o, tags: !o.tags }))} aria-expanded={open.tags}>
            {open.tags ? <ChevronDown class="size-3" /> : <ChevronRight class="size-3" />} Tags <span class="font-mono">{tags.length}</span>
          </button>
          {open.tags && tags.map((t) => (
            <div key={t.name} data-tag={t.name} class={cn('group flex items-center gap-1.5 py-0.5 pl-4 pr-1 text-[12.5px] text-dim hover:bg-raised', viewing === t.name && 'bg-accent-soft')}>
              <button type="button" class="flex min-w-0 flex-1 items-center gap-1.5 text-left" title={`${t.subject}\n${t.short}`} onClick={() => { setViewing(t.name); setShowAll(false) }}>
                <Tag class="size-3.5 shrink-0 text-yellow" />
                <span class="truncate">{t.name}</span>
              </button>
              <Menu label="Tag actions" items={tagMenu(t)} align="end" trigger={(props) => <IconButton {...props} size="sm" label="Tag actions" class="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"><MoreHorizontal /></IconButton>} />
            </div>
          ))}
        </div>
        <div class="flex items-center gap-1 border-t border-border-soft px-2 py-1.5">
          <Button size="sm" icon={<GitBranch />} onClick={() => setDialog({ kind: 'new-branch', base: current ?? 'HEAD' })} data-action="new-branch">New branch…</Button>
          <IconButton size="sm" label="Fetch" title="Fetch (prune)" disabled={busy !== null} onClick={() => { void run('Fetch', () => client.call('git.fetch', { root, prune: true }), 'Fetched') }}><RefreshCw /></IconButton>
        </div>
      </aside>

      {/* Graph + details */}
      <div class="flex min-w-0 flex-1 flex-col">
        <div class="flex items-center gap-1.5 border-b border-border-soft px-2.5 py-1.5" data-git-toolbar="">
          <span class="truncate text-[12.5px] font-medium" title={label}>{viewingLabel}</span>
          {viewing !== null && <IconButton size="sm" label="Back to the current branch" onClick={() => setViewing(null)}><X /></IconButton>}
          <span class="ml-auto flex items-center gap-1">
            <div class="flex items-center gap-1.5">
              <Search class="size-3.5 text-faint" />
              <Input class="h-6 w-[180px] text-[12px]" placeholder="Search commits or sha" aria-label="Search commits" value={search} onInput={(e) => setSearch(e.currentTarget.value)} />
            </div>
            <IconButton size="sm" label="Show first parent only" title="Show First Parent Only" active={firstParent} onClick={() => setFirstParent((v) => !v)}><GitCommit /></IconButton>
            <IconButton size="sm" label="Show all branches" title="Show every branch in one graph" active={showAll} onClick={() => setShowAll((v) => !v)}><GitBranch /></IconButton>
            <IconButton size="sm" label="Show outgoing and incoming only" title="Show Outgoing/Incoming Only" active={syncOnly} disabled={!hasSyncSections} onClick={() => setSyncOnly((v) => !v)}><RefreshCw /></IconButton>
            <Menu label="Labels" items={[
              { id: 'local', label: `${labels.local ? '✓ ' : ''}Show local branches`, onSelect: () => setLabels((l) => ({ ...l, local: !l.local })) },
              { id: 'remote', label: `${labels.remote ? '✓ ' : ''}Show remote branches`, onSelect: () => setLabels((l) => ({ ...l, remote: !l.remote })) },
              { id: 'tags', label: `${labels.tag ? '✓ ' : ''}Show tags`, onSelect: () => setLabels((l) => ({ ...l, tag: !l.tag })) },
            ]} align="end" trigger={(props) => <IconButton {...props} size="sm" label="Label options"><Tag /></IconButton>} />
          </span>
        </div>

        <div class={cn('min-h-0 overflow-auto', detailsOpen && selected.length === 1 ? 'flex-[3]' : 'flex-1')} role="grid" aria-label="Commits" data-git-graph="">
          {busy !== null && <div class="px-2.5 py-1 text-[11.5px] text-accent" data-git-busy={busy}>{busy}…</div>}
          {hasSyncSections && (
            <>
              {sectionHeader('Incoming', incoming.length, incoming.length > 0
                ? <Button size="sm" icon={<ArrowDown />} disabled={busy !== null} onClick={() => { void run('Pull', () => client.call('git.pull', { root }), 'Pulled') }}>Pull</Button>
                : undefined)}
              {incoming.length === 0 && <div class="px-2.5 py-1 text-[11.5px] text-faint">Nothing new on {head?.upstream} — fetch to check.</div>}
              {incoming.map((c) => commitRow(c, 'incoming'))}
              {sectionHeader('Outgoing', outgoing.length, outgoing.length > 0
                ? <Button size="sm" icon={<ArrowUp />} disabled={busy !== null} onClick={() => { void run('Push', () => client.call('git.push', { root }), 'Pushed') }}>Push</Button>
                : undefined)}
              {outgoing.length === 0 && <div class="px-2.5 py-1 text-[11.5px] text-faint">Every local commit is on {head?.upstream}.</div>}
              {outgoing.map((c) => commitRow(c, 'outgoing'))}
              {!syncOnly && sectionHeader('Local History', commits.length)}
            </>
          )}
          {loading && commits.length === 0 && <PanelLoading what="reading the history…" />}
          {!loading && commits.length === 0 && !syncOnly && (
            <PanelEmpty icon={<GitCommit />} title={search.trim() !== '' ? 'No commit matches' : 'No commits yet'} hint={search.trim() !== '' ? 'Try a word from a message, or a sha.' : 'Make the first commit on the Git tab.'} />
          )}
          {shownCommits.map((c) => commitRow(c, 'history'))}
          {!exhausted && !syncOnly && commits.length > 0 && (
            <div class="px-2.5 py-2">
              <Button size="sm" onClick={() => { void loadLog(true) }} loading={loading}>Load more</Button>
            </div>
          )}
        </div>

        {/* Commit details */}
        {selected.length === 1 && (
          <div class={cn('flex min-h-0 flex-col border-t border-border-soft', detailsOpen ? 'flex-[2]' : 'shrink-0')} data-git-details="">
            <div class="flex items-center gap-2 px-2.5 py-1.5">
              <IconButton size="sm" label={detailsOpen ? 'Collapse details' : 'Expand details'} onClick={() => setDetailsOpen((o) => !o)}>{detailsOpen ? <ChevronDown /> : <ChevronRight />}</IconButton>
              <span class="min-w-0 flex-1 truncate text-[12.5px] font-medium">{details?.subject ?? 'Commit'}</span>
              <span class="font-mono text-[11px] text-faint">{details?.short ?? shortSha(selected[0]!)}</span>
              {details !== null && head?.oid === details.sha && (
                <Button size="sm" variant="ghost" icon={<Pencil />} onClick={() => setDialog({ kind: 'amend', message: details.subject + (details.body !== '' ? `\n\n${details.body}` : '') })}>Edit</Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => { if (details) onOpenView({ kind: 'commit', root, sha: details.sha, short: details.short }) }}>Open in new tab</Button>
              <IconButton size="sm" label="Close details" onClick={() => setSelected([])}><X /></IconButton>
            </div>
            {detailsOpen && (
              <div class="flex min-h-0 flex-1">
                <div class="flex w-[300px] shrink-0 flex-col overflow-auto border-r border-border-soft px-2.5 pb-2 text-[12px]">
                  {details === null ? <PanelLoading /> : (
                    <>
                      <div class="text-dim">{details.authorName} <span class="text-faint">&lt;{details.authorEmail}&gt;</span></div>
                      <div class="text-faint">{new Date(details.authorDate).toLocaleString()} · {relativeTime(details.authorDate)}</div>
                      {details.parents.length > 0 && <div class="text-faint">parent{details.parents.length > 1 ? 's' : ''} {details.parents.map(shortSha).join(', ')}</div>}
                      {details.refs.length > 0 && <div class="mt-1 flex flex-wrap gap-1">{details.refs.map((r) => <RefLabel key={`${r.kind}:${r.name}`} name={r.name} kind={r.kind} current={r.name === current} />)}</div>}
                      {details.body !== '' && <pre class="mt-1.5 whitespace-pre-wrap font-ui text-[12px] text-fg">{details.body}</pre>}
                      <div class="mt-2 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-faint">Changes <span class="font-mono">{details.files.length}</span></div>
                      {details.files.map((file: GitChangedFile) => (
                        <button
                          key={file.path}
                          type="button"
                          data-commit-file={file.path}
                          class={cn('flex items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-raised', detailFile === file.path && 'bg-accent-soft')}
                          onClick={() => setDetailFile(file.path)}
                          onDblClick={() => onOpenFile(file.path, 'file')}
                          title={file.oldPath !== undefined ? `${file.oldPath} → ${file.path}` : file.path}
                        >
                          <span class={cn('w-3 shrink-0 font-mono text-[11px]', file.status === 'A' ? 'text-green' : file.status === 'D' ? 'text-red' : 'text-yellow')}>{file.status}</span>
                          <span class="min-w-0 flex-1 truncate">{file.path}</span>
                          {!file.binary && <span class="shrink-0 font-mono text-[10.5px]"><span class="text-green">+{file.additions}</span> <span class="text-red">−{file.deletions}</span></span>}
                        </button>
                      ))}
                    </>
                  )}
                </div>
                <div class="min-w-0 flex-1 overflow-auto px-3 py-2">
                  {detailFile === null
                    ? <div class="text-[12px] text-faint">Select a file to see what this commit changed in it.</div>
                    : fileDiff === null ? <PanelLoading /> : fileDiff.trim() === '' ? <div class="text-[12px] text-faint">No textual change.</div> : <DiffView content={fileDiff} dense />}
                </div>
              </div>
            )}
          </div>
        )}
        {repo.operation !== null && (
          <div class="border-t border-border-soft px-2.5 py-1.5">
            <PanelNote tone="warn" inset>A {repo.operation} is in progress — finish or abort it on the Git tab.</PanelNote>
          </div>
        )}
      </div>

      {/* Dialogs */}
      <NewBranchDialog
        open={dialog?.kind === 'new-branch'}
        onClose={() => setDialog(null)}
        current={dialog?.kind === 'new-branch' ? dialog.base : current}
        locals={refs.local.map((b) => b.name)}
        remotes={refs.remote.map((b) => b.name)}
        onCreate={async (p) => { const r = await run('New branch', () => client.call('git.branchCreate', { root, name: p.name, base: p.base, checkout: p.checkout, track: p.track }), `Created ${p.name}`); return r?.ok === true }}
      />
      {dialog?.kind === 'tag' && (
        <TagDialog open onClose={() => setDialog(null)} at={{ short: dialog.short, subject: dialog.subject }} onCreate={async (name, message) => { const r = await run('Create tag', () => client.call('git.tagCreate', { root, name, at: dialog.sha, message }), `Tagged ${name}`); return r?.ok === true }} />
      )}
      {dialog?.kind === 'reset' && (
        <ResetDialog open onClose={() => setDialog(null)} target={{ short: dialog.short, subject: dialog.subject }} onReset={async (mode) => { const r = await run('Reset', () => client.call('git.reset', { root, sha: dialog.sha, mode }), `Reset to ${dialog.short}`); return r?.ok === true }} />
      )}
      {dialog?.kind === 'delete-branch' && (
        <ConfirmDialog
          open
          onCancel={() => setDialog(null)}
          title={dialog.remote !== undefined ? `Delete ${dialog.name} from ${dialog.remote}?` : `Delete branch ${dialog.name}?`}
          description={dialog.remote !== undefined ? 'The branch is removed on the remote for everyone who fetches it.' : dialog.force ? 'It has commits that are not merged anywhere else — they are lost.' : 'A branch whose commits are merged elsewhere is safe to delete; one that is not is refused, and you can delete it anyway from the next question.'}
          confirmLabel={dialog.force ? 'Delete anyway' : 'Delete'}
          onConfirm={async () => {
            const r = await run('Delete branch', () => client.call('git.branchDelete', { root, name: dialog.name, force: dialog.force, ...(dialog.remote !== undefined ? { remote: dialog.remote } : {}) }), `Deleted ${dialog.name}`)
            if (r !== null && !r.ok && dialog.remote === undefined && !dialog.force && /not merged/i.test(r.problem ?? '')) { setDialog({ ...dialog, force: true }); return false }
            return r?.ok === true
          }}
        />
      )}
      {dialog?.kind === 'rename-branch' && (
        <TextDialog open onClose={() => setDialog(null)} title={`Rename ${dialog.name}`} label="New name" initial={dialog.name} confirmLabel="Rename" onSubmit={async (v) => { const r = await run('Rename', () => client.call('git.branchRename', { root, name: dialog.name, newName: v }), `Renamed to ${v}`); return r?.ok === true }} />
      )}
      {dialog?.kind === 'squash' && (
        <TextDialog open onClose={() => setDialog(null)} title={`Squash ${dialog.shas.length} commits`} description="They become one commit with this message. Only the newest commits of the branch, in one run, can be squashed." label="Commit message" initial={dialog.message} confirmLabel="Squash" multiline onSubmit={async (v) => { const r = await run('Squash', () => client.call('git.squash', { root, shas: dialog.shas, message: v }), 'Squashed'); if (r?.ok) setSelected([]); return r?.ok === true }} />
      )}
      {dialog?.kind === 'amend' && (
        <TextDialog open onClose={() => setDialog(null)} title="Edit the last commit's message" description="Amends the commit. Refused once it has been pushed." label="Message" initial={dialog.message} confirmLabel="Amend" multiline onSubmit={async (v) => { const r = await run('Amend', () => client.call('git.amend', { root, message: v }), 'Message amended'); if (r?.ok) setSelected([]); return r?.ok === true }} />
      )}
      {dialog?.kind === 'detach' && (
        <ConfirmDialog open onCancel={() => setDialog(null)} title={`Check out ${dialog.short}?`} description="HEAD becomes detached: you can look around, build and test, even commit — but commits made here are kept only if you create a branch before checking out something else." confirmLabel="Checkout (detached)" danger={false} onConfirm={async () => { const r = await run('Checkout', () => client.call('git.checkoutDetached', { root, sha: dialog.sha }), `Checked out ${dialog.short}`); return r?.ok === true }} />
      )}
      {dialog?.kind === 'revert' && (
        <ConfirmDialog open onCancel={() => setDialog(null)} title={`Revert ${dialog.short}?`} description={`A new commit undoes "${dialog.subject}". History is kept; nothing is rewritten.`} confirmLabel="Revert" danger={false} onConfirm={async () => { const r = await run('Revert', () => client.call('git.revert', { root, sha: dialog.sha }), `Reverted ${dialog.short}`); return r?.ok === true }} />
      )}
      {dialog?.kind === 'cherry-pick' && (
        <ConfirmDialog open onCancel={() => setDialog(null)} title={`Cherry-pick ${dialog.shas.length === 1 ? shortSha(dialog.shas[0]!) : `${dialog.shas.length} commits`} onto ${current ?? 'HEAD'}?`} description="Copies the change as a new commit on the current branch." confirmLabel="Cherry-pick" danger={false} onConfirm={async () => { const r = await run('Cherry-pick', () => client.call('git.cherryPick', { root, shas: dialog.shas }), 'Cherry-picked'); return r?.ok === true }} />
      )}
      {dialog?.kind === 'merge' && (
        <ConfirmDialog open onCancel={() => setDialog(null)} title={`Merge '${dialog.branch}' into '${dialog.current}'?`} description="Brings its commits into the current branch. Conflicts, if any, are resolved on the Git tab." confirmLabel="Merge" danger={false} onConfirm={async () => { const r = await run('Merge', () => client.call('git.merge', { root, branch: dialog.branch }), `Merged ${dialog.branch}`); return r !== null && (r.ok || kindOf(r) === 'conflict') }} />
      )}
      {dialog?.kind === 'rebase' && (
        <ConfirmDialog open onCancel={() => setDialog(null)} title={`Rebase '${dialog.current}' onto '${dialog.onto}'?`} description="Replays this branch's commits on top of the other one. Rewrites this branch's history — fine for a branch only you work on." confirmLabel="Rebase" onConfirm={async () => { const r = await run('Rebase', () => client.call('git.rebase', { root, onto: dialog.onto }), `Rebased onto ${dialog.onto}`); return r !== null && (r.ok || kindOf(r) === 'conflict') }} />
      )}
      <PushBehindDialog
        open={dialog?.kind === 'push-behind'}
        onClose={() => setDialog(null)}
        onPullThenPush={async () => { const p = await run('Pull', () => client.call('git.pull', { root }), 'Pulled'); if (p?.ok !== true) return false; const u = await run('Push', () => client.call('git.push', { root }), 'Pushed'); return u?.ok === true }}
        onPull={async () => (await run('Pull', () => client.call('git.pull', { root }), 'Pulled'))?.ok === true}
        onForce={async () => (await run('Push', () => client.call('git.push', { root, forceWithLease: true }), 'Force-pushed'))?.ok === true}
      />
      <PublishDialog
        open={dialog?.kind === 'publish'}
        onClose={() => setDialog(null)}
        branch={current ?? 'HEAD'}
        remotes={remoteNames.length > 0 ? remoteNames : ['origin']}
        onPublish={async (remote) => (await run('Publish', () => client.call('git.push', { root, setUpstream: true, remote }), 'Published'))?.ok === true}
      />
    </div>
  )
}
