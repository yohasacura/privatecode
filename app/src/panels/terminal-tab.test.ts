import { describe, expect, it } from 'vitest'
import type { ChatItem } from '../lib/state'
import { agentCommands } from './terminal-tab'

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
