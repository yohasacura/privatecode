import { describe, expect, it } from 'vitest'
import type { ChatItem } from '../lib/state'
import { agentCommands, commandsKey } from './terminal-tab'

/**
 * The console must not claim a command ran when it did not.
 *
 * This is the same property `CommandRecord.ran` was added to the work log for, in a different
 * panel: someone reading either one after an overnight run is trying to find out what the
 * agent actually did, and "npm test — failed" is the single most consequential line in it.
 */

function command(id: number, cmd: string, ok: boolean, content: string): ChatItem {
  return {
    kind: 'tool', id, name: 'run_command', startedAtMs: id,
    args: JSON.stringify({ command: cmd }),
    result: { ok, preview: 'p', content, display: content },
  }
}

describe('a command the step never executed', () => {
  it('is left out of the console entirely', () => {
    // The batch `[edit_file x, run_command "npm test"]` where the edit fails: the command is
    // answered with the `Not run:` contract and never runs. Shown, it read as a row saying
    // `npm test` FAILED, with the refusal sentence as its output.
    const skipped = command(
      1, 'npm test', false,
      'Not run: edit_file failed earlier in this step, so the calls after it were left alone.',
    )
    expect(agentCommands([skipped])).toEqual([])
  })

  it('a command the permission engine refused is shown as refused, never as failed', () => {
    // The person deciding what to allow needs to see what was asked. Its own tone, its own
    // word, and the rule as the output — not a red "failed" over a command that never ran.
    const refused = command(4, 'rm -rf build', false, 'Not run: denied by the rule "Bash(rm *)" for this workspace.')
    const lines = agentCommands([refused])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ state: 'refused', tone: 'refused' })
    expect(lines[0]?.output).toContain('denied by the rule')
  })

  it('does not hide a command that genuinely ran and failed', () => {
    // "Never ran" and "ran and failed" are different, and only the first is not a command.
    const failed = command(2, 'npm test', false, '$ npm test\nexit code 1\n3 tests failing')
    const lines = agentCommands([failed])
    expect(lines).toHaveLength(1)
    expect(lines[0]?.state).toBe('failed')
  })

  it('still shows one that is running, which has no result yet', () => {
    const running: ChatItem = {
      kind: 'tool', id: 3, name: 'run_command', startedAtMs: 3,
      args: JSON.stringify({ command: 'npm run build' }),
    }
    expect(agentCommands([running]).map((l) => l.state)).toEqual(['running'])
  })
})

/**
 * What makes the console re-read the transcript.
 *
 * The console is memoised because `items` is a new array on every streamed token; the key has
 * to be exact in both directions — cheap enough not to re-derive per token, and never so
 * coarse that it holds a list belonging to a different conversation.
 */
describe('commandsKey', () => {
  const say = (id: number, text: string): ChatItem => ({ kind: 'user', id, text })

  it('does not move while a step streams tokens into the newest item', () => {
    // The whole reason the key exists: same items, one of them growing a character at a time.
    const before: ChatItem[] = [say(1, 'build it'), { kind: 'assistant', id: 2, text: 'wo', interrupted: false }]
    const after: ChatItem[] = [say(1, 'build it'), { kind: 'assistant', id: 2, text: 'work', interrupted: false }]
    expect(commandsKey(after)).toEqual(commandsKey(before))
  })

  it('moves when a command finishes, which changes no count but the resolved one', () => {
    const running: ChatItem = {
      kind: 'tool', id: 2, name: 'run_command', startedAtMs: 2,
      args: JSON.stringify({ command: 'npm test' }),
    }
    const done = command(2, 'npm test', true, '$ npm test\nall good')
    expect(commandsKey([say(1, 'test it'), done])).not.toEqual(commandsKey([say(1, 'test it'), running]))
  })

  it('moves when a resumed session replaces a transcript of exactly the same shape', () => {
    // Two short sessions with equal item counts and equal resolved-tool counts is not an
    // exotic coincidence — both are small integers. Keyed on the counts alone, the Terminal
    // tab went on listing the PREVIOUS session's commands, output and all, under the new one.
    const wasOpen: ChatItem[] = [say(1, 'run the tests'), command(2, 'npm test', true, 'ok')]
    // `nextId` is carried across the switch, so the resumed session's items are numbered from
    // where the previous one stopped — never reusing an id it already spent.
    const resumed: ChatItem[] = [say(3, 'run the build'), command(4, 'npm run build', true, 'ok')]
    expect(resumed).toHaveLength(wasOpen.length)
    expect(commandsKey(resumed)).not.toEqual(commandsKey(wasOpen))
  })

  it('is stable for an empty conversation, which two empty sessions share', () => {
    expect(commandsKey([])).toEqual(commandsKey([]))
  })
})
