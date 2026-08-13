import { useCallback, useEffect, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import type { GitFileChange, GitRepoView } from '@core/host/protocol'
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

/**
 * One repository, with its own selection and its own commit box.
 *
 * Per repository rather than one box for the panel, because a commit belongs to exactly one
 * repository: a single message over files from two of them describes neither, and the host
 * refuses it anyway. Separate boxes make that a shape you can see instead of an error you
 * discover.
 */
function RepoSection({
  client, repo, alone, onCommitted,
}: {
  client: ProtocolClient
  repo: GitRepoView
  /** The only repository in the workspace — then it keeps the panel's original wording. */
  alone: boolean
  onCommitted: () => void
}): VNode {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Selection follows the tree: a path that is no longer dirty must not stay ticked and end
  // up in the next `git add`.
  useEffect(() => {
    setSelected((prev) => new Set(repo.files.map((f) => f.path).filter((p) => prev.has(p))))
  }, [repo.files])

  function toggle(path: string): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  function commit(): void {
    setBusy(true)
    setError(null)
    client.call('git.commit', { message: message.trim() || repo.suggestion, paths: [...selected] })
      .then((r) => {
        if (r.ok) {
          setMessage('')
          setSelected(new Set())
          onCommitted()
        } else {
          setError(r.problem ?? 'the commit did not happen')
        }
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false))
  }

  const branch = repo.branch !== null ? ` · ${repo.branch}` : ''
  return (
    <PanelSection title={alone ? `Working tree${branch}` : `${repo.label}${branch}`} count={repo.files.length}>
      {repo.problem !== undefined && <div class="history-note">{repo.problem}</div>}
      {error !== null && <PanelError message={error} />}
      {repo.files.length === 0
        ? <PanelRow icon={Icon.check()} label="Nothing uncommitted" />
        : (
          <>
            {/*
              The selection, stated. The per-file checkbox sits in the row's ICON slot, which
              in every other list in this column holds a decorative mark — so the column reads
              as decoration, and the one thing standing between a typed message and a commit
              was invisible. This line names the count, and is where "all of them" lives.
            */}
            <div class="commit-selection">
              <input
                type="checkbox"
                class="tree-check"
                checked={selected.size === repo.files.length}
                onChange={() => setSelected(
                  selected.size === repo.files.length
                    ? new Set()
                    : new Set(repo.files.map((f) => f.path)),
                )}
                title={selected.size === repo.files.length ? 'Clear the selection' : 'Select every file'}
              />
              <span>
                {selected.size} of {repo.files.length} selected
              </span>
            </div>
            {repo.files.map((file) => (
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
                placeholder={repo.suggestion || 'commit message'}
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
            {/*
              Why the button is dead, on screen rather than in a tooltip. It USED to say this
              only in `title` — on the disabled button itself, which is both the last place
              anyone looks and an element whose tooltip a browser may decline to show at all.
              So typing a message and finding the button still grey had no explanation
              anywhere, which is exactly how it was reported.
            */}
            {selected.size === 0 && !busy && (
              <div class="commit-blocked">
                Tick the files to include — a commit takes what you selected, never the whole
                tree.{' '}
                <button
                  class="link-button"
                  onClick={() => setSelected(new Set(repo.files.map((f) => f.path)))}
                >
                  Select all {repo.files.length}
                </button>
              </div>
            )}
          </>
          )}
    </PanelSection>
  )
}

export function WorkingTree({ client, reloadKey }: { client: ProtocolClient; reloadKey: number }): VNode | null {
  const [repos, setRepos] = useState<GitRepoView[]>([])
  const [unversioned, setUnversioned] = useState<{ mount: string }[]>([])
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    client.call('git.status', {})
      .then((r) => {
        setRepos(r.repos)
        setUnversioned(r.unversioned)
        setError(r.problem ?? null)
      })
      .catch((e: Error) => setError(e.message))
  }, [client])

  useEffect(() => { load() }, [load, reloadKey])

  // Nothing under version control anywhere is not a failure and not a thing to explain
  // every time: the tab still has this session's own changes to show.
  if (error === null && repos.length === 0) return null

  return (
    <>
      {error !== null && <PanelError message={error} onRetry={load} />}
      {repos.map((repo) => (
        <RepoSection
          key={repo.root}
          client={client}
          repo={repo}
          alone={repos.length === 1 && unversioned.length === 0}
          onCommitted={load}
        />
      ))}
      {unversioned.length > 0 && repos.length > 0 && (
        <div class="history-note">
          Not under version control: {unversioned.map((u) => u.mount).join(', ')}. Checkpoints
          still cover {unversioned.length === 1 ? 'it' : 'them'}; there is simply nothing to commit.
        </div>
      )}
    </>
  )
}
