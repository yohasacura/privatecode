import type { VNode } from 'preact'
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { MoreHorizontal, Plus, Search, Settings, Trash2, X } from 'lucide-preact'
import type { AgentMode } from '@core/permissions/engine'
import type { TranscriptEntry } from '@core/host/protocol'
import type { ProtocolClient } from '../lib/client'
import { groupByDay } from '../lib/day-groups'
import { relativeTime } from '../lib/format'
import type { SessionSwitch } from '../panels/sessions-rail'
import { Button, IconButton } from '../ui/button'
import { Chip, type ChipTone } from '../ui/chip'
import { cn } from '../ui/cn'
import { Input } from '../ui/input'
import { Menu } from '../ui/menu'

/**
 * The left column (docs/UI-REDESIGN-2026-09.md §4): every conversation in this workspace,
 * by day, and the way to start another. A row is READ by clicking it; it becomes the
 * active session when a message is sent — the composer's rule, unchanged.
 *
 * The behaviour is the sessions rail's, carried over whole: `sessions.list`, `.new`,
 * `.delete`, `.deleteAll`, the one-at-a-time confirmation, and adopting the replacement
 * session the host hands back when the live one is deleted. What is new is the shape —
 * day groups, a filter, a status glyph, the mode as a chip, actions in a menu — and the
 * failure paths said in place: a list that cannot be loaded is an error with a Retry, and
 * a delete that fails leaves the row and says why.
 */

type SessionMeta = {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  workspaceRoot: string
  mode: AgentMode
}

/** Stands in for a session id in the one confirmation slot; never a valid id. */
const ALL = 'all'

function adopt(r: {
  sessionId: string
  mode: AgentMode
  gateMode: 'auto' | 'manual'
  contextLength: number | null
  title: string
  problems: string[]
  items: readonly TranscriptEntry[]
  contextUsed: { promptTokens: number | null; approxTokens: number }
  compactAt?: number
}): SessionSwitch {
  return {
    sessionId: r.sessionId, mode: r.mode, gateMode: r.gateMode, contextLength: r.contextLength, title: r.title,
    problems: r.problems, items: r.items, contextUsed: r.contextUsed,
    ...(r.compactAt !== undefined ? { compactAt: r.compactAt } : {}),
  }
}

const MODE_TONE: Record<AgentMode, ChipTone> = {
  normal: 'neutral',
  plan: 'blue',
  'auto-edit': 'yellow',
  autopilot: 'red',
}

export function Sidebar({
  client, activeSessionId, viewingSessionId, turnRunning, onSessionSwitched, onView, onOpenSettings, reloadKey,
}: {
  client: ProtocolClient
  activeSessionId: string | null
  viewingSessionId: string | null
  turnRunning: boolean
  onSessionSwitched: (info: SessionSwitch) => void
  onView: (id: string) => void
  onOpenSettings: () => void
  reloadKey: number
}): VNode {
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [filter, setFilter] = useState<string | null>(null)
  const filterRef = useRef<HTMLInputElement>(null)

  const load = useCallback(() => {
    client.call('sessions.list', {})
      .then((r) => { setSessions(r.sessions); setError(null) })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [client])
  useEffect(load, [load, reloadKey])

  useEffect(() => { if (filter !== null) filterRef.current?.focus() }, [filter])

  function switchTo(promise: Promise<SessionSwitch>): void {
    setBusy(true)
    promise
      .then((info) => { onSessionSwitched(info); load() })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }
  const startNew = (): void => switchTo(client.call('sessions.new', {}).then(adopt))

  function remove(id: string): void {
    setBusy(true)
    setError(null)
    client.call('sessions.delete', { id })
      .then((r) => {
        if (r.problems.length > 0) setError(r.problems.join('; '))
        if (r.replacedBy) onSessionSwitched(adopt(r.replacedBy))
        setConfirming(null)
        load()
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }

  function removeAll(): void {
    setBusy(true)
    setError(null)
    client.call('sessions.deleteAll', {})
      .then((r) => {
        if (r.problems.length > 0) setError(r.problems.join('; '))
        if (r.replacedBy) onSessionSwitched(adopt(r.replacedBy))
        setConfirming(null)
        load()
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }

  const shown = useMemo(() => {
    if (sessions === null) return null
    const q = (filter ?? '').trim().toLowerCase()
    const list = q === '' ? sessions : sessions.filter((s) => (s.title || '(untitled)').toLowerCase().includes(q))
    return groupByDay(list, (s) => s.updatedAt)
  }, [sessions, filter])

  return (
    <nav class="flex h-full flex-col gap-2 p-2 font-ui" aria-label="Sessions">
      <div class="flex items-center gap-1">
        <Button class="flex-1" icon={<Plus />} onClick={startNew} disabled={busy} title="Start a new conversation (Ctrl+N)">
          New session
        </Button>
        <IconButton
          label={filter === null ? 'Search sessions' : 'Close search'}
          active={filter !== null}
          onClick={() => setFilter((f) => (f === null ? '' : null))}
        >
          {filter === null ? <Search /> : <X />}
        </IconButton>
      </div>

      {filter !== null && (
        <Input
          ref={filterRef}
          value={filter}
          placeholder="Filter by title…"
          aria-label="Filter sessions"
          onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setFilter(null) }}
        />
      )}

      {error !== null && (
        <div role="alert" class="flex flex-col gap-1.5 rounded-sm border border-red-line bg-red-soft px-2.5 py-2 text-[12px] text-red">
          <span class="break-words">{error}</span>
          <Button size="sm" class="self-start" onClick={load}>Retry</Button>
        </div>
      )}

      <div class="min-h-0 flex-1 overflow-y-auto">
        {sessions === null && error === null && <div class="px-2 py-3 text-[12px] text-faint">loading…</div>}
        {sessions !== null && sessions.length === 0 && (
          <div class="px-2 py-3 text-[12px] text-faint">Nothing saved yet — the first message starts one.</div>
        )}
        {shown !== null && sessions !== null && sessions.length > 0 && shown.length === 0 && (
          <div class="px-2 py-3 text-[12px] text-faint">No sessions match.</div>
        )}
        {shown?.map((group) => (
          <section key={group.label} class="mb-2">
            <h3 class="m-0 px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-faint">{group.label}</h3>
            <ul class="m-0 flex list-none flex-col gap-px p-0">
              {group.items.map((s) => (
                <li key={s.id}>
                  {confirming === s.id
                    ? (
                      <div data-confirm="session" class="flex flex-col gap-2 rounded-sm border border-red-line bg-red-soft px-2.5 py-2">
                        <span class="text-[12.5px] text-fg">
                          Delete “{s.title || '(untitled)'}”?{s.id === activeSessionId && ' This is the session you are in.'}
                        </span>
                        <span class="flex gap-1.5">
                          <Button size="sm" variant="danger" onClick={() => remove(s.id)} loading={busy}>Delete</Button>
                          <Button size="sm" onClick={() => setConfirming(null)} disabled={busy}>Keep</Button>
                        </span>
                      </div>
                      )
                    : (
                      <SessionRow
                        session={s}
                        active={s.id === activeSessionId}
                        viewing={s.id === viewingSessionId && s.id !== activeSessionId}
                        working={s.id === activeSessionId && turnRunning}
                        busy={busy}
                        onView={() => onView(s.id)}
                        onDelete={() => setConfirming(s.id)}
                      />
                      )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      {sessions !== null && sessions.length > 0 && (
        confirming === ALL
          ? (
            <div data-confirm="all" class="flex flex-col gap-2 rounded-sm border border-red-line bg-red-soft px-2.5 py-2">
              <span class="text-[12.5px] text-fg">Delete all {sessions.length} session{sessions.length === 1 ? '' : 's'}?</span>
              <span class="text-[11.5px] text-dim">
                Conversations only. Checkpoints — the snapshots you can put files back from — are kept.
              </span>
              <span class="flex gap-1.5">
                <Button size="sm" variant="danger" onClick={removeAll} loading={busy}>Delete all</Button>
                <Button size="sm" onClick={() => setConfirming(null)} disabled={busy}>Keep them</Button>
              </span>
            </div>
            )
          : (
            <Button variant="ghost" size="sm" class="self-start" icon={<Trash2 />} onClick={() => setConfirming(ALL)} disabled={busy} data-action="delete-all">
              Delete all sessions
            </Button>
            )
      )}

      <Button variant="ghost" class="justify-start" icon={<Settings />} onClick={onOpenSettings}>
        Settings
      </Button>
    </nav>
  )
}

function SessionRow({ session: s, active, viewing, working, busy, onView, onDelete }: {
  session: SessionMeta
  active: boolean
  viewing: boolean
  working: boolean
  busy: boolean
  onView: () => void
  onDelete: () => void
}): VNode {
  const title = s.title || '(untitled)'
  return (
    <div
      data-session-row={s.id}
      class={cn(
        'group flex items-center gap-1 rounded-sm pr-1 transition-colors duration-(--duration-fast)',
        active ? 'bg-active' : viewing ? 'bg-hover' : 'hover:bg-hover',
      )}
    >
      <button
        type="button"
        onClick={onView}
        disabled={busy}
        aria-current={active ? 'true' : undefined}
        title={active
          ? `${title}\nthe active session — typing below continues it`
          : working
            ? `${title}\nclick to read it — the running session keeps going`
            : `${title}\nclick to read it — sending a message is what makes it the active one`}
        class={cn(
          'flex min-w-0 flex-1 flex-col gap-0.5 rounded-sm border-0 bg-transparent px-2 py-1.5 text-left cursor-pointer',
          'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent',
          'disabled:cursor-default',
        )}
      >
        <span class={cn('truncate text-[13px] leading-[1.35]', active ? 'text-fg-strong font-medium' : 'text-fg')}>{title}</span>
        <span class="flex items-center gap-1.5 text-[11px] text-faint tabular-nums">
          {active && (
            <span
              class={cn('inline-block size-1.5 shrink-0 rounded-full', working ? 'bg-accent motion-safe:animate-pulse' : 'bg-green')}
              role="img"
              aria-label={working ? 'working right now' : 'the active session'}
            />
          )}
          <span>{relativeTime(s.updatedAt)}</span>
          <Chip tone={MODE_TONE[s.mode]} class="h-4 px-1 text-[10px] capitalize">{s.mode}</Chip>
        </span>
      </button>
      <span class="opacity-0 transition-opacity duration-(--duration-fast) group-hover:opacity-100 focus-within:opacity-100">
        <Menu
          label={`Actions for ${title}`}
          items={[
            { id: 'delete', label: 'Delete session…', icon: <Trash2 />, danger: true, disabled: busy, onSelect: onDelete },
          ]}
          trigger={(p) => <IconButton size="sm" label={`Actions for ${title}`} {...p}><MoreHorizontal /></IconButton>}
        />
      </span>
    </div>
  )
}
