import { describe, expect, test } from 'vitest'
import { askUserTool } from '../src/tools/ask-user.js'
import type { UserQuestion } from '../src/interaction.js'
import type { ToolContext } from '../src/tools/types.js'

/**
 * The structured question tool: options, one-or-several selection, and the always-present
 * free-text answer. The UI halves are exercised by their own panels; what is pinned here
 * is the contract — what the model may send, and what reaches the interaction port.
 */

function ctxWith(answer: string, seen: UserQuestion[]): ToolContext {
  return {
    interaction: {
      requestApproval: () => Promise.resolve({ verdict: 'deny' as const }),
      askUser: (q: UserQuestion) => { seen.push(q); return Promise.resolve(answer) },
    },
  } as unknown as ToolContext
}

describe('AskUserQuestion validation', () => {
  test('multi_select is optional, boolean, and snake case on the wire', () => {
    const base = { question: 'which?', options: ['a', 'b'] }
    expect(askUserTool.validate({ ...base }).ok).toBe(true)
    expect(askUserTool.validate({ ...base, multi_select: true }).ok).toBe(true)
    expect(askUserTool.validate({ ...base, multi_select: false }).ok).toBe(true)
    const bad = askUserTool.validate({ ...base, multi_select: 'yes' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toMatch(/multi_select/)
  })

  test('the flag reaches the port as multiSelect, and only when true', async () => {
    const seen: UserQuestion[] = []
    const v = askUserTool.validate({ question: 'which several?', options: ['x', 'y', 'z'], multi_select: true })
    if (!v.ok) throw new Error(v.error)
    const result = await askUserTool.execute(v.args, ctxWith('x; z', seen))
    expect(result.ok).toBe(true)
    expect(result.content).toBe('The user answered: x; z')
    expect(seen[0]?.multiSelect).toBe(true)

    const single = askUserTool.validate({ question: 'which one?', options: ['x', 'y'], multi_select: false })
    if (!single.ok) throw new Error(single.error)
    await askUserTool.execute(single.args, ctxWith('y', seen))
    // false is the default and is NOT carried: absent means what it always meant.
    expect('multiSelect' in seen[1]!).toBe(false)
  })
})
