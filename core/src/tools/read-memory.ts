import { createHash } from 'node:crypto'

/**
 * What the model has already been shown, so a second look can cost what it is worth.
 *
 * Measured across every session this tool has run: 223 of 703 tool calls were exact repeats,
 * and one 40k-character file was read whole 31 times in a single session — roughly 310k
 * tokens, on a 131k window, for one file. The pattern is read → edit → read → edit: the
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
 * **Cleared at a compaction swap**, which is the correctness condition for the whole idea:
 * after a swap the file's text is genuinely gone from the context, so "unchanged since you
 * read it" would be true and useless, and a diff would be a fragment of something no longer
 * there. See `Session.applyCompactionSwap`.
 */
export class ReadMemory {
  /** path -> the exact text last handed to the model. */
  private readonly seen = new Map<string, string>()
  /** Bounded so a long session cannot hold a workspace in memory. Oldest out first. */
  private readonly limit: number

  constructor(limit = 200) {
    this.limit = limit
  }

  /** The text the model was last given for this path, or null if it has not seen it whole. */
  get(path: string): string | null {
    return this.seen.get(path) ?? null
  }

  record(path: string, text: string): void {
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
  }

  /** Everything is unseen again — the only honest state after the context was replaced. */
  clear(): void {
    this.seen.clear()
  }

  size(): number {
    return this.seen.size
  }
}

/** Cheap equality for "did this file change", without holding two copies to compare. */
export function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}
