import { Fragment, type VNode } from 'preact'
import type { PathTreeNode } from '../lib/path-tree'
import { Icon } from './icons'

/**
 * One level of a real path tree, in the Files panel's visual language: collapsible
 * chain-compressed directory rows (chevron, folder icon, 12px indent per level), then the
 * node's own files through the caller's renderer.
 *
 * Shared by the Changes tab and the Working tree — the two lists answer "what changed" at
 * different scales and must read as one structure. What differs between them stays outside:
 * the file row itself, and what a directory's right-hand meta says (`dirMeta`) — a change
 * count for one, a selected-of-total for the other.
 */
export function PathTreeLevel<T>({
  node, depth, collapsed, onToggle, dirMeta, renderFile,
}: {
  node: PathTreeNode<T>
  depth: number
  /** Collapsed rows by `fullDir` — stable across renders and chain compression. */
  collapsed: ReadonlySet<string>
  onToggle: (fullDir: string) => void
  dirMeta: (dir: PathTreeNode<T>) => string
  renderFile: (item: T, name: string, depth: number) => VNode
}): VNode {
  return (
    <Fragment>
      {node.dirs.map((dir) => {
        const isCollapsed = collapsed.has(dir.fullDir)
        return (
          <Fragment key={dir.fullDir}>
            <button
              class="tree-row tree-dir changes-tree-dir"
              style={{ paddingLeft: `${depth * 12 + 4}px` }}
              title={dir.fullDir}
              aria-expanded={!isCollapsed}
              onClick={() => onToggle(dir.fullDir)}
            >
              <span class="tree-chevron">{isCollapsed ? Icon.chevronRight() : Icon.chevronDown()}</span>
              <span class="tree-icon">{Icon.folder()}</span>
              <span class="tree-name">{dir.name}</span>
              <span class="changes-tree-meta">{dirMeta(dir)}</span>
            </button>
            {!isCollapsed && (
              <PathTreeLevel
                node={dir}
                depth={depth + 1}
                collapsed={collapsed}
                onToggle={onToggle}
                dirMeta={dirMeta}
                renderFile={renderFile}
              />
            )}
          </Fragment>
        )
      })}
      {node.files.map(({ item, name }) => renderFile(item, name, depth))}
    </Fragment>
  )
}

/** The standard toggle for a collapsed-set state hook: one line at every call site
 * instead of the same Set-copy dance three times. */
export function toggleInSet(prev: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(prev)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}
