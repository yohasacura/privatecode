import { useCallback, useEffect, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import type { WorkspaceFolderView } from '@core/host/protocol'
import type { ProtocolClient } from '../lib/client'
import { Icon } from '../components/icons'
import { PanelError } from '../components/panel'

/**
 * The folders this workspace is made of.
 *
 * Two things are worth showing per folder and neither is obvious from a path: whether the
 * agent may WRITE there, and what git thinks the folder is. The second is the one that
 * surprises people — "part of monorepo" means the panel is showing you a slice of something
 * bigger, and a folder with repositories inside it is several projects wearing one name.
 *
 * Changing the list re-opens the workspace rather than patching it: the jail, the project
 * map, the undo units and the file index are all derived from these folders, and a
 * half-updated workspace is exactly the state in which a write lands somewhere nobody meant.
 */

interface Draft {
  path: string
  name: string
  access: 'write' | 'read'
  primary: boolean
  git: string
}

function toDraft(folder: WorkspaceFolderView): Draft {
  return {
    path: folder.root,
    name: folder.name,
    access: folder.access,
    primary: folder.primary,
    git: folder.git,
  }
}

export function Folders({
  client, isDevBridge, onChanged,
}: {
  client: ProtocolClient
  /** The native folder picker is a Tauri plugin; the dev bridge runs in a plain browser. */
  isDevBridge: boolean
  /** Called after the definition is saved, so the caller can re-open the workspace. */
  onChanged: () => void
}): VNode {
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [name, setName] = useState('')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [typedPath, setTypedPath] = useState('')

  const load = useCallback(() => {
    client.call('workspace.get', {})
      .then((r) => {
        setDrafts(r.folders.map(toDraft))
        setName(r.name)
        setDirty(false)
        setError(r.problems[0] ?? null)
      })
      .catch((e: Error) => setError(e.message))
  }, [client])

  useEffect(() => { load() }, [load])

  function add(path: string): void {
    const trimmed = path.trim()
    if (trimmed === '') return
    if (drafts.some((d) => d.path.toLowerCase() === trimmed.toLowerCase())) {
      setError('that folder is already in this workspace')
      return
    }
    setDrafts((prev) => [...prev, {
      path: trimmed,
      name: '',
      access: 'write',
      primary: false,
      git: 'checked when the workspace re-opens',
    }])
    setTypedPath('')
    setError(null)
    setDirty(true)
  }

  async function pick(): Promise<void> {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const result = await open({ directory: true, multiple: false })
    if (typeof result === 'string') add(result)
  }

  function update(index: number, patch: Partial<Draft>): void {
    setDrafts((prev) => prev.map((d, i) => (i === index ? { ...d, ...patch } : d)))
    setDirty(true)
  }

  function remove(index: number): void {
    setDrafts((prev) => prev.filter((_, i) => i !== index))
    setDirty(true)
  }

  function save(): void {
    setBusy(true)
    setError(null)
    client.call('workspace.set', {
      name: name.trim(),
      folders: drafts.filter((d) => !d.primary).map((d) => ({
        path: d.path,
        ...(d.name.trim() !== '' ? { name: d.name.trim() } : {}),
        access: d.access,
      })),
    })
      .then(() => { setDirty(false); onChanged() })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false))
  }

  return (
    <div class="folders">
      <label class="field-label" for="ws-name">Workspace name</label>
      <input
        id="ws-name"
        class="input"
        value={name}
        placeholder="what to call this combination"
        onInput={(e) => { setName(e.currentTarget.value); setDirty(true) }}
      />

      {error !== null && <PanelError message={error} />}

      <div class="folder-list">
        {drafts.map((folder, i) => (
          <div class="folder-row" key={folder.path}>
            <span class="folder-icon">{Icon.folder()}</span>
            <div class="folder-main">
              <input
                class="input folder-name"
                value={folder.name}
                placeholder={folder.primary ? 'main folder' : 'name the agent uses'}
                disabled={folder.primary}
                onInput={(e) => update(i, { name: e.currentTarget.value })}
                title="Every path the agent writes starts with this name"
              />
              <span class="folder-path" title={folder.path}>{folder.path}</span>
              <span class="folder-git">{folder.git}</span>
            </div>
            {folder.primary
              ? <span class="tag">main</span>
              : (
                <>
                  <button
                    class={`btn btn-small ${folder.access === 'read' ? 'btn-primary' : ''}`}
                    onClick={() => update(i, { access: folder.access === 'read' ? 'write' : 'read' })}
                    title={folder.access === 'read'
                      ? 'Read-only: the agent can read and search here, and cannot write'
                      : 'Writable: the agent may edit files here'}
                  >
                    {folder.access === 'read' ? 'read-only' : 'writable'}
                  </button>
                  <button class="btn btn-small btn-danger" onClick={() => remove(i)}>Remove</button>
                </>
                )}
          </div>
        ))}
      </div>

      <div class="folder-add">
        {isDevBridge
          ? (
            <input
              class="input"
              value={typedPath}
              placeholder="paste a folder path and press Enter"
              onInput={(e) => setTypedPath(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') add(typedPath) }}
            />
            )
          : <button class="btn" onClick={pick}>Add folder…</button>}
        <button class="btn btn-primary" disabled={!dirty || busy} onClick={save}>
          {busy ? 'Saving…' : 'Save and re-open'}
        </button>
      </div>

      <p class="folder-note">
        The main folder holds this workspace's sessions, checkpoints and settings — only its
        settings are read, so an attached project cannot reconfigure the agent. A read-only
        folder is refused by the workspace itself, not by a rule, so nothing can grant a write
        to it.
      </p>
    </div>
  )
}
