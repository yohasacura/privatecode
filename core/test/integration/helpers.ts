import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every file in the tree, by path and by bytes.
 *
 * Plan mode used to be checked by comparing one file's contents before and after. That
 * cannot see the escape a real plan-mode failure actually produces — a file the agent
 * *created* — and "no editing tools are available to you at all" is a promise about the
 * whole workspace, which is the acceptance criterion. The listing is returned alongside
 * the hash so a failure names the file instead of printing two hex strings.
 *
 * Shared between real-model.test.ts and plan2.test.ts (Task 12) rather than duplicated:
 * both need to prove a plan-mode turn touched nothing, and a second, drifted copy of this
 * walk would be worse than one shared one.
 */
export function snapshotTree(dir: string): { files: string[]; hash: string } {
  const files: string[] = []
  const h = createHash('sha256')
  const walk = (current: string, prefix: string): void => {
    const entries = readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const rel = prefix + entry.name
      if (entry.isDirectory()) {
        files.push(`${rel}/`)
        h.update(`D ${rel}\n`)
        walk(join(current, entry.name), `${rel}/`)
      } else {
        files.push(rel)
        h.update(`F ${rel} `)
        h.update(readFileSync(join(current, entry.name)))
        h.update('\n')
      }
    }
  }
  walk(dir, '')
  return { files, hash: h.digest('hex') }
}
