import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `<workspaceRoot>/.privatecode/` — this tool's folder inside someone else's project.
 *
 * It holds two kinds of thing and they are NOT alike:
 *
 *   .privatecode/
 *     settings.json          <- yours
 *     settings.local.json    <- yours, not shared
 *     skills/                <- yours
 *     commands/              <- yours
 *     checkpoints.exclude    <- yours (what a checkpoint must not swallow)
 *     workspace.json         <- yours (which folders this workspace is made of)
 *     state/                 <- OURS. Sessions, logs, the worklog, the checkpoint stores.
 *
 * The split exists because the flat version failed a user out loud: opening `.privatecode`
 * in a real project showed a 276-file git directory, 33 session files, logs and a worklog —
 * and not one file they had written, since the folder they were being invited to put their
 * instructions in was entirely machine state. "I as a user do not want to see this."
 *
 * `state/` is one directory precisely so it can be ignored in one glance and one gitignore
 * line. Nothing in it is meant to be read, edited, or reasoned about by a person.
 *
 * The split is about READABILITY, not about git. The self-ignore stays `*`: this directory
 * is ours end to end, and a tool that lets its files turn up in someone's `git status` — or
 * worse, in a commit — has made their working tree its problem. The user's own settings and
 * skills living here are still theirs to read and edit; they simply do not travel with the
 * repository, which is the behaviour asked for.
 */
export const PRIVATE_DIR = '.privatecode'

/** Everything the tool writes for itself. See the layout above. */
export const STATE_DIR = 'state'

/**
 * `*` — everything here, including this file.
 *
 * The `state/` split is about READABILITY, not about git. It was briefly narrowed to ignore
 * only `state/`, on the reasoning that a project's own skills and settings should be able to
 * travel with the repository; the user's answer was that none of this folder belongs in
 * their history, and that is the call. So the whole directory stays out, and what lives at
 * the top level is theirs to read and edit on this machine rather than theirs to commit.
 */
const IGNORE_BODY = '# Created by PrivateCode. Everything in here is local state.\n*\n'

/**
 * Creates `<root>/.privatecode/<sub>` (and the parent) and makes sure the self-ignore is in
 * place. Safe to call repeatedly; the ignore file is written once and never rewritten, so a
 * user who deliberately edits it keeps their edit.
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

/** `<root>/.privatecode/state/<sub>` — created, with the parent and the ignore file. */
export function ensureStateDir(workspaceRoot: string, sub?: string): string {
  return ensurePrivateDir(workspaceRoot, sub === undefined ? STATE_DIR : join(STATE_DIR, sub))
}

/** The path of a state entry. Does NOT create anything — for readers and for `join` sites. */
export function statePath(workspaceRoot: string, ...parts: string[]): string {
  return join(workspaceRoot, PRIVATE_DIR, STATE_DIR, ...parts)
}

/** What moved into `state/`, by its old name directly under `.privatecode/`. */
const MOVED = [
  'sessions', 'logs', 'worklog.md', 'checkpoints.git', 'checkpoints', 'decisions.jsonl',
  'browser',
]

/**
 * Moves a pre-split workspace's machine state into `state/`. Never throws.
 *
 * Call ONCE, before anything opens a session store or a checkpoint store — a rename under a
 * process that already holds those paths is how a migration eats someone's history.
 *
 * Each entry is moved only when the source exists and the destination does not, so this is
 * idempotent and cannot overwrite a newer directory with an older one. A rename that fails
 * (a file held open, a permission) leaves BOTH the old path and the tool working exactly as
 * before — the callers below still resolve through `statePath`, so a half-migrated workspace
 * is a workspace with a stale leftover folder, never a broken one.
 *
 * `checkpoints.exclude` deliberately does NOT move: it is a file the user edits, its path is
 * baked into each checkpoint store's `core.excludesFile`, and moving it would silently
 * disable every exclusion — which is the "a checkpoint swallowed my build output" failure,
 * returning without a symptom.
 */
export function migratePrivateDir(workspaceRoot: string): string[] {
  const problems: string[] = []
  const base = join(workspaceRoot, PRIVATE_DIR)
  if (!existsSync(base)) return problems

  const needed = MOVED.filter((name) =>
    existsSync(join(base, name)) && !existsSync(join(base, STATE_DIR, name)))
  if (needed.length === 0) return problems

  try {
    mkdirSync(join(base, STATE_DIR), { recursive: true })
  } catch (e) {
    problems.push(`could not create ${PRIVATE_DIR}/${STATE_DIR}: ${(e as Error).message}`)
    return problems
  }

  for (const name of needed) {
    try {
      renameSync(join(base, name), join(base, STATE_DIR, name))
    } catch (e) {
      problems.push(
        `could not move ${PRIVATE_DIR}/${name} into ${STATE_DIR}/: ${(e as Error).message}. ` +
        'Nothing was lost; close anything using this workspace and re-open it.',
      )
    }
  }

  // The ignore file is deliberately NOT touched here. It already says `*`, which is what it
  // should say, and rewriting a file the user may have edited is not something a rearrange
  // of our own directories has any business doing.
  return problems
}
