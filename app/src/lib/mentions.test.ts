import { describe, expect, it } from 'vitest'
import { applyMention, mentionAtCaret } from './mentions'

/**
 * Most of these are cases where the picker must stay CLOSED. `@` is punctuation in a dozen
 * places a developer types every day, and a dropdown that appears over the text you are
 * writing every time is worse than no picker at all.
 */

const at = (text: string): ReturnType<typeof mentionAtCaret> => mentionAtCaret(text, text.length)

describe('when the picker opens', () => {
  it('on a bare @ starting a word', () => {
    expect(at('look at @')).toEqual({ at: 8, query: '' })
  })

  it('on @ at the very start of the box', () => {
    expect(at('@src')).toEqual({ at: 0, query: 'src' })
  })

  it('and the query is everything typed after it, slashes included', () => {
    expect(at('open @src/host/rep')).toEqual({ at: 5, query: 'src/host/rep' })
  })

  it('after a newline, which is still the start of a word', () => {
    expect(at('first line\n@sec')).toEqual({ at: 11, query: 'sec' })
  })
})

describe('when it must not', () => {
  it('an email address', () => {
    expect(at('mail me at yohas@gmail.com')).toBeNull()
  })

  it('a decorator or an at-rule the user is quoting', () => {
    expect(at('the @Component decorator')).toBeNull() // caret is past it: word already ended
    expect(at('fix @media')).toEqual({ at: 4, query: 'media' })
  })

  it('a version specifier', () => {
    expect(at('npm i left-pad@2')).toBeNull()
  })

  it('a second @ inside the same word', () => {
    expect(at('@src@x')).toBeNull()
  })

  it('once the caret has moved past the mention', () => {
    // The mention is still in the text, but you are writing somewhere else now.
    const text = 'see @src/a.ts and also this'
    expect(mentionAtCaret(text, text.length)).toBeNull()
  })

  it('when the caret is before the @ entirely', () => {
    expect(mentionAtCaret('hello @src', 3)).toBeNull()
  })
})

describe('inserting the chosen file', () => {
  it('replaces what was typed and leaves the caret after it', () => {
    const text = 'look at @stat'
    const mention = mentionAtCaret(text, text.length)!
    const result = applyMention(text, mention, text.length, 'src/stats.ts')
    expect(result.text).toBe('look at @src/stats.ts ')
    expect(result.caret).toBe(result.text.length)
  })

  it('keeps whatever was already written after the mention', () => {
    // The caret must not jump to the end of the box, or the rest of the sentence is orphaned.
    const text = 'look at @stat and explain it'
    const caret = 13
    const mention = mentionAtCaret(text, caret)!
    const result = applyMention(text, mention, caret, 'src/stats.ts')
    expect(result.text).toBe('look at @src/stats.ts  and explain it')
    expect(result.text.slice(result.caret)).toBe(' and explain it')
  })
})
