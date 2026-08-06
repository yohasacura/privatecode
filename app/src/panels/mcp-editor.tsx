import { useCallback, useEffect, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import type { McpServerView } from '@core/host/protocol'
import type { ProtocolClient } from '../lib/client'
import { PanelEmpty, PanelError, PanelRow } from '../components/panel'
import { Icon } from '../components/icons'

/**
 * Configuring MCP servers from the window.
 *
 * Before this, MCP existed in the interface only as a read-only status list that hid itself
 * entirely when no servers were configured — so for anyone who had not already hand-written
 * the JSON, the feature was invisible. There was no way to learn it existed, let alone add
 * a server.
 *
 * The editor manages the PROJECT settings file. Entries defined in the user or local file
 * are shown with their source and left read-only here rather than hidden: a merged list
 * that omitted them would misstate what the agent can reach. Saving re-opens the workspace
 * (the same `connect()` the Folders manager already triggers) because connections and the
 * system prompt that names the servers are built at init — an edit that silently applied
 * to neither would be the permissions screen's revoke hole all over again.
 */
export function McpEditor({
  client, onApply,
}: {
  client: ProtocolClient
  /** Re-opens the workspace so the edit actually connects. The caller owns HOW (it is the
   * modal's own connect()), this component only says WHEN. */
  onApply: () => void
}): VNode {
  const [servers, setServers] = useState<McpServerView[] | null>(null)
  const [problems, setProblems] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  /** The add form. `target` is one field for both kinds: a URL is recognised by its
   * scheme, anything else is a command line (first token command, rest args). */
  const [name, setName] = useState('')
  const [target, setTarget] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    setError(null)
    client.call('mcp.read', {})
      .then((r) => { setServers(r.servers); setProblems(r.problems) })
      .catch((e: Error) => setError(e.message))
  }, [client])
  useEffect(load, [load])

  function save(params: { upsert?: { name: string; command?: string; args?: string[]; url?: string }[]; remove?: string[] }): void {
    setSaving(true)
    setError(null)
    client.call('mcp.save', params)
      .then(() => {
        setName('')
        setTarget('')
        load()
        // The file changed; the connections and the prompt have not. Re-opening the
        // workspace is what makes the two agree, and it is one call the modal already has.
        onApply()
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setSaving(false))
  }

  function add(): void {
    const trimmedName = name.trim()
    const trimmedTarget = target.trim()
    if (trimmedName === '' || trimmedTarget === '') return
    if (/^https?:\/\//i.test(trimmedTarget)) {
      save({ upsert: [{ name: trimmedName, url: trimmedTarget }] })
      return
    }
    const [command, ...args] = trimmedTarget.split(/\s+/)
    save({ upsert: [{ name: trimmedName, command: command!, ...(args.length > 0 ? { args } : {}) }] })
  }

  const editable = (s: McpServerView): boolean => s.source === 'project settings'

  return (
    <div class="mcp-editor">
      {problems.map((p) => <PanelError key={p} message={p} />)}
      {error !== null && <PanelError message={error} onRetry={load} />}

      {servers !== null && servers.length === 0 && (
        <PanelEmpty
          icon={Icon.jobs()}
          title="No MCP servers configured"
          hint="An MCP server adds its tools to the agent — a database, a docs index, a browser. Add one below; its tools ask for approval like everything else."
        />
      )}

      {(servers ?? []).map((s) => (
        <PanelRow
          key={s.name}
          mono
          label={s.name}
          title={s.kind === 'stdio' ? `${s.command ?? ''} ${(s.args ?? []).join(' ')}`.trim() : s.url ?? ''}
          meta={
            <span class="mcp-editor-target" title={s.kind === 'stdio' ? undefined : s.url}>
              {s.kind === 'stdio' ? `${s.command ?? ''} ${(s.args ?? []).join(' ')}`.trim() : s.url}
            </span>
          }
          actions={editable(s)
            ? (
              <button
                class="btn btn-small"
                disabled={saving}
                onClick={() => save({ remove: [s.name] })}
                title="Remove this server from the project settings"
              >
                Remove
              </button>
              )
            : <span class="mcp-editor-source" title={`Defined in ${s.source}; edit that file to change it`}>{s.source}</span>}
        />
      ))}

      <div class="field-label">Add a server</div>
      <div class="mcp-editor-form">
        <input
          class="input input-small mcp-editor-name"
          placeholder="name"
          value={name}
          onInput={(e) => setName(e.currentTarget.value)}
        />
        <input
          class="input input-small"
          placeholder="command with args, or an https:// URL"
          value={target}
          onInput={(e) => setTarget(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add() }}
        />
        <button
          class="btn btn-small"
          disabled={saving || name.trim() === '' || target.trim() === ''}
          onClick={add}
        >
          {saving ? 'Saving…' : 'Add'}
        </button>
      </div>
      <div class="field-hint">
        Saved to this project's .privatecode/settings.json, then the workspace re-opens to
        connect it. Extra fields you add by hand there (env, headers, cwd) survive edits made
        here.
      </div>
    </div>
  )
}
