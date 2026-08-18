import { useEffect, useMemo, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import type { ProtocolClient } from '../lib/client'
import type { ChangeDecor } from '../lib/path-tree'
import type { ChatItem } from '../lib/state'
import { highlight } from '../lib/highlight'
import { Icon } from '../components/icons'
import { PanelError } from '../components/panel'
import { TreePanel } from './tree'

/**
 * Files tab: the workspace tree, and — over the whole of it — whatever file you opened.
 *
 * The preview used to split the column in half, which gave a three-entry tree 40% of the
 * height and the file you actually wanted to read the other 60%, with no line numbers, no
 * wrapping and a horizontal scrollbar at the bottom of the panel. Reading code was the one
 * thing that layout was for and the one thing it was worst at. It is an overlay now: the
 * tree keeps its height, the file gets all of it, and Escape or Back returns.
 *
 * Read-only and jailed host-side (`fs.read` resolves through `Workspace.resolve` like every
 * other path the sidecar accepts), so this cannot be used to look outside the folder you
 * opened.
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
function PreviewBody({ lines, ext, wrap }: { lines: string[]; ext: string; wrap: boolean }): VNode {
  const parts = useMemo(() => highlight(lines.join('\n'), ext), [lines, ext])
  return (
    <div class="preview-scroll">
      {/* Numbers are their own unselectable column against ONE `<pre>`, so copying the code
          never picks them up. They are hidden while wrapping, and that is a real trade
          rather than an oversight: a wrapped line occupies two rows and a numbers column
          beside it would be off by one from there down — a lying gutter is worse than
          none. */}
      {!wrap && (
        <pre class="preview-nums" aria-hidden="true">
          {lines.map((_, i) => i + 1).join('\n')}
        </pre>
      )}
      <pre class={`preview-code ${wrap ? 'preview-wrap' : ''}`}><code>{parts}</code></pre>
    </div>
  )
}

/**
 * A path where the FILENAME is the part that survives.
 *
 * Plain `text-overflow: ellipsis` on a narrow panel truncates the end, which is exactly the
 * half you need: `src/components/very/deep/thing…` tells you nothing. The directory shrinks
 * and the name never does.
 */
function PathLabel({ path }: { path: string }): VNode {
  const cut = path.lastIndexOf('/')
  return (
    <span class="preview-path" title={path}>
      {cut !== -1 && <span class="preview-dir">{path.slice(0, cut + 1)}</span>}
      <span class="preview-name">{cut === -1 ? path : path.slice(cut + 1)}</span>
    </span>
  )
}

export function FilesTab({
  client, toolItems, openPath, onOpenFile, workspaceRoot, decor,
}: {
  client: ProtocolClient
  toolItems: ChatItem[]
  openPath: string | null
  onOpenFile: (path: string | null) => void
  /** Passed through to `TreePanel`, which uses it as its reset signal. */
  workspaceRoot: string
  /** Session-change badges for the unified Workspace view; absent = plain Files. */
  decor?: ChangeDecor
}): VNode {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [wrap, setWrap] = useState(false)

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

  // Escape closes the file, not the app's other Escape-bound things: this listener only
  // exists while a preview is open, so a bare Escape still stops a turn the rest of the time.
  //
  // CAPTURE phase, and that is the whole protection: the composer's abort listener is a
  // bubble-phase listener on this same window, and stopPropagation between two same-phase
  // listeners on one EventTarget does nothing — registered later, this handler ran second,
  // and Esc on a preview closed it AND silently aborted the running turn. A capture
  // listener runs before window's bubble phase, and its stopPropagation ends the walk
  // before the abort handler is reached. One Esc, one action: close the file; the next
  // Esc, with no preview open, stops the turn as before.
  useEffect(() => {
    if (preview === null) return
    function onKey(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return
      // A capture listener runs before EVERY other Escape owner, so it must yield to
      // anything more immediate than a side-panel preview: an open dialog (settings,
      // palette), a composer picker, or the run card — each of those closes itself, and
      // consuming their Esc here closed a hidden preview instead.
      if (document.querySelector('.modal-overlay, .command-picker, .run-config') !== null) return
      e.stopPropagation()
      onOpenFile(null)
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [preview, onOpenFile])

  return (
    <div class="files-tab">
      <div class="files-tree">
        <TreePanel
          client={client}
          toolItems={toolItems}
          onOpenFile={onOpenFile}
          workspaceRoot={workspaceRoot}
          decor={decor}
        />
      </div>

      {preview && (
        <div class="preview">
          <div class="preview-head">
            <button class="icon-button" onClick={() => onOpenFile(null)} title="Back to the tree (Esc)">
              {Icon.arrowLeft()}
            </button>
            <PathLabel path={preview.path} />
            {preview.kind === 'loaded' && preview.truncated && <span class="tag">truncated</span>}
            {preview.kind === 'loaded' && (
              <button
                class={`icon-button ${wrap ? 'icon-button-on' : ''}`}
                onClick={() => setWrap((w) => !w)}
                title={wrap ? 'Stop wrapping long lines' : 'Wrap long lines'}
              >
                {Icon.wrap()}
              </button>
            )}
          </div>
          {preview.kind === 'loading' && <div class="panel-placeholder">loading…</div>}
          {preview.kind === 'error' && <PanelError message={preview.message} />}
          {preview.kind === 'loaded' && (
            <PreviewBody lines={preview.lines} ext={extensionOf(preview.path)} wrap={wrap} />
          )}
        </div>
      )}
    </div>
  )
}
