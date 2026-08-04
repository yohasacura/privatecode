import { useCallback, useEffect, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import type { GitFileChange } from '@core/host/protocol'
import type { ProtocolClient } from '../lib/client'
import { DiffView } from '../lib/diff'
import { Icon } from '../components/icons'
import { PanelError, PanelRow, PanelSection } from '../components/panel'

/**
 * The working tree, under this session's own changes.
 *
 * They answer the same question at two scales and belong in one tab: "what has changed" is
 * either "what did the agent just do" or "what is uncommitted", and having to go looking in
 * a different place for the second is how you end up committing the first without reading
 * it. This section also covers what the Changes list structurally cannot — your own edits,
 * and anything left over from before the session started.
 *
 * Committing is a button here and not a tool the model has. A commit is where work becomes
 * permanent, and that is a person's decision, made over a message they can read and change.
 */

const LABELS: Record<string, string> = {
  '??': 'new', 'A ': 'added', 'M ': 'staged', ' M': 'modified', 'MM': 'staged + modified',
  'D ': 'deleted', ' D': 'deleted', 'R ': 'renamed', 'AM': 'added + modified',
}

function label(file: GitFileChange): string {
  return LABELS[file.code] ?? file.code.trim()
}

function FileRow({
  client, file, checked, onToggle,
}: {
  client: ProtocolClient
  file: GitFileChange
  checked: boolean
  onToggle: () => void
}): VNode {
  const [open, setOpen] = useState(false)
  const [diff, setDiff] = useState<string | null>(null)

  useEffect(() => {
    if (!open || diff !== null) return
    client.call('git.diff', { path: file.path, untracked: file.untracked })
      .then((r) => setDiff(r.diff))
      .catch((e: Error) => setDiff(`could not read the diff: ${e.message}`))
  }, [client, open, diff, file.path, file.untracked])

  return (
    <PanelRow
      open={open}
      onToggle={() => setOpen((o) => !o)}
      icon={
        <input
          type="checkbox"
          class="tree-check"
          checked={checked}
          onClick={(e) => e.stopPropagation()}
          onChange={onToggle}
          title="Include this file in the commit"
        />
      }
      label={file.path}
      mono
      title={file.path}
      meta={label(file)}
    >
      {diff === null ? <div class="panel-placeholder">loading…</div> : <DiffView content={diff} dense />}
    </PanelRow>
  )
}

export function WorkingTree({ client, reloadKey }: { client: ProtocolClient; reloadKey: number }): VNode | null {
  const [files, setFiles] = useState<GitFileChange[]>([])
  const [branch, setBranch] = useState<string | null>(null)
  const [isRepo, setIsRepo] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [message, setMessage] = useState('')
  const [suggestion, setSuggestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [committed, setCommitted] = useState<string | null>(null)

  const load = useCallback(() => {
    client.call('git.status', {})
      .then((r) => {
        setIsRepo(r.isRepo)
        setBranch(r.branch)
        setFiles(r.files)
        setSuggestion(r.suggestion)
        // Selection follows the tree: a path that is no longer dirty must not stay ticked
        // and end up in the next `git add`.
        setSelected((prev) => new Set(r.files.map((f) => f.path).filter((p) => prev.has(p))))
        setError(r.problem !== undefined && r.isRepo ? r.problem : null)
      })
      .catch((e: Error) => setError(e.message))
  }, [client])

  useEffect(() => { load() }, [load, reloadKey])

  // Not a repository is not a failure and not a thing to explain every time: most
  // workspaces are, some are not, and the tab still has this session's changes to show.
  if (!isRepo) return null

  function toggle(path: string): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  function commit(): void {
    const paths = [...selected]
    setBusy(true)
    setError(null)
    client.call('git.commit', { message: message.trim() || suggestion, paths })
      .then((r) => {
        if (r.ok) {
          setCommitted(r.sha ?? 'committed')
          setMessage('')
          setSelected(new Set())
          load()
        } else {
          setError(r.problem ?? 'the commit did not happen')
        }
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false))
  }

  return (
    <PanelSection title={branch !== null ? `Working tree · ${branch}` : 'Working tree'} count={files.length}>
      {error !== null && <PanelError message={error} onRetry={load} />}
      {committed !== null && files.length === 0 && (
        <div class="history-note">Committed as <code>{committed}</code>. Nothing else is uncommitted.</div>
      )}

      {files.length === 0
        ? <PanelRow icon={Icon.check()} label="Nothing uncommitted" />
        : (
          <>
            {files.map((file) => (
              <FileRow
                key={file.path}
                client={client}
                file={file}
                checked={selected.has(file.path)}
                onToggle={() => toggle(file.path)}
              />
            ))}
            <div class="commit-box">
              <input
                class="input"
                value={message}
                placeholder={suggestion || 'commit message'}
                onInput={(e) => setMessage(e.currentTarget.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && selected.size > 0) commit() }}
              />
              <button
                class="btn btn-primary"
                disabled={busy || selected.size === 0}
                onClick={commit}
                title={selected.size === 0 ? 'Tick the files to commit' : `Commit ${selected.size} file(s)`}
              >
                {busy ? 'Committing…' : `Commit ${selected.size || ''}`.trim()}
              </button>
            </div>
          </>
          )}
    </PanelSection>
  )
}
