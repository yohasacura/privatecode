import { useCallback, useEffect, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import type { ProtocolClient } from '../lib/client'
import { PanelError } from '../components/panel'
import { CopyablePath, SettingHint, SettingLabel } from '../components/settings-bits'
import { Button } from '../ui/button'
import { cn } from '../ui/cn'
import { Textarea } from '../ui/input'

/**
 * MCP configuration, VS Code's way: the JSON document itself, editable in place.
 *
 * This replaced a name-plus-command form at the user's request, and the request was right.
 * A form models a subset — env blocks, headers, cwd and trust flags all needed "edit the
 * file by hand anyway" — while the JSON IS the configuration, so an editor over it can
 * express everything the loader can read, including entries the form's author never
 * anticipated. The window's job shrinks to what it can do honestly: syntax-check before
 * writing, preserve the rest of the settings file, and reconnect.
 *
 * Deeper validation (a server with neither command nor url) is deliberately left to the
 * connect that follows — the same problems pipeline every hand edit has always used, shown
 * in the status list above this editor. It is legal to save a half-written entry.
 */

const PLACEHOLDER = `{
  "docs": { "command": "node", "args": ["docs-server.js"] },
  "search": { "url": "https://mcp.example.com/sse" }
}`

export function McpEditor({
  client, onApply,
}: {
  client: ProtocolClient
  /** Re-opens the workspace so the edit actually connects; the dialog's own connect(). */
  onApply: () => void
}): VNode {
  const [text, setText] = useState<string | null>(null)
  const [path, setPath] = useState('')
  const [saved, setSaved] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    setError(null)
    client.call('mcp.rawRead', {})
      .then((r) => { setText(r.json); setSaved(r.json); setPath(r.path) })
      .catch((e: Error) => setError(e.message))
  }, [client])
  useEffect(load, [load])

  /** Parse locally on every keystroke, so the Save button can say WHY it is disabled
   * before anything is sent — the same check the host repeats before writing. */
  const syntaxProblem = ((): string | null => {
    if (text === null) return null
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return 'the root must be an object: { "server-name": { … } }'
      }
      return null
    } catch (e) {
      return (e as Error).message
    }
  })()
  const dirty = text !== null && text !== saved
  const bad = syntaxProblem !== null && dirty

  function save(): void {
    if (text === null || syntaxProblem !== null) return
    setSaving(true)
    setError(null)
    client.call('mcp.rawSave', { json: text })
      .then(() => {
        setSaved(text)
        // The file changed; the connections and the prompt naming the servers have not.
        // Re-opening the workspace is what makes them agree.
        onApply()
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setSaving(false))
  }

  return (
    <div data-mcp-editor="" class="font-ui">
      {error !== null && <PanelError message={error} onRetry={load} />}

      <SettingLabel htmlFor="mcp-json">"mcpServers"</SettingLabel>
      {path !== '' && <div class="mb-1.5"><CopyablePath path={path} /></div>}
      <Textarea
        id="mcp-json"
        class={cn('min-h-[180px] font-mono text-[12px] leading-[1.5]', bad && 'border-red')}
        invalid={bad}
        spellcheck={false}
        value={text ?? ''}
        placeholder={PLACEHOLDER}
        disabled={text === null}
        onInput={(e) => setText(e.currentTarget.value)}
      />
      <div class="mt-2 flex items-center gap-2">
        <span class={cn('min-w-0 flex-1 truncate text-[12px]', bad ? 'text-red' : 'text-faint')} data-mcp-status="" aria-live="polite">
          {bad
            ? syntaxProblem
            : dirty
            ? 'unsaved changes'
            : text === '{}'
            ? 'no servers configured — the placeholder above is the shape'
            : ''}
        </span>
        <Button
          size="sm"
          variant="primary"
          disabled={saving || !dirty || syntaxProblem !== null}
          loading={saving}
          onClick={save}
          title="Write the file, then re-open the workspace so the servers connect"
        >
          Save &amp; reconnect
        </Button>
      </div>
      <SettingHint>
        Each entry is a server: <code>{'{ "command": "...", "args": [...] }'}</code> for a
        local one, <code>{'{ "url": "https://..." }'}</code> for a remote one. Optional:
        <code>env</code>, <code>cwd</code>, <code>headers</code>,
        <code>trustReadOnlyHints</code>. Whether each server connected is shown above.
      </SettingHint>
    </div>
  )
}
