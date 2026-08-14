/**
 * Paths, grouped the way a person reads them.
 *
 * A change list is a list of paths, and rendered flat in a 420px column that is what it
 * looks like:
 *
 *   src/small-crm-backend/SmallCrm.Application/Accounting/Handlers/CreateActHandler.cs
 *   src/small-crm-backend/SmallCrm.Application/Accounting/Handlers/VoidActHandler.cs
 *   src/small-crm-backend/SmallCrm.Domain/Invoicing/Invoice.cs
 *
 * Three lines, one readable word each, and the eye has to walk 60 characters of identical
 * prefix to find it. Grouped, the same three lines carry the same information in a shape
 * that can be scanned:
 *
 *   SmallCrm.Application/Accounting/Handlers
 *     CreateActHandler.cs
 *     VoidActHandler.cs
 *   SmallCrm.Domain/Invoicing
 *     Invoice.cs
 *
 * ONE level of grouping, deliberately, not a full nested tree. A tree of these paths is
 * six levels of indentation with one child each — the shape is honest and the reading is
 * worse, and the panel is 420px wide. What actually costs the reader is the repetition,
 * and that is what the common prefix and the directory heading remove.
 */

export interface PathGroup<T> {
  /** The directory, with the common prefix removed. `''` for files at the shared root. */
  dir: string
  /** The full directory path, for a tooltip — the short one can be ambiguous. */
  fullDir: string
  items: { item: T; name: string }[]
}

export interface GroupedPaths<T> {
  groups: PathGroup<T>[]
  /** What every path started with, removed from the headings and shown once above them. */
  commonPrefix: string
}

const dirOf = (path: string): string => {
  const at = path.lastIndexOf('/')
  return at === -1 ? '' : path.slice(0, at)
}
const nameOf = (path: string): string => {
  const at = path.lastIndexOf('/')
  return at === -1 ? path : path.slice(at + 1)
}

/** The longest run of whole leading SEGMENTS every path shares. Segment-wise, not
 * character-wise: `src/app` and `src/apple` share `src`, not `src/app`. */
export function commonPrefixOf(paths: readonly string[]): string {
  if (paths.length === 0) return ''
  const split = paths.map((p) => dirOf(p).split('/').filter((s) => s !== ''))
  const first = split[0]
  if (first === undefined) return ''
  let take = first.length
  for (const parts of split) {
    let i = 0
    while (i < take && i < parts.length && parts[i] === first[i]) i++
    take = i
    if (take === 0) break
  }
  return first.slice(0, take).join('/')
}

/**
 * Groups by directory, in path order, with the shared prefix lifted out.
 *
 * Order is the caller's within a group — a change list is newest-first and must stay that
 * way — while the groups themselves are sorted, because a directory that jumps around
 * between renders is harder to use than one that does not.
 *
 * A single group is not a grouping: when everything is in one directory there is nothing to
 * separate, so the whole path becomes the prefix and the rows are bare names under it.
 */
export function groupByDirectory<T>(
  items: readonly T[], pathOf: (item: T) => string,
): GroupedPaths<T> {
  const paths = items.map(pathOf)
  const commonPrefix = commonPrefixOf(paths)
  const cut = commonPrefix === '' ? 0 : commonPrefix.length + 1

  const byDir = new Map<string, PathGroup<T>>()
  for (const item of items) {
    const full = pathOf(item)
    const fullDir = dirOf(full)
    const dir = fullDir.slice(cut)
    const group = byDir.get(dir)
    const entry = { item, name: nameOf(full) }
    if (group === undefined) byDir.set(dir, { dir, fullDir, items: [entry] })
    else group.items.push(entry)
  }

  return {
    commonPrefix,
    groups: [...byDir.values()].sort((a, b) => a.dir.localeCompare(b.dir)),
  }
}
