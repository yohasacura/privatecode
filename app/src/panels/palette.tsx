import { useEffect, useRef, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import { Check, Copy, FileText, MessageSquare, Plus, Search, Settings, Shield } from 'lucide-preact'
import type { AgentMode } from '@core/permissions/engine'
import type { ProtocolClient } from '../lib/client'
import { cn } from '../ui/cn'
import { LAYER, Portal } from '../ui/overlay'
import { SETTINGS_TABS, type SettingsTab } from './status'

/**
 * One keyboard surface over everything the window can do (docs/UI-REDESIGN-2026-09.md §8
 * "The palette").
 *
 * The alternative it replaces is real: switching a session means finding the rail, reading
 * titles taken from each session's first message, and guessing; opening a file means the
 * Files tab and a tree; changing mode means finding the chips. Each is two or three
 * deliberate movements for something you already knew the name of.
 *
 * The one genuinely new capability here is searching what was SAID. A title is the opening
 * line of a conversation and the worst summary of what it became — the thing anyone actually
 * remembers is a file name, an error string, a command that finally worked.
 *
 * A command that cannot run right now is listed disabled with the reason in its subtitle
 * rather than hidden — a hidden command is one nobody learns.
 */

export type PaletteAction =
  | { kind: 'session'; id: string; title: string; detail: string }
  | { kind: 'file'; path: string }
  | { kind: 'mode'; mode: AgentMode }
  | { kind: 'settings'; tab: SettingsTab }
  | { kind: 'command'; id: 'new-session' | 'settings' | 'copy-conversation' | 'check-updates'; label: string }

/** What the window is doing, so the palette can say which commands cannot run yet. */
export interface PaletteContext {
  turnRunning: boolean
  hasConversation: boolean
}

interface Entry {
  action: PaletteAction
  label: string
  detail?: string
  icon: VNode
  group: string
  shortcut?: string
  /** Why it cannot run now; the entry is shown, not offered. */
  disabled?: string
}

const MODES: AgentMode[] = ['normal', 'plan', 'auto-edit', 'autopilot']

function commands(context: PaletteContext): Entry[] {
  return [
    {
      action: { kind: 'command', id: 'new-session', label: 'New session' },
      label: 'New session', icon: <Plus />, group: 'Do', shortcut: 'Ctrl+N',
      ...(context.turnRunning ? { disabled: 'a turn is running — stop it first, or wait' } : {}),
    },
    {
      action: { kind: 'command', id: 'settings', label: 'Settings' },
      label: 'Settings', icon: <Settings />, group: 'Do', shortcut: 'Ctrl+,',
    },
    {
      action: { kind: 'command', id: 'copy-conversation', label: 'Copy conversation as Markdown' },
      label: 'Copy conversation as Markdown', icon: <Copy />, group: 'Do',
      ...(context.hasConversation ? {} : { disabled: 'nothing has been said yet' }),
    },
    {
      // The one place a check is asked for by name, and so the one place "could not check"
      // and "this is the latest" are said out loud — the automatic check stays silent.
      action: { kind: 'command', id: 'check-updates', label: 'Check for updates' },
      label: 'Check for updates', icon: <Check />, group: 'Do',
    },
  ]
}

function matches(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase())
}

export function Palette({
  client, context, onClose, onPick,
}: {
  client: ProtocolClient
  context: PaletteContext
  onClose: () => void
  onPick: (action: PaletteAction) => void
}): VNode {
  const [query, setQuery] = useState('')
  const [files, setFiles] = useState<string[]>([])
  const [sessions, setSessions] = useState<Entry[]>([])
  const [pick, setPick] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  // Escape closes the palette from ANYWHERE — a result button, or nowhere at all after a
  // click on the overlay moved focus to body. The input's own handler only covers the
  // input; everywhere else the keypress fell through to the composer's window abort
  // listener, so Esc on an open palette silently stopped a running turn. Capture phase for
  // App's editor-tab Esc reason: it must run before window's bubble-phase abort handler.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return
      // A dialog can be on screen above this palette; its Escape must close IT.
      if (document.querySelector('[role="dialog"][aria-modal="true"]') !== null) return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [onClose])

  useEffect(() => {
    let cancelled = false
    client.call('fs.find', { query, limit: 8 })
      // Files only here. The palette OPENS what it lists, and a directory is not a thing
      // this window can open in a tab — the `@` picker wants both because it ATTACHES.
      .then((r) => { if (!cancelled) setFiles(r.entries.filter((e) => !e.dir).map((e) => e.path)) })
      .catch(() => { if (!cancelled) setFiles([]) })
    return () => { cancelled = true }
  }, [client, query])

  // Two sources for sessions, and both are needed: the list answers a query that looks like
  // a title, the search answers one that looks like something said. A session found by both
  // must appear once, so the search wins and carries the better detail line.
  useEffect(() => {
    let cancelled = false
    const trimmed = query.trim()
    Promise.all([
      client.call('sessions.list', {}).catch(() => ({ sessions: [] as { id: string; title: string; updatedAt: string }[] })),
      trimmed === ''
        ? Promise.resolve({ hits: [] })
        : client.call('sessions.search', { query: trimmed, limit: 6 }).catch(() => ({ hits: [] })),
    ]).then(([listed, found]) => {
      if (cancelled) return
      const entries: Entry[] = []
      const seen = new Set<string>()
      for (const hit of found.hits) {
        seen.add(hit.sessionId)
        entries.push({
          action: { kind: 'session', id: hit.sessionId, title: hit.title, detail: hit.snippet },
          label: hit.title || '(untitled)',
          detail: hit.snippet,
          icon: <Search />,
          group: 'Sessions',
        })
      }
      for (const s of listed.sessions) {
        if (seen.has(s.id)) continue
        if (trimmed !== '' && !matches(s.title, trimmed)) continue
        entries.push({
          action: { kind: 'session', id: s.id, title: s.title, detail: '' },
          label: s.title || '(untitled)',
          icon: <MessageSquare />,
          group: 'Sessions',
        })
      }
      setSessions(entries.slice(0, 8))
    })
    return () => { cancelled = true }
  }, [client, query])

  const trimmed = query.trim()
  const entries: Entry[] = [
    ...sessions,
    ...files.map((path): Entry => ({
      action: { kind: 'file', path }, label: path, icon: <FileText />, group: 'Files',
    })),
    ...MODES
      .filter((m) => trimmed === '' || matches(m, trimmed) || matches('mode', trimmed))
      .map((mode): Entry => ({
        action: { kind: 'mode', mode }, label: `Mode: ${mode}`, icon: <Shield />, group: 'Do',
      })),
    ...commands(context).filter((c) => trimmed === '' || matches(c.label, trimmed)),
    ...SETTINGS_TABS
      .filter((t) => trimmed === '' || matches(t.label, trimmed) || matches('settings', trimmed))
      .map((t): Entry => ({
        action: { kind: 'settings', tab: t.id }, label: `Settings › ${t.label}`, icon: <Settings />, group: 'Settings',
      })),
  ]

  const active = Math.min(pick, Math.max(0, entries.length - 1))

  // The highlighted row stays in view while the arrows move it.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [active])

  function choose(entry: Entry | undefined): void {
    if (!entry || entry.disabled !== undefined) return
    onPick(entry.action)
    onClose()
  }

  function step(delta: number): void {
    if (entries.length === 0) return
    setPick((i) => (i + delta + entries.length) % entries.length)
  }

  const groups: string[] = []
  for (const e of entries) if (!groups.includes(e.group)) groups.push(e.group)

  return (
    <Portal>
      <div
        data-palette=""
        class={cn('fixed inset-0 flex items-start justify-center bg-(--overlay) px-6 pt-[10vh]', LAYER.dialog,
          'motion-safe:animate-[fade-in_var(--duration-normal)_var(--ease-enter)]')}
        onPointerDown={(e) => { if (e.target === e.currentTarget) onClose() }}
      >
        <div
          role="dialog"
          aria-label="Command palette"
          class={cn(
            'flex max-h-[70vh] w-[600px] max-w-full flex-col overflow-hidden rounded-lg border border-border bg-panel shadow-(--shadow-overlay)',
            'motion-safe:animate-[pop-in_var(--duration-normal)_var(--ease-enter)]',
          )}
        >
          <div class="flex items-center gap-2 border-b border-border-soft px-3">
            <span class="inline-flex shrink-0 text-faint [&>svg]:size-4"><Search /></span>
            <input
              ref={inputRef}
              role="combobox"
              aria-expanded="true"
              aria-controls="palette-list"
              aria-activedescendant={entries.length > 0 ? `palette-item-${active}` : undefined}
              aria-autocomplete="list"
              class="h-11 min-w-0 flex-1 border-0 bg-transparent font-ui text-[14px] text-fg outline-none placeholder:text-faint"
              value={query}
              placeholder="Go to a session, a file, a mode, a setting — or search what was said"
              onInput={(e) => { setQuery(e.currentTarget.value); setPick(0) }}
              onKeyDown={(e) => {
                // Escape is handled here and stopped: the window's own Escape aborts the running
                // turn, and closing a dropdown is not a request to stop the agent.
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return }
                if (e.key === 'ArrowDown') { e.preventDefault(); step(1) }
                if (e.key === 'ArrowUp') { e.preventDefault(); step(-1) }
                if (e.key === 'Enter') { e.preventDefault(); choose(entries[active]) }
              }}
            />
            <kbd class="shrink-0 rounded-sm border border-border px-1.5 py-0.5 font-ui text-[10.5px] text-faint">Esc</kbd>
          </div>
          <div ref={listRef} id="palette-list" role="listbox" class="min-h-0 flex-1 overflow-y-auto py-1.5">
            {entries.length === 0 && (
              <div class="px-4 py-5 text-center font-ui text-[12.5px] text-faint">Nothing matches that.</div>
            )}
            {groups.map((group) => (
              <div key={group} role="group" aria-label={group}>
                <div class="px-4 pb-0.5 pt-2 font-ui text-[10.5px] font-semibold uppercase tracking-[0.06em] text-faint">{group}</div>
                {entries.map((entry, i) => entry.group !== group ? null : (
                  <button
                    key={`${entry.group}:${entry.label}:${i}`}
                    id={`palette-item-${i}`}
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    aria-disabled={entry.disabled !== undefined || undefined}
                    data-index={i}
                    data-disabled={entry.disabled !== undefined ? '' : undefined}
                    onMouseEnter={() => setPick(i)}
                    onClick={() => choose(entry)}
                    class={cn(
                      'flex w-full items-center gap-2.5 border-0 bg-transparent px-4 py-1.5 text-left font-ui text-[13px]',
                      'transition-colors duration-(--duration-fast)',
                      entry.disabled !== undefined ? 'cursor-default text-faint' : 'cursor-pointer text-fg',
                      i === active && 'bg-hover',
                    )}
                  >
                    <span class={cn('inline-flex shrink-0 [&>svg]:size-4', entry.disabled !== undefined ? 'text-faint' : 'text-dim')}>{entry.icon}</span>
                    <span class="min-w-0 flex-1">
                      <span class="block truncate">{entry.label}</span>
                      {(entry.disabled ?? entry.detail) !== undefined && (
                        <span class={cn('block truncate text-[11.5px]', entry.disabled !== undefined ? 'text-faint' : 'text-dim')}>
                          {entry.disabled ?? entry.detail}
                        </span>
                      )}
                    </span>
                    {entry.shortcut !== undefined && (
                      <kbd class="shrink-0 rounded-sm border border-border px-1.5 py-0.5 font-ui text-[10.5px] text-faint">{entry.shortcut}</kbd>
                    )}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </Portal>
  )
}
