/**
 * Where the `@` you are typing starts, and what you have typed after it.
 *
 * Its own module because the interesting part is everything that must NOT open a picker.
 * `@` is punctuation in a dozen places a developer types every day — `user@host`,
 * `@Component`, `@media`, `npm i left-pad@2` — and a dropdown that appears over the text you
 * are writing, every time, is worse than no picker at all. So it opens only on an `@` that
 * begins a word, and closes the moment the caret leaves it.
 */

export interface Mention {
  /** Index of the `@` itself, so the caller can replace from there. */
  at: number
  /** What has been typed after it, possibly empty (a bare `@` opens the picker). */
  query: string
}

/** Only an `@` at the start of a word counts, and only while the caret is still inside it. */
const AT_CARET = /(?:^|\s)@([^\s@]*)$/

export function mentionAtCaret(text: string, caret: number): Mention | null {
  const m = AT_CARET.exec(text.slice(0, caret))
  if (!m) return null
  return { at: caret - m[1]!.length - 1, query: m[1]! }
}

/** Replaces the mention being typed with `path`, and reports where the caret should land. */
export function applyMention(
  text: string, mention: Mention, caret: number, path: string,
): { text: string; caret: number } {
  return {
    text: `${text.slice(0, mention.at)}@${path} ${text.slice(caret)}`,
    // After the inserted path and its trailing space -- not at the end of the box, which
    // would jump past anything already written after the mention.
    caret: mention.at + path.length + 2,
  }
}
