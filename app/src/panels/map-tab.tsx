import type { VNode } from 'preact'
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks'
import { BookOpen, ChevronDown, ChevronRight, ExternalLink, FileText, Folder, Play, RefreshCw, Search, Square } from 'lucide-preact'
import type { MapNoteResult, MapProgress, MapStatus, MapTreeResult } from '@core/host/protocol'
import type { ProtocolClient } from '../lib/client'
import { Markdown } from '../lib/markdown'
import { PanelEmpty, PanelError, PanelLoading, PanelNote } from '../components/panel'
import { Button, IconButton } from '../ui/button'
import { Chip } from '../ui/chip'
import { cn } from '../ui/cn'
import { Input } from '../ui/input'
import { Switch } from '../ui/switch'
import { toast } from '../ui/toast'

/**
 * The project map (docs/MAP.md), as the inspector's Map tab: the state of the vault, the
 * build with its progress, the tree of modules and files, a search, and one note at a
 * time with the links it carries — the same notes Obsidian opens from `.privatecode/map`.
 */

interface Target {
  kind: 'file' | 'module' | 'project'
  path: string
}

/** Obsidian's `[[target|label]]` reads as `label` here; the links row underneath is the
 * clickable version, built from the note's own data rather than parsed from prose. */
function plainWikilinks(markdown: string): string {
  return markdown
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
}

const phaseLabel: Record<MapProgress['phase'], string> = {
  skeleton: 'Reading the code',
  files: 'Writing file notes',
  modules: 'Writing module notes',
  project: 'Writing the project note',
  verify: 'Checking a note against its source',
  done: 'Done',
  stopped: 'Stopped',
  failed: 'Failed',
}

export function MapTab({ client, active, onOpenFile }: {
  client: ProtocolClient
  active: boolean
  onOpenFile: (path: string) => void
}): VNode {
  const [status, setStatus] = useState<MapStatus | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [progress, setProgress] = useState<MapProgress | null>(null)
  const [tree, setTree] = useState<MapTreeResult | null>(null)
  const [target, setTarget] = useState<Target | null>(null)
  const [note, setNote] = useState<MapNoteResult | null>(null)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<{ kind: 'file' | 'module'; path: string; what: string }[] | null>(null)
  const [open, setOpen] = useState<Set<string>>(() => new Set(['']))
  const [verify, setVerify] = useState(false)
  const [scope, setScope] = useState('')

  const load = useCallback(() => {
    client.call('map.status', {})
      .then((s) => { if (s !== undefined) { setStatus(s); setProblem(null) } })
      .catch((e: Error) => setProblem(e.message))
    client.call('map.tree', {})
      .then((t) => {
        if (t === undefined) return
        setTree(t)
        // The first level opens by itself: a tree of closed folders is a tree nobody opened.
        setOpen((s) => new Set([...s, ...(t.modules.find((m) => m.path === '')?.children ?? [])]))
      })
      .catch(() => {})
  }, [client])
  useEffect(() => { load() }, [load])

  const fetchNote = useCallback((t: Target) => {
    client.call('map.note', { path: t.kind === 'project' ? 'Project' : t.path === '' ? '.' : t.path })
      .then((n) => setNote(n))
      .catch((e: Error) => setNote({ kind: 'missing', markdown: e.message, links: [] }))
  }, [client])
  const show = useCallback((t: Target) => {
    setTarget(t)
    setHits(null)
    fetchNote(t)
  }, [fetchNote])

  // The build reports every note; the tree and the counts follow, and the note on screen is
  // read again — the one that said "no note yet" while the build ran is the one most likely
  // to have been written since.
  useEffect(() => {
    const off = client.on('map.progress', (p) => {
      setProgress(p)
      const refresh = (): void => { load(); if (target !== null) fetchNote(target) }
      if (p.phase === 'done' || p.phase === 'stopped' || p.phase === 'failed') {
        refresh()
        if (p.phase === 'done') toast.push({ title: 'Project map built', ...(p.message !== undefined ? { description: p.message } : {}), tone: 'success' })
        if (p.phase === 'failed') toast.push({ title: 'The map build failed', ...(p.message !== undefined ? { description: p.message } : {}), tone: 'error' })
      } else if (p.done > 0 && p.done % 5 === 0) {
        refresh()
      }
    })
    return off
  }, [client, load, fetchNote, target])
  useEffect(() => {
    if (status?.exists === true && target === null && active) show({ kind: 'project', path: '' })
  }, [status?.exists, target, active, show])

  const build = (): void => {
    client.call('map.build', { verify, ...(scope.trim() !== '' ? { scope: scope.trim() } : {}) })
      .then((r) => {
        if (!r.started) toast.push({ title: 'The map is already being built', tone: 'error' })
        else setProgress({ phase: 'skeleton', done: 0, total: 0 })
      })
      .catch((e: Error) => toast.push({ title: 'Could not start the build', description: e.message, tone: 'error' }))
  }
  const stop = (): void => { void client.call('map.stop', {}).then(() => load()) }
  const search = (q: string): void => {
    setQuery(q)
    if (q.trim().length < 3) { setHits(null); return }
    client.call('map.search', { query: q.trim() }).then((r) => setHits(r.hits)).catch(() => setHits([]))
  }

  const building = status?.building === true || (progress !== null && !['done', 'stopped', 'failed'].includes(progress.phase))
  const fraction = progress !== null && progress.total > 0 ? Math.min(1, progress.done / progress.total) : null

  const byPath = useMemo(() => new Map((tree?.modules ?? []).map((m) => [m.path, m])), [tree])
  const toggle = (path: string): void => setOpen((s) => { const next = new Set(s); if (next.has(path)) next.delete(path); else next.add(path); return next })

  const renderModule = (path: string, depth: number): VNode | null => {
    const m = byPath.get(path)
    if (m === undefined) return null
    const isOpen = open.has(path)
    const name = path === '' ? 'root' : (path.split('/').pop() ?? path)
    const selected = target?.kind === 'module' && target.path === path
    return (
      <div key={`m:${path}`}>
        <div class={cn('group flex h-6 items-center gap-1 pr-1 text-[12.5px] hover:bg-raised', selected && 'bg-accent-soft')} style={{ paddingLeft: `${depth * 12 + 4}px` }} data-map-module={path}>
          <button type="button" class="flex w-4 shrink-0 items-center text-faint" aria-label={isOpen ? 'Collapse' : 'Expand'} onClick={() => toggle(path)}>{isOpen ? <ChevronDown class="size-3.5" /> : <ChevronRight class="size-3.5" />}</button>
          <button type="button" class={cn('flex min-w-0 flex-1 items-center gap-1.5 text-left', m.noted ? 'text-fg' : 'text-dim')} onClick={() => show({ kind: 'module', path })} title={path === '' ? '.' : path}>
            <Folder class="size-3.5 shrink-0 text-blue opacity-75" />
            <span class="truncate">{name}/</span>
            {!m.noted && <span class="text-[10.5px] text-faint">no note</span>}
          </button>
        </div>
        {isOpen && m.children.map((c) => renderModule(c, depth + 1))}
        {isOpen && m.files.map((f) => {
          const fileSelected = target?.kind === 'file' && target.path === f.path
          return (
            <button
              key={`f:${f.path}`}
              type="button"
              data-map-file={f.path}
              class={cn('flex h-6 w-full items-center gap-1.5 pr-1 text-left text-[12.5px] hover:bg-raised', fileSelected && 'bg-accent-soft', f.noted ? 'text-fg' : 'text-faint')}
              style={{ paddingLeft: `${(depth + 1) * 12 + 20}px` }}
              onClick={() => show({ kind: 'file', path: f.path })}
              title={f.path}
            >
              <FileText class="size-3.5 shrink-0 text-faint" />
              <span class="truncate">{f.path.split('/').pop()}</span>
              {f.fidelity !== null && <span class="ml-auto shrink-0 font-mono text-[10.5px] text-faint" title="fidelity: the share of questions about the source the note could answer">{Math.round(f.fidelity * 100)}%</span>}
              {!f.noted && <span class="ml-auto shrink-0 text-[10.5px] text-faint">{f.stale === true ? 'stale' : 'no note'}</span>}
            </button>
          )
        })}
      </div>
    )
  }

  if (problem !== null && status === null) return <PanelError message={problem} onRetry={load} />
  if (status === null) return <PanelLoading what="reading the map…" />

  const header = (
    <div class="flex flex-col gap-1.5 border-b border-border-soft px-2.5 py-2" data-map-header="">
      <div class="flex items-center gap-2">
        <BookOpen class="size-4 text-accent" />
        <span class="text-[13px] font-semibold">Project map</span>
        {status.exists && (
          <span class="text-[11.5px] text-faint" data-map-counts="">
            {status.noted}/{status.files} files noted{status.stale > 0 ? ` · ${status.stale} to write` : ''}{status.fidelity !== null ? ` · fidelity ${Math.round(status.fidelity * 100)}%` : ''}
          </span>
        )}
        <span class="ml-auto flex items-center gap-1">
          {building
            ? <Button size="sm" variant="danger" icon={<Square />} onClick={stop} data-action="map-stop">Stop</Button>
            : <Button size="sm" variant="primary" icon={status.exists ? <RefreshCw /> : <Play />} onClick={build} data-action="map-build" title={status.exists ? 'Write notes for files that changed since, and for modules above them' : 'Read every source file and write a note for each, then the modules, then the project'}>{status.exists ? (status.stale > 0 ? `Update (${status.stale})` : 'Update') : 'Build'}</Button>}
        </span>
      </div>
      {!building && (
        <div class="flex items-center gap-2 text-[11.5px]">
          <Switch size="sm" checked={verify} onChange={setVerify} label="Self-check" hint="Three questions per note, answered from the note alone and judged — three more model calls per file" />
          <Input class="h-6 w-[150px] text-[11.5px]" placeholder="only under… (folder)" value={scope} aria-label="Limit the build to a folder" onInput={(e) => setScope(e.currentTarget.value)} />
        </div>
      )}
      {progress !== null && (
        <div class="flex flex-col gap-1" data-map-progress={progress.phase}>
          <div class="flex items-center gap-2 text-[11.5px] text-dim">
            <span>{phaseLabel[progress.phase]}</span>
            {progress.current !== undefined && <span class="min-w-0 truncate font-mono text-[11px] text-faint" title={progress.current}>{progress.current}</span>}
            {progress.total > 0 && <span class="ml-auto shrink-0 tabular-nums">{progress.done}/{progress.total}</span>}
          </div>
          {fraction !== null && building && (
            <div class="h-1 overflow-hidden rounded-full bg-active" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
              <div class="h-full rounded-full bg-accent transition-[width] duration-(--duration-normal)" style={{ width: `${Math.round(fraction * 100)}%` }} />
            </div>
          )}
          {progress.message !== undefined && <span class="text-[11.5px] text-faint">{progress.message}</span>}
        </div>
      )}
    </div>
  )

  if (!status.exists && !building) {
    return (
      <div data-panel="map" class="flex h-full min-h-0 flex-col font-ui">
        {header}
        <div class="p-3">
          <PanelEmpty
            icon={<BookOpen />}
            title="No map yet"
            hint="Build reads every source file and writes a note for each — what it does and why, its contracts, invariants and traps, who uses it, its tests — then a note per module and one for the project. It runs on the local model; a few seconds a file, and only changed files next time."
          />
        </div>
      </div>
    )
  }

  return (
    <div data-panel="map" class="flex h-full min-h-0 flex-col font-ui">
      {header}
      <div class="flex items-center gap-1.5 border-b border-border-soft px-2.5 py-1.5">
        <Search class="size-3.5 text-faint" />
        <Input class="h-6 flex-1 text-[12px]" placeholder="Search the notes" aria-label="Search the notes" value={query} onInput={(e) => search(e.currentTarget.value)} />
      </div>
      <div class="flex min-h-0 flex-1">
        <div class="flex w-[200px] shrink-0 flex-col overflow-auto border-r border-border-soft py-1" data-map-tree="">
          {hits !== null
            ? hits.length === 0
              ? <div class="px-2.5 py-2 text-[11.5px] text-faint">nothing matches</div>
              : hits.map((h) => (
                <button key={`${h.kind}:${h.path}`} type="button" data-map-hit={h.path} class="flex flex-col px-2.5 py-1 text-left hover:bg-raised" onClick={() => show({ kind: h.kind, path: h.path })}>
                  <span class="truncate text-[12.5px]">{h.kind === 'module' ? `${h.path || '.'}/` : h.path.split('/').pop()}</span>
                  <span class="truncate text-[11px] text-faint">{h.what}</span>
                </button>
              ))
            : (
              <>
                <button type="button" class={cn('flex h-6 w-full items-center gap-1.5 px-2.5 text-left text-[12.5px] hover:bg-raised', target?.kind === 'project' && 'bg-accent-soft')} onClick={() => show({ kind: 'project', path: '' })} data-map-project="">
                  <BookOpen class="size-3.5 text-accent" /> Project
                </button>
                {renderModule('', 0)}
              </>
              )}
        </div>
        <div class="flex min-w-0 flex-1 flex-col overflow-auto" data-map-note={target === null ? '' : `${target.kind}:${target.path}`}>
          {note === null
            ? <PanelLoading />
            : (
              <>
                <div class="flex items-center gap-1.5 border-b border-border-soft px-3 py-1.5">
                  <Chip tone={note.kind === 'missing' ? 'neutral' : note.kind === 'file' ? 'blue' : note.kind === 'module' ? 'yellow' : 'accent'}>{note.kind}</Chip>
                  <span class="min-w-0 truncate text-[12.5px] font-medium">{target?.kind === 'project' ? 'Project' : target?.path === '' ? 'root/' : target?.path}</span>
                  {target?.kind === 'file' && <Button size="sm" variant="ghost" class="ml-auto" icon={<ExternalLink />} onClick={() => onOpenFile(target.path)}>Open file</Button>}
                </div>
                {note.kind === 'missing' && <div class="px-3 py-2"><PanelNote inset>{note.markdown}</PanelNote></div>}
                {note.kind !== 'missing' && (
                  <div class="px-3 py-2 text-[12.5px] leading-[1.5]">
                    <Markdown text={plainWikilinks(note.markdown)} />
                  </div>
                )}
                {note.links.length > 0 && (
                  <div class="flex flex-wrap gap-1 border-t border-border-soft px-3 py-2" data-map-links="">
                    {note.links.map((l) => (
                      <button key={`${l.kind}:${l.path}`} type="button" class="rounded-full border border-border-soft bg-transparent px-2 py-px text-[11.5px] text-dim hover:border-accent-line hover:text-fg" onClick={() => show({ kind: l.kind, path: l.path })} title={l.kind === 'project' ? 'Project' : l.path === '' ? '.' : l.path}>
                        {l.kind === 'module' ? `${l.label}/` : l.label}
                      </button>
                    ))}
                  </div>
                )}
              </>
              )}
        </div>
      </div>
      <div class="flex items-center gap-2 border-t border-border-soft px-2.5 py-1 text-[11px] text-faint">
        <span class="min-w-0 truncate" title={status.dir}>Vault: {status.dir}</span>
        <IconButton size="sm" label="Copy the vault path for Obsidian" onClick={() => { void navigator.clipboard?.writeText(status.dir) }}><ExternalLink /></IconButton>
      </div>
    </div>
  )
}
