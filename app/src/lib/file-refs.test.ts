import { describe, expect, it } from 'vitest'
import { parseFileRef, splitFileRefs } from './file-refs'

/**
 * What counts as a path inside a sentence.
 *
 * Both halves matter equally and the second one is the reason this file is long: a rule that
 * finds every path also finds `Node.js`, `and/or` and `v0.1.0`, and a plan whose every other
 * word is a fake link is worse than the flat grey text it replaced. So the misses are pinned
 * as hard as the hits.
 */

/** The refs a piece of prose yields, in order. */
function refs(text: string): string[] {
  return splitFileRefs(text).flatMap((p) => (p.kind === 'ref' ? [p.ref.path] : []))
}

/** Everything the card would render, chips included — for checking nothing was eaten. */
function rendered(text: string): string {
  return splitFileRefs(text).map((p) => (p.kind === 'text' ? p.text : p.ref.label)).join('')
}

describe('what is a path', () => {
  it('finds a workspace-relative source file in the middle of a sentence', () => {
    expect(refs('rewrite the insert in core/src/db/invoice.ts so it is one statement'))
      .toEqual(['core/src/db/invoice.ts'])
  })

  it('finds a bare filename by its extension', () => {
    expect(refs('bump the version in package.json and note it in README.md'))
      .toEqual(['package.json', 'README.md'])
  })

  it('finds a directory written with a trailing slash', () => {
    expect(refs('add the fixtures under core/test/fixtures/')).toEqual(['core/test/fixtures/'])
  })

  it('finds an extensionless path once it is deep enough to be one', () => {
    // Two separators. `and/or` has one, which is the whole point of the threshold.
    expect(refs('everything under core/src/session needs the new gate'))
      .toEqual(['core/src/session'])
  })

  it('finds a Windows path and hands it over with forward slashes', () => {
    // The label keeps what was written; only what gets opened is normalised.
    const [piece] = splitFileRefs('open D:\\proj\\app\\src\\App.css').filter((p) => p.kind === 'ref')
    expect(piece).toMatchObject({ ref: { label: 'D:\\proj\\app\\src\\App.css', path: 'D:/proj/app/src/App.css' } })
  })

  it('keeps a line number in the label and out of the path', () => {
    expect(parseFileRef('app/src/App.tsx:541')).toEqual({
      label: 'app/src/App.tsx:541', path: 'app/src/App.tsx', line: 541,
    })
    expect(parseFileRef('app/src/App.tsx:541:12')).toMatchObject({ path: 'app/src/App.tsx', line: 541 })
  })
})

describe('what is not a path', () => {
  it('leaves a library whose name ends in an extension alone', () => {
    // Structurally identical to `app.js`. Only knowing what it is separates them.
    expect(refs('the sidecar is plain Node.js')).toEqual([])
    expect(refs('drop Vue.js and Chart.js')).toEqual([])
  })

  it('leaves prose slashes alone', () => {
    expect(refs('handle the read/write case and/or the retry')).toEqual([])
    expect(refs('works on TypeScript/JavaScript projects')).toEqual([])
  })

  it('leaves versions, shortcuts and tool names alone', () => {
    expect(refs('ship v0.1.0, bind Ctrl+E, and make todo_write index-sized')).toEqual([])
  })

  it('does not mistake the tail of a URL for a file', () => {
    // `example.com/notes.md` passes every structural test; what disqualifies it is the `/`
    // sitting in front of it.
    expect(refs('see https://example.com/notes.md for the format')).toEqual([])
    expect(rendered('see https://example.com/notes.md for the format'))
      .toBe('see https://example.com/notes.md for the format')
  })

  it('does not mistake an email address for a file', () => {
    expect(refs('ping me at someone@example.com about it')).toEqual([])
  })

  it('leaves a bare top-level folder alone — one segment says nothing', () => {
    // `core/` on its own is as likely to be prose as a directory; two segments is where it
    // stops being a guess.
    expect(refs('run the bundle in core/, then in app/')).toEqual([])
  })

  it('leaves a backticked command as the text it was', () => {
    expect(refs('run `npm run build` first')).toEqual([])
    expect(rendered('run `npm run build` first')).toBe('run `npm run build` first')
  })
})

describe('what the card ends up rendering', () => {
  it('gives the sentence back unchanged apart from the backticks around a path', () => {
    expect(rendered('fix core/src/a.ts, then core/src/b.ts. Nothing else.'))
      .toBe('fix core/src/a.ts, then core/src/b.ts. Nothing else.')
    expect(rendered('fix `core/src/a.ts` next')).toBe('fix core/src/a.ts next')
  })

  it('does not swallow the punctuation that ended the sentence', () => {
    // The chip is the path; the full stop belongs to the sentence and has to survive as
    // text, or a plan step reads as if it never ended.
    const pieces = splitFileRefs('rewrite core/src/a.ts.')
    expect(pieces).toEqual([
      { kind: 'text', text: 'rewrite ' },
      { kind: 'ref', ref: { label: 'core/src/a.ts', path: 'core/src/a.ts', line: null } },
      { kind: 'text', text: '.' },
    ])
  })

  it('handles a path inside brackets on both sides', () => {
    expect(rendered('the gate (core/src/session/premises.ts) runs first'))
      .toBe('the gate (core/src/session/premises.ts) runs first')
    expect(refs('the gate (core/src/session/premises.ts) runs first'))
      .toEqual(['core/src/session/premises.ts'])
  })

  it('opens a `./` path as the tree spells it, while the step keeps what was written', () => {
    expect(parseFileRef('./scripts/build.mjs')).toEqual({
      label: './scripts/build.mjs', path: 'scripts/build.mjs', line: null,
    })
  })

  it('is a single text piece when there is nothing to find', () => {
    expect(splitFileRefs('tune the plan so it gets marked')).toEqual([
      { kind: 'text', text: 'tune the plan so it gets marked' },
    ])
  })

  it('survives an empty step', () => {
    expect(splitFileRefs('')).toEqual([])
  })
})
