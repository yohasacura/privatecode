import { useEffect, useMemo, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import type { ProtocolClient } from '../lib/client'
import type { ChatItem } from '../lib/state'
import { highlight } from '../lib/highlight'
import { Icon } from '../components/icons'
import { TreePanel } from './tree'

/**
 * Files tab: the workspace tree over the tree half, whatever file you clicked over the
 * other. The preview is read-only and jailed host-side (`fs.read` resolves through
 * `Workspace.resolve` like every other path the sidecar accepts), so this cannot be used to
 * look outside the folder you opened.
 */

type Preview =
  | { kind: 'loading'; path: string }
  | { kind: 'loaded'; path: string; lines: string[]; truncated: boolean }
  | { kind: 'error'; path: string; message: string }

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.')
  return dot === -1 ? '' : path.slice(dot + 1).toLowerCase()
}

/**
 * Split out purely so the highlight can be memoised: this was the only unmemoised
 * `highlight()` call site left, and it re-tokenised the whole previewed file into
 * thousands of objects on every streamed token — the same sustained-allocation pattern
 * that took the renderer out of memory once already.
 */
function PreviewBody({ lines, ext }: { lines: string[]; ext: string }): VNode {
  const parts = useMemo(() => highlight(lines.join('\n'), ext), [lines, ext])
  return <pre class="files-preview-body"><code>{parts}</code></pre>
}

export function FilesTab({
  client, toolItems, openPath, onOpenFile, workspaceRoot,
}: {
  client: ProtocolClient
  toolItems: ChatItem[]
  openPath: string | null
  onOpenFile: (path: string | null) => void
  /** Passed through to `TreePanel`, which uses it as its reset signal. */
  workspaceRoot: string
}): VNode {
  const [preview, setPreview] = useState<Preview | null>(null)

  useEffect(() => {
    if (openPath === null) {
      setPreview(null)
      return
    }
    setPreview({ kind: 'loading', path: openPath })
    // Two reads in flight resolve in whatever order the host answers. Without this the
    // slower one wins: the panel shows file A after you selected B, and re-selecting B
    // does nothing because `openPath` never changed.
    let cancelled = false
    client.call('fs.read', { path: openPath })
      .then((r) => {
        if (!cancelled) setPreview({ kind: 'loaded', path: openPath, lines: r.lines, truncated: r.truncated })
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setPreview({ kind: 'error', path: openPath, message: e instanceof Error ? e.message : String(e) })
        }
      })
    return () => { cancelled = true }
  }, [client, openPath])

  return (
    <div class="files-tab">
      <div class="files-tree">
        <TreePanel
          client={client}
          toolItems={toolItems}
          onOpenFile={onOpenFile}
          workspaceRoot={workspaceRoot}
        />
      </div>

      {preview && (
        <div class="files-preview">
          <div class="files-preview-head">
            <span class="files-preview-path" title={preview.path}>{preview.path}</span>
            {preview.kind === 'loaded' && preview.truncated && <span class="tag">truncated</span>}
            <button class="icon-button" onClick={() => onOpenFile(null)} title="Close preview">{Icon.x()}</button>
          </div>
          {preview.kind === 'loading' && <div class="panel-placeholder">loading…</div>}
          {preview.kind === 'error' && <div class="panel-error">{preview.message}</div>}
          {preview.kind === 'loaded' && (
            <PreviewBody lines={preview.lines} ext={extensionOf(preview.path)} />
          )}
        </div>
      )}
    </div>
  )
}
