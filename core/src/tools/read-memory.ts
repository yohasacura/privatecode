import { createHash } from 'node:crypto'

/**
 * What the model has already been shown, so a second look can cost what it is worth.
 *
 * Measured across every session this tool has run, counting by distinct tool_call id: 141 of
 * 621 calls were exact repeats, and one 40k-character file was read whole 21 times in the
 * biggest session and 30 times across four. (Earlier drafts of this note said 223 of 703 and
 * "31 times in one session". Those came from raw record counts, and 82 of the 703 records are
 * the same call logged twice — a compaction swap appends the whole rewritten transcript. The
 * shape held; the numbers did not.) The pattern it was built for is read → edit → read: the
 * model checking its own work, the only way it had.
 *
 * The rule this implements is the one the user chose: the model still decides, but the cheap
 * answer is the default and the expensive one is available by asking. A repeat of a file
 * that has not changed says so; a repeat of one that has says what changed.
 *
 * **Only whole-file reads that actually returned the text are recorded.** A ranged read
 * showed part of a file and a large file's read showed only its shape — claiming either as
 * "you have seen this" would make a later diff describe content the model was never given.
 *
 * **Cleared when a Session is built and at a compaction swap** — the correctness condition
 * for the whole idea:
 * after a swap the file's text is genuinely gone from the context, so "unchanged since you
 * read it" would be true and useless, and a diff would be a fragment of something no longer
 * there. See `Session.applyCompactionSwap`.
 */
export class ReadMemory {
  /** path -> the exact text last handed to the model. */
  private readonly seen = new Map<string, string>()
  /** Paths this session has written since the model was last shown them. See `wasWritten`. */
  private readonly written = new Set<string>()
  /** Bounded so a long session cannot hold a workspace in memory. Oldest out first. */
  private readonly limit: number

  constructor(limit = 200) {
    this.limit = limit
  }

  /** The text the model was last given for this path, or null if it has not seen it whole. */
  get(path: string): string | null {
    return this.seen.get(path) ?? null
  }

  /**
   * Why a repeat happened, as far as anything here can tell.
   *
   * Two different things look identical at this layer. One is the model CHECKING ITS OWN
   * WORK — read, edit, read — which is what the cheap answer was measured on and where
   * "unchanged" or a diff is exactly right. The other is the model LOOKING SOMETHING UP: it
   * read the file earlier, was then asked which parameter controls some behaviour, and went
   * back for it. Answering that with "you already have it" replies to a question it did not
   * ask — it went back precisely because it could not find the thing — and leaves it either
   * stranded or paying a second round trip for `full: true`.
   *
   * A write is what separates them, so writes are recorded. Nothing here is a guess about
   * intent: either this session changed the file since the model saw it, or it did not.
   */
  markWritten(path: string): void {
    this.written.add(path)
  }

  wasWritten(path: string): boolean {
    return this.written.has(path)
  }

  record(path: string, text: string): void {
    // Showing the model the file settles whatever the write did, so the flag starts again.
    this.written.delete(path)
    // Re-inserted so recency is insertion order and eviction is genuinely oldest-first.
    this.seen.delete(path)
    this.seen.set(path, text)
    while (this.seen.size > this.limit) {
      const oldest = this.seen.keys().next()
      if (oldest.done === true) break
      this.seen.delete(oldest.value)
    }
  }

  forget(path: string): void {
    this.seen.delete(path)
    this.written.delete(path)
  }

  /** Everything is unseen again — the only honest state after the context was replaced. */
  clear(): void {
    this.seen.clear()
    this.written.clear()
  }

  size(): number {
    return this.seen.size
  }
}

/** Cheap equality for "did this file change", without holding two copies to compare. */
export function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}
