import { describe, expect, it } from 'vitest'
import { initialChatState, reduceChat, type ChatAction, type ChatState } from './state'

function run(actions: ChatAction[]): ChatState {
  return actions.reduce(reduceChat, initialChatState())
}

/**
 * The strip under the answer (docs/UI-REDESIGN-2026-09.md §5) is drawn from `stages`: one
 * record per gate of the current turn, kept after the gate ends and until the next turn
 * starts. `runningStage` — the one gate on screen right now — is untouched by this.
 */
describe('the stages of a turn', () => {
  it('records a gate from its start, keeps it when it ends, and reads the outcome', () => {
    const state = run([
      { type: 'turn-started' },
      { type: 'stage', stage: 'contract', state: 'started', detail: 'working out what you asked for' },
      { type: 'stage', stage: 'contract', state: 'done', outcome: 'clean', ms: 1200 },
      { type: 'stage', stage: 'build', state: 'started', detail: 'dotnet build in src' },
    ])
    expect(state.stages.map((s) => [s.stage, s.state, s.ms])).toEqual([
      ['contract', 'passed', 1200],
      ['build', 'running', undefined],
    ])
    expect(state.stages[0]?.outcome).toBe('clean')
    expect(state.stages[1]?.detail).toBe('dotnet build in src')
    expect(state.runningStage?.stage).toBe('build')
  })

  it('reads the core’s outcome words the way the chips show them', () => {
    const outcomes: Array<[string, string]> = [
      ['not run — ask for /check or /review when you are ready', 'skipped'],
      ['skipped — not enough context left to review in', 'skipped'],
      ['stopped', 'skipped'],
      ['could not run', 'failed'],
      ['timed out after 120 s', 'failed'],
      ['2 criteria unmet', 'handed-back'],
      ['handed back: 1 issue', 'handed-back'],
      ['2 findings', 'handed-back'],
      ['no findings', 'passed'],
      ['every criterion met', 'passed'],
      ['no contract — the turn runs without one', 'skipped'],
      ['clean', 'passed'],
    ]
    for (const [outcome, expected] of outcomes) {
      const state = run([
        { type: 'stage', stage: 'acceptance', state: 'started' },
        { type: 'stage', stage: 'acceptance', state: 'done', outcome },
      ])
      expect(state.stages[0]?.state, outcome).toBe(expected)
    }
  })

  it('a fixer round re-enters build as a second attempt of the same chip', () => {
    const state = run([
      { type: 'stage', stage: 'build', state: 'started' },
      { type: 'stage', stage: 'build', state: 'done', outcome: '3 errors' },
      { type: 'stage', stage: 'build', state: 'started', detail: 'again, after the fix' },
    ])
    expect(state.stages).toHaveLength(1)
    expect(state.stages[0]).toMatchObject({ stage: 'build', state: 'running', attempt: 2, detail: 'again, after the fix' })
  })

  it('progress without a start still puts the gate on the strip; a done without a start records the outcome', () => {
    const state = run([
      { type: 'stage', stage: 'premises', state: 'progress', detail: 'premise 2 of 5', at: { index: 2, total: 5 } },
      { type: 'stage', stage: 'review', state: 'done', outcome: 'clean', ms: 900 },
    ])
    expect(state.stages.map((s) => [s.stage, s.state])).toEqual([['premises', 'running'], ['review', 'passed']])
    expect(state.stages[0]?.at).toEqual({ index: 2, total: 5 })
  })

  it('a new turn starts with an empty strip; the turn ending keeps it', () => {
    const ended = run([
      { type: 'turn-started' },
      { type: 'stage', stage: 'contract', state: 'started' },
      { type: 'stage', stage: 'contract', state: 'done', outcome: 'clean' },
      { type: 'turn.done', stoppedBecause: 'done' },
    ])
    expect(ended.stages).toHaveLength(1)
    const next = reduceChat(ended, { type: 'turn-started' })
    expect(next.stages).toEqual([])
  })

  it('an undelivered message clears the strip along with the rest of the turn', () => {
    const state = run([
      { type: 'user-message', text: 'do it' },
      { type: 'turn-started' },
      { type: 'stage', stage: 'contract', state: 'started' },
      { type: 'turn.done', stoppedBecause: 'aborted', delivered: false },
    ])
    expect(state.stages).toEqual([])
    expect(state.restoreDraft).toBe('do it')
  })
})
