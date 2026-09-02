/**
 * The two properties of an existing text file that a tool rewriting it whole has to put
 * back, and that nothing in the model's view of the file can tell it about: the file's
 * line endings and its UTF-8 byte-order mark.
 *
 * `Read` splits on /\r?\n/ and (now) drops the BOM, so what the model sees is always
 * LF-joined and always BOM-less. A model therefore cannot supply CRLF or a BOM even in
 * principle, which is why restoring them belongs here, on the write path, and not in a
 * prompt. Getting it wrong is not cosmetic: rewriting every line ending turns a one-line
 * change into a whole-file diff — and the design names the user's own git as the only
 * safety net, so a whole-file diff is that net switched off. MSBuild reads the BOM as
 * meaningful, and this user's stack is C# and TypeScript on Windows.
 *
 * Shared by `Edit` and `Write`. Deliberately shared rather than duplicated: the
 * two tools must agree byte-for-byte about what "the file's own shape" means, or the same
 * file changed by the two paths ends up with two different shapes.
 */

/** U+FEFF, built from its code point because the character itself is invisible in source. */
export const BOM = String.fromCharCode(0xfeff)

export interface Endings {
  /** The ending the file will be written back with. */
  eol: '\n' | '\r\n'
  crlf: number
  lf: number
}

function countOf(haystack: string, needle: string): number {
  let n = 0
  let i = haystack.indexOf(needle)
  while (i !== -1) {
    n++
    i = haystack.indexOf(needle, i + needle.length)
  }
  return n
}

/**
 * The text's line endings, by count.
 *
 * A text with no newline at all reports LF with both counts zero. For `Edit` that
 * costs nothing — there is no ending to preserve, and any ending the replacement
 * introduces has no precedent in the file to contradict — and `Write` checks the
 * counts rather than the `eol` field precisely so it does not impose LF on a file that
 * never expressed a preference. Lone carriage returns are not counted as endings —
 * `Read` does not treat them as line breaks either — and survive the round trip
 * untouched.
 */
export function detectEndings(text: string): Endings {
  const crlf = countOf(text, '\r\n')
  const lf = countOf(text, '\n') - crlf
  return { eol: crlf > lf ? '\r\n' : '\n', crlf, lf }
}

/** Every CRLF collapsed to a lone LF, so matching and diffing see content only. */
export function toLf(text: string): string {
  return text.includes('\r\n') ? text.split('\r\n').join('\n') : text
}

/** LF text, joined back with the ending the file actually uses. */
export function applyEndings(lfText: string, eol: '\n' | '\r\n'): string {
  return eol === '\r\n' ? lfText.split('\n').join('\r\n') : lfText
}
