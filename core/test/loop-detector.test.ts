import { describe, expect, test } from 'vitest'
import { LoopDetector } from '../src/agent/loop-detector.js'

/**
 * The signal is the RESULT, not the call, and every test here exists to hold that line.
 *
 * Repeating a call is frequently the right thing to do: `background_task` poll is designed
 * to be called until something changes, and re-reading a file after editing it is correct.
 * A detector that counted calls alone would break both, which is worse than the loop it
 * was trying to catch.
 */

describe('what counts as a loop', () => {
  test('the third identical call with an identical result is refused', () => {
    const d = new LoopDetector()
    d.record('Bash', '{"command":"npm test"}', 'exit 1\nFAILED')
    expect(d.wouldRepeat('Bash', '{"command":"npm test"}')).toBe(false)
    d.record('Bash', '{"command":"npm test"}', 'exit 1\nFAILED')
    expect(d.wouldRepeat('Bash', '{"command":"npm test"}')).toBe(true)
  })

  test('a call that keeps returning something different is left alone forever', () => {
    // background_task poll exists to be called until something changes. A detector that
    // stopped it would have broken the one tool whose whole purpose is repetition.
    const d = new LoopDetector()
    for (let i = 0; i < 20; i++) {
      d.record('background_task', '{"action":"poll","id":"j1"}', `line ${i}`)
      expect(d.wouldRepeat('background_task', '{"action":"poll","id":"j1"}')).toBe(false)
    }
  })

  test('an old disagreement does not excuse a fresh repetition', () => {
    // Only the most recent occurrences have to agree: a call that WAS informative and has
    // since gone flat is still stuck now.
    const d = new LoopDetector()
    d.record('Read', '{"path":"a.ts"}', 'version one')
    d.record('Read', '{"path":"a.ts"}', 'version two')
    d.record('Read', '{"path":"a.ts"}', 'version two')
    expect(d.wouldRepeat('Read', '{"path":"a.ts"}')).toBe(true)
  })

  test('a call that has gone from flat to informative is allowed again', () => {
    const d = new LoopDetector()
    d.record('Read', '{"path":"a.ts"}', 'same')
    d.record('Read', '{"path":"a.ts"}', 'same')
    expect(d.wouldRepeat('Read', '{"path":"a.ts"}')).toBe(true)
    // The file changed; the call is telling it something again.
    d.record('Read', '{"path":"a.ts"}', 'different now')
    expect(d.wouldRepeat('Read', '{"path":"a.ts"}')).toBe(false)
  })

  test('different arguments are different calls', () => {
    const d = new LoopDetector()
    d.record('Read', '{"path":"a.ts"}', 'x')
    d.record('Read', '{"path":"b.ts"}', 'x')
    expect(d.wouldRepeat('Read', '{"path":"a.ts"}')).toBe(false)
  })

  test('the same arguments to different tools are different calls', () => {
    const d = new LoopDetector()
    d.record('Read', '{"path":"a.ts"}', 'x')
    d.record('symbol_outline', '{"path":"a.ts"}', 'x')
    expect(d.wouldRepeat('Read', '{"path":"a.ts"}')).toBe(false)
  })

  test('only the compared prefix of a huge result has to match', () => {
    // A megabyte of identical build output is identical in its first few hundred characters
    // too, and hashing all of it on every call would cost more than it saves.
    const d = new LoopDetector()
    const big = (tail: string) => `${'x'.repeat(5_000)}${tail}`
    d.record('Bash', '{"command":"build"}', big('a'))
    d.record('Bash', '{"command":"build"}', big('b'))
    expect(d.wouldRepeat('Bash', '{"command":"build"}')).toBe(true)
  })
})

describe('the window', () => {
  test('an old pair ages out, so an hour-apart repeat is not held against the model', () => {
    const d = new LoopDetector({ window: 4 })
    d.record('Bash', '{"command":"a"}', 'same')
    d.record('Bash', '{"command":"a"}', 'same')
    expect(d.wouldRepeat('Bash', '{"command":"a"}')).toBe(true)
    for (let i = 0; i < 4; i++) d.record('Read', `{"path":"f${i}.ts"}`, `body ${i}`)
    expect(d.wouldRepeat('Bash', '{"command":"a"}')).toBe(false)
    expect(d.size()).toBe(4)
  })

  test('the limit is configurable and honoured', () => {
    const d = new LoopDetector({ limit: 2 })
    d.record('Bash', '{"command":"a"}', 'same')
    expect(d.wouldRepeat('Bash', '{"command":"a"}')).toBe(true)
  })
})

describe('what the model is told', () => {
  test('the refusal names the tool and the count, not just "try something else"', () => {
    // A refusal that does not say why reads as arbitrary, and a model given an arbitrary
    // refusal retries.
    const text = new LoopDetector().refusal('Bash')
    expect(text).toContain('Bash')
    expect(text).toContain('2 times')
    expect(text).toMatch(/different approach/)
    expect(text).toMatch(/say plainly what you are stuck on/)
  })
})

describe('results that change for reasons the model did not cause', () => {
  test('a command re-run to the same effect is caught despite its duration differing', () => {
    // The hole that made the detector nearly inert. `Bash` opens every result with
    // `exit 0 in 1.7 s`, so a wall-clock number sat at character 0 of the compared prefix and
    // two identical builds only matched when they happened to round to the same tenth. In the
    // recorded corpus the detector fired twice in ~537 calls -- and one of those two fired by
    // coincidence, because two builds both rounded to 1.7 s.
    const d = new LoopDetector()
    const args = JSON.stringify({ command: 'dotnet build' })
    const result = (s: string): string =>
      `exit 0 in ${s} s\nBuild succeeded.\n  1 Warning(s)\n  CS8602: possible null dereference\n`

    d.record('Bash', args, result('1.7'))
    d.record('Bash', args, result('2.3'))
    expect(d.wouldRepeat('Bash', args)).toBe(true)
  })

  test('a genuinely different exit code is still progress', () => {
    // The normalisation must not flatten the thing that actually distinguishes two runs.
    const d = new LoopDetector()
    const args = JSON.stringify({ command: 'dotnet build' })
    d.record('Bash', args, 'exit 1 in 1.7 s\nBuild FAILED.\n')
    d.record('Bash', args, 'exit 0 in 2.3 s\nBuild succeeded.\n')
    expect(d.wouldRepeat('Bash', args)).toBe(false)
  })

  test('a duration further into the output is left alone', () => {
    // Only the header is volatile by construction. A number inside a test report is content.
    const d = new LoopDetector()
    const args = JSON.stringify({ command: 'dotnet test' })
    d.record('Bash', args, 'exit 0 in 1.0 s\nPassed! Duration: 3.1 s\n')
    d.record('Bash', args, 'exit 0 in 1.0 s\nPassed! Duration: 9.8 s\n')
    expect(d.wouldRepeat('Bash', args)).toBe(false)
  })
})
