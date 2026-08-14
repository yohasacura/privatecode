/**
 * How a schema and a result set are put into words.
 *
 * Shared, because the same rendering is wanted in two places that must not import each other:
 * the `database` tool, and the block injected into the prompt at session start.
 */

interface Column { name: string; type: string; nullable: boolean; identity: boolean; pk: boolean }
interface Table { name: string; columns: Column[] }

/**
 * The schema as something a person would sketch, not as a data dump.
 *
 * One line per column with keys and nullability marked inline rather than in columns of their
 * own: a ten-field table becomes ten short lines instead of a grid that costs three times as
 * much to say the same thing.
 *
 * `budget` caps the characters spent on TABLES — the part that grows without bound on a real
 * warehouse. Foreign keys and the list of views and procedures are always kept: they are
 * small, and they are the part that says how the pieces relate, which is the whole reason to
 * have a map rather than a list. What is dropped is stated as a count, because a model told
 * "here is the database" would otherwise take a truncated list as complete and conclude that
 * a table it cannot see does not exist.
 */
export function renderSchema(reply: Record<string, unknown>, budget = Infinity): string {
  const tables = Array.isArray(reply['tables']) ? reply['tables'] as Table[] : []
  const routines = Array.isArray(reply['routines']) ? reply['routines'] as { name: string; kind: string }[] : []
  const links = Array.isArray(reply['foreignKeys']) ? reply['foreignKeys'] as { from: string; to: string }[] : []

  const head = `${String(reply['database'] ?? 'database')} — ${tables.length} table${tables.length === 1 ? '' : 's'}`
  const blocks: string[] = []
  let spent = head.length
  let shown = 0
  for (const table of tables) {
    const lines = [table.name]
    for (const c of table.columns) {
      const marks = [c.pk ? 'PK' : '', c.identity ? 'identity' : '', c.nullable ? 'null' : 'not null']
        .filter((m) => m !== '')
      lines.push(`  ${c.name} ${c.type}${marks.length > 0 ? ` (${marks.join(', ')})` : ''}`)
    }
    const block = lines.join('\n')
    if (spent + block.length + 2 > budget) break
    blocks.push(block)
    spent += block.length + 2
    shown++
  }

  const out = [head, '', blocks.join('\n\n')]
  if (shown < tables.length) {
    out.push('', `(${tables.length - shown} more tables are not listed here. ` +
      'Ask `database` with action "describe" for any of them.)')
  }
  if (links.length > 0) {
    out.push('', 'references')
    for (const l of links) out.push(`  ${l.from} -> ${l.to}`)
  }
  if (routines.length > 0) {
    out.push('', 'views and procedures (use describe for the body)')
    for (const r of routines) out.push(`  ${r.name} (${r.kind})`)
  }
  return out.join('\n')
}

/**
 * Rows as a table without borders.
 *
 * Columns are padded to their widest cell so the model reads a grid rather than counting
 * separators — the same reason diff output is left aligned.
 */
export function renderRows(reply: Record<string, unknown>): string {
  const columns = Array.isArray(reply['columns']) ? reply['columns'] as string[] : []
  const rows = Array.isArray(reply['rows']) ? reply['rows'] as string[][] : []
  if (columns.length === 0) return 'the statement returned no columns'
  if (rows.length === 0) return `${columns.join(' | ')}\n(no rows)`

  const width = columns.map((c, i) =>
    Math.max(c.length, ...rows.map((r) => (r[i] ?? '').length)))
  const line = (cells: readonly string[]): string =>
    cells.map((c, i) => (c ?? '').padEnd(width[i] ?? 0)).join('  ').trimEnd()

  const out = [line(columns), width.map((w) => '-'.repeat(w)).join('  ')]
  for (const r of rows) out.push(line(r))
  const truncated = typeof reply['truncated'] === 'number' ? reply['truncated'] : null
  if (truncated !== null) {
    out.push(`(${truncated} more rows not shown — raise limit, or aggregate in the query)`)
  }
  return out.join('\n')
}
