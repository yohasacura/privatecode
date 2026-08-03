import { readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PRIVATE_DIR, ensurePrivateDir } from '../private-dir.js'
import type { Workspace } from '../workspace.js'

/**
 * Overflow storage for tool output that is too large to hand the model.
 *
 * The problem this solves: a tool that produces more than the context can afford used to
 * middle-elide its output and say so. That is a dead end — the model cannot ask for the
 * part that was cut, so its only recourse is to run the command again with a narrower
 * filter, guessing at what it could not see. On a long build or test log that costs
 * several turns and often never converges.
 *
 * Instead the whole output is written to a file inside the workspace, and the model is
 * told the path and the line count. From there it uses the tools it already has:
 * `read_file` with `start_line`/`end_line` walks it in pages, `search_code` with `path`
 * filters it. Nothing is lost, nothing is guessed, and paging costs one small tool call
 * per page instead of one whole command re-run.
 *
 * The directory is `.privatecode/logs/` — already ours (sessions live beside it), already
 * inside the jail so `read_file` accepts it, and conventionally ignored by tooling.
 */

/** Where overflow logs live, workspace-relative. Used in messages to the model, so it is
 * spelled with forward slashes: that is what its tools accept on every platform. */
export const LOG_DIR = `${PRIVATE_DIR}/logs`

/** How many log files to keep. Old ones are the least likely to be wanted and the most
 * likely to be forgotten, so the directory prunes itself rather than growing forever. */
const KEEP_LOGS = 20

/** `run-20260804-013245-118`: sortable, unique per call, and readable in a directory
 * listing without opening anything. */
function logName(prefix: string, now: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${prefix}-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${p(now.getMilliseconds(), 3)}.log`
}

export interface SpilledLog {
  /** Workspace-relative path, forward slashes — ready to paste into a `read_file` call. */
  path: string
  lines: number
}

/**
 * Writes `text` to a fresh log file and returns how to reach it, or `null` if it could not
 * be written.
 *
 * Failure is deliberately soft: an unwritable workspace must degrade to the old clipped
 * output, never turn a successful command into a failed tool call.
 */
export async function spillToLog(
  workspace: Workspace,
  prefix: string,
  text: string,
  now: Date = new Date(),
): Promise<SpilledLog | null> {
  const relative = `${LOG_DIR}/${logName(prefix, now)}`
  try {
    const abs = workspace.resolve(relative)
    // Creates the directory AND its self-ignore, so a workspace that is a git repository
    // never sees these logs in `git status`. See private-dir.ts.
    const dir = ensurePrivateDir(workspace.root, 'logs')
    await writeFile(abs, text, 'utf8')
    void prune(dir)
    return { path: relative, lines: countLines(text) }
  } catch {
    return null
  }
}

/** Line count as `read_file` counts them, so "of N lines" agrees with what paging shows. */
export function countLines(text: string): number {
  if (text === '') return 0
  const lines = text.split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.length
}

/** Best-effort, fire-and-forget: a failed prune must never affect the call that triggered
 * it, and a log left behind costs a few kilobytes. */
async function prune(dir: string): Promise<void> {
  try {
    const entries = (await readdir(dir)).filter((n) => n.endsWith('.log')).sort()
    for (const name of entries.slice(0, Math.max(0, entries.length - KEEP_LOGS))) {
      await unlink(join(dir, name)).catch(() => {})
    }
  } catch { /* nothing to prune, or the directory vanished */ }
}

/**
 * The paragraph handed to the model in place of the part that did not fit.
 *
 * It states the size, shows a bounded head so the common case (the answer is near the
 * top) needs no second call, and names both ways to get the rest — by line range and by
 * pattern — with the exact arguments, because a capability the model has to infer is one
 * it will not use.
 */
export function overflowNotice(log: SpilledLog, shownLines: number): string {
  return `\n... ${log.lines - shownLines} more lines not shown here.\n` +
    `The complete output (${log.lines} lines) is saved at ${log.path}\n` +
    `Read any part of it with read_file(path="${log.path}", start_line=…, end_line=…), ` +
    `or find lines in it with search_code(pattern="…", path="${log.path}"). ` +
    'Do NOT re-run the command to see what was cut.'
}

/** The first `n` lines of `text`, for the head shown inline before the notice. */
export function headLines(text: string, n: number): string {
  return text.split(/\r?\n/).slice(0, n).join('\n')
}
