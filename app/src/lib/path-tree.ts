/**
 * Paths, as the real nested tree the Changes tab and the Working tree render.
 *
 * A change list is a list of paths, and rendered flat in a 420px column the eye has to
 * walk 60 characters of identical prefix per row to find the one readable word. The tree
 * removes the repetition the way file explorers do, and the "six levels of indentation
 * with one child each" objection is answered the same way they answer it: a directory
 * whose only content is one subdirectory is COMPRESSED into its child (`src/models` is
 * one row, not two), so depth on screen is only ever spent where the tree branches.
 *
 * (An earlier one-level `groupByDirectory` lived here and is gone: both of its callers
 * render the tree now, and a grouping nobody renders is a shape waiting to drift.)
 */

export interface PathTreeNode<T> {
  /** One segment, or a compressed single-child chain rendered as one row: `src/models`. */
  name: string
  /** The full directory path this node stands for (the DEEP end of a compressed chain) —
   * stable across renders, so it is the collapse-state key and the tooltip. */
  fullDir: string
  /** Subdirectories, sorted by name so they do not jump between renders. */
  dirs: PathTreeNode<T>[]
  /** Files directly here, in the CALLER's order — a change list is newest-first. */
  files: { item: T; name: string }[]
  /** Files here and in every subdirectory, for the "N files" meta on a collapsed row. */
  totalFiles: number
}

/** What the unified Workspace tree overlays on the plain FS listing: per changed FILE its
 * diff shape, per DIRECTORY how many changed files live anywhere under it — so a collapsed
 * folder still says the session touched things inside. */
export interface ChangeDecor {
  files: Map<string, { added: number; removed: number; revisions: number; lastFailed: boolean }>
  dirs: Map<string, number>
}

export function decorateChanges(
  changes: readonly { openPath: string; revisions: number; lastFailed?: boolean; stat: { added: number; removed: number } | null }[],
): ChangeDecor {
  const files = new Map<string, { added: number; removed: number; revisions: number; lastFailed: boolean }>()
  const dirs = new Map<string, number>()
  for (const c of changes) {
    files.set(c.openPath, {
      added: c.stat?.added ?? 0,
      removed: c.stat?.removed ?? 0,
      revisions: c.revisions,
      lastFailed: c.lastFailed === true,
    })
    const segments = c.openPath.split('/').slice(0, -1)
    let dir = ''
    for (const segment of segments) {
      dir = dir === '' ? segment : `${dir}/${segment}`
      dirs.set(dir, (dirs.get(dir) ?? 0) + 1)
    }
  }
  return { files, dirs }
}

/** The nested tree of `items` by path, single-child chains compressed. The returned node
 * is the invisible root: render its `dirs` and `files`, never the node itself. */
export function buildPathTree<T>(
  items: readonly T[], pathOf: (item: T) => string,
): PathTreeNode<T> {
  interface Raw { name: string; fullDir: string; dirs: Map<string, Raw>; files: { item: T; name: string }[] }
  const root: Raw = { name: '', fullDir: '', dirs: new Map(), files: [] }

  for (const item of items) {
    const full = pathOf(item)
    const segments = full.split('/').filter((s) => s !== '')
    const name = segments.pop() ?? full
    let node = root
    for (const segment of segments) {
      const fullDir = node.fullDir === '' ? segment : `${node.fullDir}/${segment}`
      let next = node.dirs.get(segment)
      if (next === undefined) {
        next = { name: segment, fullDir, dirs: new Map(), files: [] }
        node.dirs.set(segment, next)
      }
      node = next
    }
    node.files.push({ item, name })
  }

  const finish = (raw: Raw): PathTreeNode<T> => {
    // Chain compression: while this directory holds nothing but one subdirectory, fold
    // the child into it — the row reads `a/b/c`, the identity is the deep end's.
    let name = raw.name
    let cursor = raw
    while (cursor.files.length === 0 && cursor.dirs.size === 1) {
      const child = [...cursor.dirs.values()][0]!
      name = `${name}/${child.name}`
      cursor = child
    }
    const dirs = [...cursor.dirs.values()].map(finish).sort((a, b) => a.name.localeCompare(b.name))
    const totalFiles = cursor.files.length + dirs.reduce((n, d) => n + d.totalFiles, 0)
    return { name, fullDir: cursor.fullDir, dirs, files: cursor.files, totalFiles }
  }

  const dirs = [...root.dirs.values()].map(finish).sort((a, b) => a.name.localeCompare(b.name))
  return {
    name: '',
    fullDir: '',
    dirs,
    files: root.files,
    totalFiles: root.files.length + dirs.reduce((n, d) => n + d.totalFiles, 0),
  }
}
