import { useEffect, useRef, useState } from 'preact/hooks'
import type { ProtocolClient } from '../lib/client'
import type { ChatItem } from '../lib/state'

/**
 * The file tree panel (Plan 4 Task 7): lazy-loaded directories over `fs.tree`, refreshed
 * automatically when a write-family tool succeeds against a directory the tree has
 * already loaded, and a click on a file hands its path to `onOpenFile` (wired by `App.tsx`
 * to the diffs panel's preview area -- the tree itself never calls `fs.read`).
 */

/** One directory's lazily-fetched listing. `entries: null` means "never fetched, or a
 * fetch is currently in flight with nothing cached yet" -- distinct from `[]`, an
 * genuinely empty directory. */
interface DirState {
  entries: { name: string; dir: boolean }[] | null
  loading: boolean
  error: string | null
}

function dirOf(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const idx = normalized.lastIndexOf('/')
  return idx === -1 ? '' : normalized.slice(0, idx)
}

/**
 * The tree-refresh path parser (Task 7's own name for it, in the plan's verification
 * bullet): given a write-family tool's name and its raw `tool.call` args JSON, returns the
 * workspace-relative directories a successful call just changed the CONTENTS of --
 * `edit_file`/`write_file`/`delete_file` each name one directory (the parent of `path`);
 * `move_file` can name up to two (the parent of `from` AND of `to`, deduplicated -- a move
 * within the same directory returns just one). Any other tool name, or JSON that does not
 * parse or does not carry the expected string field(s), returns `[]` rather than throwing
 * -- a malformed or unrecognized call is simply nothing to refresh, not a crash.
 */
export function affectedDirectories(name: string, argsJson: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(argsJson)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const obj = parsed as Record<string, unknown>

  if (name === 'move_file') {
    const from = obj['from']
    const to = obj['to']
    const dirs = new Set<string>()
    if (typeof from === 'string') dirs.add(dirOf(from))
    if (typeof to === 'string') dirs.add(dirOf(to))
    return [...dirs]
  }
  if (name === 'edit_file' || name === 'write_file' || name === 'delete_file') {
    const path = obj['path']
    return typeof path === 'string' ? [dirOf(path)] : []
  }
  return []
}

export function TreePanel({
  client, toolItems, onOpenFile,
}: {
  client: ProtocolClient
  toolItems: ChatItem[]
  onOpenFile: (path: string) => void
}) {
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']))
  // Read inside effects/callbacks that must not re-run on every `dirs` change themselves
  // (loadDir already updates `dirs` via a functional setState, so it never needs to read
  // this) -- used only to decide "has this directory ever been loaded" without adding
  // `dirs` to the tool-processing effect's own dependency array.
  const dirsRef = useRef(dirs)
  dirsRef.current = dirs
  const processedToolIds = useRef(new Set<number>())

  function loadDir(path: string): void {
    setDirs((prev) => ({ ...prev, [path]: { entries: prev[path]?.entries ?? null, loading: true, error: null } }))
    client.call('fs.tree', { path })
      .then((result) => {
        setDirs((prev) => ({ ...prev, [path]: { entries: result.entries, loading: false, error: null } }))
      })
      .catch((e: unknown) => {
        setDirs((prev) => ({
          ...prev,
          [path]: { entries: prev[path]?.entries ?? null, loading: false, error: e instanceof Error ? e.message : String(e) },
        }))
      })
  }

  useEffect(() => { loadDir('') }, [client])

  // Refresh: a write-family tool succeeding against a directory the tree ALREADY has
  // loaded gets that one directory re-fetched. `processedToolIds` guards against handling
  // the same completed tool item twice across re-renders (this effect re-runs on every
  // `toolItems` change, i.e. on every new chat event, not just tool.result ones).
  useEffect(() => {
    for (const item of toolItems) {
      if (item.kind !== 'tool' || item.result === undefined) continue
      if (processedToolIds.current.has(item.id)) continue
      processedToolIds.current.add(item.id)
      if (!item.result.ok) continue
      for (const dir of affectedDirectories(item.name, item.args)) {
        if (dirsRef.current[dir] !== undefined) loadDir(dir)
      }
    }
  }, [toolItems])

  function toggle(path: string): void {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
        if (dirsRef.current[path] === undefined) loadDir(path)
      }
      return next
    })
  }

  return (
    <div class="tree-panel">
      <DirChildren
        path="" dirs={dirs} expanded={expanded} onToggle={toggle} onOpenFile={onOpenFile}
        onRetry={loadDir} depth={0}
      />
    </div>
  )
}

function DirChildren({
  path, dirs, expanded, onToggle, onOpenFile, onRetry, depth,
}: {
  path: string
  dirs: Record<string, DirState>
  expanded: Set<string>
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
  /** A directory that failed to load (most commonly: the root, fetched before `init` has
   * ever been called -- there is no session yet to answer `fs.tree` with) is not a dead
   * end: clicking the error retries the SAME fetch. Nothing here knows about `init`
   * events specifically (the protocol has none for it -- init is a request/reply, not a
   * broadcast), so "let the user ask again" is the general-purpose fix rather than one
   * more special case wired to session lifecycle. */
  onRetry: (path: string) => void
  depth: number
}) {
  const state = dirs[path]
  if (!state) return null
  if (state.error) {
    return (
      <div
        class="tree-error"
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
        onClick={() => onRetry(path)}
        title="click to retry"
      >
        ⚠ {state.error} (click to retry)
      </div>
    )
  }
  if (state.entries === null) {
    return state.loading ? <div class="tree-loading" style={{ paddingLeft: `${depth * 12 + 4}px` }}>loading…</div> : null
  }

  return (
    <>
      {state.entries.map((entry) => {
        const childPath = path === '' ? entry.name : `${path}/${entry.name}`
        const isExpanded = expanded.has(childPath)
        return (
          <div key={childPath}>
            <div
              class={`tree-row ${entry.dir ? 'tree-dir' : 'tree-file'}`}
              style={{ paddingLeft: `${depth * 12 + 4}px` }}
              onClick={() => (entry.dir ? onToggle(childPath) : onOpenFile(childPath))}
            >
              <span class="tree-icon">{entry.dir ? (isExpanded ? '▾' : '▸') : '·'}</span> {entry.name}
            </div>
            {entry.dir && isExpanded && (
              <DirChildren
                path={childPath} dirs={dirs} expanded={expanded} onToggle={onToggle}
                onOpenFile={onOpenFile} onRetry={onRetry} depth={depth + 1}
              />
            )}
          </div>
        )
      })}
    </>
  )
}
