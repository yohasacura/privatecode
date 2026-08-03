import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `<workspaceRoot>/.privatecode/` — everything this tool keeps inside someone else's
 * project: session transcripts, overflow logs from oversized command output.
 *
 * It ignores ITSELF. A tool that quietly accumulates files in your repository and then
 * lets them turn up in `git status` — or worse, in a commit — has made your working tree
 * its problem. Writing `.gitignore` with `*` inside the directory means nothing has to be
 * added to the project's own ignore file, nothing needs the user's cooperation, and the
 * rule travels with the directory if it is copied elsewhere.
 */
export const PRIVATE_DIR = '.privatecode'

/** `*` ignores every file here including the ignore file itself, which is what we want:
 * this directory is entirely ours and none of it belongs in anyone's history. */
const IGNORE_BODY = '# Created by PrivateCode. Everything in here is local state.\n*\n'

/**
 * Creates `<root>/.privatecode/<sub>` (and the parent) and makes sure the self-ignore is
 * in place. Safe to call repeatedly; the ignore file is written once and never rewritten,
 * so a user who deliberately edits it keeps their edit.
 */
export function ensurePrivateDir(workspaceRoot: string, sub?: string): string {
  const base = join(workspaceRoot, PRIVATE_DIR)
  const target = sub === undefined ? base : join(base, sub)
  mkdirSync(target, { recursive: true })
  const ignore = join(base, '.gitignore')
  // Best-effort: a read-only or otherwise hostile workspace must not turn "save a session"
  // into a failure just because the courtesy file could not be written.
  try {
    if (!existsSync(ignore)) writeFileSync(ignore, IGNORE_BODY, 'utf8')
  } catch { /* the directory itself is what mattered */ }
  return target
}
