import { useEffect, useRef, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import type { AgentMode } from '@core/permissions/engine'
import type { ProtocolClient } from '../lib/client'
import { Icon } from '../components/icons'

/**
 * One keyboard surface over everything the window can do.
 *
 * The alternative it replaces is real: switching a session means finding the rail, reading
 * titles taken from each session's first message, and guessing; opening a file means the
 * Files tab and a tree; changing mode means finding the chips. Each is two or three
 * deliberate movements for something you already knew the name of.
 *
 * The one genuinely new capability here is searching what was SAID. A title is the opening
 * line of a conversation and the worst summary of what it became — the thing anyone actually
 * remembers is a file name, an error string, a command that finally worked.
 */

export type PaletteAction =
  | { kind: 'session'; id: string; title: string; detail: string }
  | { kind: 'file'; path: string }
  | { kind: 'mode'; mode: AgentMode }
  | { kind: 'command'; id: 'new-session' | 'settings' | 'copy-conversation'; label: string }

interface Entry {
  action: PaletteAction
  label: string
  detail?: string
  icon: VNode
  group: string
}

const MODES: AgentMode[] = ['normal', 'plan', 'auto-edit', 'autopilot']

const COMMANDS: Entry[] = [
  {
    action: { kind: 'command', id: 'new-session', label: 'New session' },
    label: 'New session', icon: Icon.plus(), group: 'Do',
  },
  {
    action: { kind: 'command', id: 'settings', label: 'Settings' },
    label: 'Settings', icon: Icon.gear(), group: 'Do',
  },
  {
    action: { kind: 'command', id: 'copy-conversation', label: 'Copy conversation as Markdown' },
    label: 'Copy conversation as Markdown', icon: Icon.files(), group: 'Do',
  },
]

function matches(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase())
}

export function Palette({
  client, onClose, onPick,
}: {
  client: ProtocolClient
  onClose: () => void
  onPick: (action: PaletteAction) => void
}): VNode {
  const [query, setQuery] = useState('')
  const [files, setFiles] = useState<string[]>([])
  const [sessions, setSessions] = useState<Entry[]>([])
  const [pick, setPick] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  // Escape closes the palette from ANYWHERE — a result button, or nowhere at all after a
  // click on the overlay moved focus to body. The input's own handler only covers the
  // input; everywhere else the keypress fell through to the composer's window abort
  // listener, so Esc on an open palette silently stopped a running turn. Capture phase for
  // files-tab.tsx's reason: it must run before window's bubble-phase abort handler.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return
      // The settings dialog can be on screen above this palette; its Escape must close IT.
      if (document.querySelector('.modal') !== null) return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [onClose])

  useEffect(() => {
    let cancelled = false
    client.call('fs.find', { query, limit: 8 })
      .then((r) => { if (!cancelled) setFiles(r.paths) })
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
          icon: Icon.search(),
          group: 'Sessions',
        })
      }
      for (const s of listed.sessions) {
        if (seen.has(s.id)) continue
        if (trimmed !== '' && !matches(s.title, trimmed)) continue
        entries.push({
          action: { kind: 'session', id: s.id, title: s.title, detail: '' },
          label: s.title || '(untitled)',
          icon: Icon.chat(),
          group: 'Sessions',
        })
      }
      setSessions(entries.slice(0, 8))
    })
    return () => { cancelled = true }
  }, [client, query])

  const entries: Entry[] = [
    ...sessions,
    ...files.map((path): Entry => ({
      action: { kind: 'file', path }, label: path, icon: Icon.file(), group: 'Files',
    })),
    ...MODES
      .filter((m) => query.trim() === '' || matches(m, query))
      .map((mode): Entry => ({
        action: { kind: 'mode', mode }, label: `Mode: ${mode}`, icon: Icon.shield(), group: 'Do',
      })),
    ...COMMANDS.filter((c) => query.trim() === '' || matches(c.label, query)),
  ]

  const active = Math.min(pick, Math.max(0, entries.length - 1))

  function choose(entry: Entry | undefined): void {
    if (!entry) return
    onPick(entry.action)
    onClose()
  }

  return (
    <div class="modal-overlay" onClick={onClose}>
      <div class="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          class="palette-input"
          value={query}
          placeholder="Go to a session, a file, a mode — or search what was said"
          onInput={(e) => { setQuery(e.currentTarget.value); setPick(0) }}
          onKeyDown={(e) => {
            // Escape is handled here and stopped: the window's own Escape aborts the running
            // turn, and closing a dropdown is not a request to stop the agent.
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return }
            if (e.key === 'ArrowDown') { e.preventDefault(); setPick((i) => (i + 1) % Math.max(1, entries.length)) }
            if (e.key === 'ArrowUp') { e.preventDefault(); setPick((i) => (i - 1 + entries.length) % Math.max(1, entries.length)) }
            if (e.key === 'Enter') { e.preventDefault(); choose(entries[active]) }
          }}
        />
        <div class="palette-list">
          {entries.length === 0 && <div class="panel-placeholder">Nothing matches that.</div>}
          {entries.map((entry, i) => (
            <button
              key={`${entry.group}:${entry.label}:${i}`}
              class={`palette-item ${i === active ? 'palette-item-on' : ''}`}
              onMouseEnter={() => setPick(i)}
              onClick={() => choose(entry)}
            >
              <span class="palette-icon">{entry.icon}</span>
              <span class="palette-label">{entry.label}</span>
              {entry.detail !== undefined && <span class="palette-detail">{entry.detail}</span>}
              <span class="palette-group">{entry.group}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
