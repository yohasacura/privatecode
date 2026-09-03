import { useCallback, useEffect, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import type { ProtocolClient } from '../lib/client'
import { PanelError } from '../components/panel'
import { CopyablePath } from '../components/settings-bits'
import { Button } from '../ui/button'
import { cn } from '../ui/cn'
import { Textarea } from '../ui/input'

/**
 * The window's own editor for one text file — a skill's SKILL.md, a script beside it, an
 * agent, a command template. The console edits these with `$EDITOR`; the window owes the
 * same without leaving it (the owner's ruling: everything the console can do, the window
 * can do). It is a textarea over `fs.read`/`fs.write`, and no more: a file too long for
 * `fs.read` (2000 lines) is handed to the OS instead of being saved back truncated.
 */
export function FileEditor({
  client, path, onClose, onSaved,
}: {
  client: ProtocolClient
  path: string
  onClose: () => void
  /** After a successful write, with the path — the caller refreshes its list. */
  onSaved?: (path: string) => void
}): VNode {
  const [text, setText] = useState<string | null>(null)
  const [saved, setSaved] = useState('')
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    client.call('fs.read', { path })
      .then((r) => {
        if (r.image !== undefined) { setError('this is an image, not a text file'); return }
        const body = r.lines.join('\n')
        setText(body)
        setSaved(body)
        setTruncated(r.truncated)
      })
      .catch((e: Error) => setError(e.message))
  }, [client, path])
  useEffect(load, [load])

  const dirty = text !== null && text !== saved

  function save(): void {
    if (text === null || truncated) return
    setSaving(true)
    setError(null)
    client.call('fs.write', { path, text })
      .then((r) => { setSaved(text); setNote(`saved, ${r.bytes} bytes`); onSaved?.(r.path) })
      .catch((e: Error) => setError(e.message))
      .finally(() => setSaving(false))
  }

  function openExternally(): void {
    client.call('fs.openExternal', { path }).catch((e: Error) => setError(e.message))
  }

  return (
    <div data-file-editor="" data-path={path} class="mt-2 rounded-md border border-border bg-panel p-2.5 font-ui">
      <div class="mb-1.5 flex items-center gap-2">
        <div class="min-w-0 flex-1"><CopyablePath path={path} /></div>
        <Button size="sm" variant="ghost" onClick={openExternally} title="Open with the program Windows uses for this file">Open externally</Button>
        <Button size="sm" variant="ghost" onClick={onClose} data-action="editor-close">Close</Button>
      </div>
      {error !== null && <PanelError message={error} onRetry={load} />}
      {truncated && (
        <PanelError message="This file is longer than the window's editor shows (2000 lines), so it is not saved from here — open it externally." />
      )}
      <Textarea
        class={cn('min-h-[260px] font-mono text-[12px] leading-[1.5]')}
        spellcheck={false}
        value={text ?? ''}
        disabled={text === null || truncated}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save() }
        }}
      />
      <div class="mt-2 flex items-center gap-2">
        <span class="min-w-0 flex-1 truncate text-[12px] text-faint" data-editor-status="" aria-live="polite">
          {dirty ? 'unsaved changes (Ctrl+S saves)' : note ?? ''}
        </span>
        <Button size="sm" variant="primary" disabled={saving || !dirty || truncated} loading={saving} onClick={save} data-action="editor-save">
          Save
        </Button>
      </div>
    </div>
  )
}
