import { describe, expect, test } from 'vitest'
import { groupItems, summarise, summaryText } from './action-groups'
import type { ChatItem } from './state'

const user = (id: number): ChatItem => ({ kind: 'user', id, text: 'do it' })
const prose = (id: number): ChatItem => ({ kind: 'assistant', id, text: 'done', interrupted: false })
const tool = (id: number, name: string, args: Record<string, unknown>, ok = true): ChatItem => ({
  kind: 'tool', id, name, args: JSON.stringify(args),
  result: { ok, content: '', display: '', preview: '' },
} as unknown as ChatItem)
const pending = (id: number, name: string, args: Record<string, unknown>): ChatItem => ({
  kind: 'tool', id, name, args: JSON.stringify(args),
} as unknown as ChatItem)
const verify = (id: number, ok: boolean): ChatItem => ({ kind: 'verify-record', id, command: 'dotnet build', ok, detail: ok ? 'passed' : 'exited 1' } as ChatItem)

describe('folding the work between answers', () => {
  test('two or more activity items become one group; a lone one stays a row', () => {
    const units = groupItems([
      user(1), tool(2, 'read_file', { path: 'a.cs' }), tool(3, 'edit_file', { path: 'a.cs' }), verify(4, true), prose(5),
      tool(6, 'read_file', { path: 'b.cs' }), prose(7),
    ], false)
    expect(units.map((u) => u.kind)).toEqual(['single', 'group', 'single', 'single', 'single'])
    const group = units[1]
    if (group === undefined || group.kind !== 'group') throw new Error('expected a group')
    expect(group.items.map((i) => i.id)).toEqual([2, 3, 4])
    expect(group.live).toBe(false)
  })

  test('the last group is live while the turn runs and nothing has followed it', () => {
    const live = groupItems([user(1), tool(2, 'read_file', { path: 'a.cs' }), pending(3, 'edit_file', { path: 'a.cs' })], true)
    expect(live[1]).toMatchObject({ kind: 'group', live: true })
    const followed = groupItems([user(1), tool(2, 'read_file', { path: 'a.cs' }), tool(3, 'edit_file', { path: 'a.cs' }), prose(4)], true)
    expect(followed[1]).toMatchObject({ kind: 'group', live: false })
  })
})

describe('the summary line', () => {
  test('counts by what the tools do and names the latest action', () => {
    const s = summarise([
      tool(1, 'read_file', { path: 'src/Snapshot.cs' }),
      tool(2, 'search_code', { pattern: 'SaveSnapshot' }),
      tool(3, 'edit_file', { path: 'src/Snapshot.cs' }),
      tool(4, 'run_command', { commands: ['dotnet build'] }, false),
      verify(5, true),
      pending(6, 'read_file', { path: 'src/Store.cs' }),
    ])
    expect(s).toMatchObject({ reads: 3, edits: 1, commands: 1, failed: 1, checks: 1, checksFailed: 0 })
    expect(s.latest).toBe('Reading Store.cs…')
    expect(summaryText(s)).toBe('Read 3 files · edited 1 · 1 command · check passed · 1 call failed')
    expect(summaryText(summarise([verify(1, false), verify(2, true)]))).toBe('1 of 2 checks failed')
  })

  test('an empty group still has a sentence', () => {
    expect(summaryText(summarise([]))).toBe('Worked')
  })
})
