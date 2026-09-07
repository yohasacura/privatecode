/**
 * A unified diff, cut into the pieces the line-staging controls act on.
 *
 * `git diff` prints one `diff --git` section per file, each with a header and one or more
 * `@@ -a,b +c,d @@` hunks. The file view stages, unstages and undoes ONE hunk at a time
 * (`git.hunk`), so it needs each hunk as its own text with its own `@@` line — which git
 * applies on its own, under the file's header, with `--recount`. Pure, tested without git.
 */

export interface DiffHunk {
  /** The `@@ … @@` line, with any function context git appended. */
  header: string
  /** Header plus body: exactly what `git apply` is handed. */
  text: string
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  added: number
  removed: number
}

export interface DiffFile {
  /** The `diff --git` line and everything before the first hunk. */
  header: string
  path: string
  oldPath: string
  hunks: DiffHunk[]
  binary: boolean
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

export function splitDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = []
  const lines = diff.split(/\r?\n/)
  let current: DiffFile | null = null
  let hunk: { header: string; body: string[]; meta: RegExpExecArray } | null = null

  const closeHunk = (): void => {
    if (current === null || hunk === null) return
    const m = hunk.meta
    const body = hunk.body
    let added = 0
    let removed = 0
    for (const l of body) {
      if (l.startsWith('+')) added += 1
      else if (l.startsWith('-')) removed += 1
    }
    current.hunks.push({
      header: hunk.header,
      text: [hunk.header, ...body].join('\n') + '\n',
      oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]),
      added, removed,
    })
    hunk = null
  }

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      closeHunk()
      // `diff --git a/old b/new` — quoted when a name has spaces or non-ASCII.
      const m = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(line)
      current = { header: line, path: m?.[2] ?? '', oldPath: m?.[1] ?? '', hunks: [], binary: false }
      files.push(current)
      continue
    }
    if (current === null) continue
    const h = HUNK.exec(line)
    if (h !== null) {
      closeHunk()
      hunk = { header: line, body: [], meta: h }
      continue
    }
    if (hunk !== null) {
      // The body runs until the next hunk or file; a trailing empty line is the split's.
      if (line === '' ) continue
      hunk.body.push(line)
      continue
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) current.binary = true
    if (line.startsWith('+++ ')) {
      const p = /^\+\+\+ (?:"?b\/(.+?)"?|\/dev\/null)$/.exec(line)
      if (p?.[1] !== undefined) current.path = p[1]
    }
    if (line.startsWith('--- ')) {
      const p = /^--- (?:"?a\/(.+?)"?|\/dev\/null)$/.exec(line)
      if (p?.[1] !== undefined) current.oldPath = p[1]
    }
    current.header += `\n${line}`
  }
  closeHunk()
  return files
}

/** Every hunk of the one file a single-path diff describes, or none for a binary. */
export function hunksOf(diff: string): DiffHunk[] {
  return splitDiff(diff).flatMap((f) => f.hunks)
}
