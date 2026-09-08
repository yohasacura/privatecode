import { describe, expect, test } from 'vitest'
import { currentToolCall, modernizeMessage } from '../src/tools/legacy-names.js'
import { Transcript } from '../src/transcript/transcript.js'
import type { ChatMessage } from '../src/llama/types.js'

/**
 * The renames of 2026-09-03 and 2026-09-07 left every earlier transcript naming the tools
 * the old way, and a model reads its transcript as the example of what works. A session
 * opened after the update kept calling `run_command` and `background_task`, was told
 * "Unknown tool" each time, and wrote the same call again — while the window, which shows
 * old names under their new labels, showed `TaskOutput` being called in a loop.
 */

describe('a call under an old name', () => {
  test('runs under the current name with the same arguments', () => {
    const args = JSON.stringify({ command: 'ls' })
    expect(currentToolCall('run_command', args)).toEqual({ name: 'Bash', args, renamed: 'run_command' })
    expect(currentToolCall('read_file', '{"path":"a.ts"}')).toMatchObject({ name: 'Read', renamed: 'read_file' })
    expect(currentToolCall('list_dir', '{"path":"."}')).toMatchObject({ name: 'LS', renamed: 'list_dir' })
    expect(currentToolCall('delete_file', '{"path":"x"}')).toMatchObject({ name: 'DeleteFile', renamed: 'delete_file' })
  })

  test("Claude Code's own retired names are read too", () => {
    expect(currentToolCall('BashOutput', '{"id":"task-1"}')).toMatchObject({ name: 'TaskOutput', renamed: 'BashOutput' })
    expect(currentToolCall('KillShell', '{"id":"task-1"}')).toMatchObject({ name: 'TaskStop', renamed: 'KillShell' })
    expect(currentToolCall('Task', '{}')).toMatchObject({ name: 'Agent', renamed: 'Task' })
  })

  test('a current name, or a name nobody ever had, passes through untouched', () => {
    expect(currentToolCall('Bash', '{"command":"ls"}')).toEqual({ name: 'Bash', args: '{"command":"ls"}', renamed: null })
    expect(currentToolCall('frobnicate', '{}')).toEqual({ name: 'frobnicate', args: '{}', renamed: null })
  })
})

describe('background_task, which was one tool and is three', () => {
  test('start is Bash in the background, keeping the readiness condition', () => {
    const c = currentToolCall('background_task', JSON.stringify({ action: 'start', command: 'npm run dev', ready_when: { port: 3000 } }))
    expect(c.name).toBe('Bash')
    expect(c.renamed).toBe('background_task')
    expect(JSON.parse(c.args)).toEqual({ command: 'npm run dev', run_in_background: true, ready_when: { port: 3000 } })
  })

  test('poll is TaskOutput and stop is TaskStop, by id', () => {
    const poll = currentToolCall('background_task', JSON.stringify({ action: 'poll', id: 'task-2', wait_seconds: 5 }))
    expect(poll.name).toBe('TaskOutput')
    expect(JSON.parse(poll.args)).toEqual({ id: 'task-2', wait_seconds: 5 })
    const stop = currentToolCall('background_task', JSON.stringify({ action: 'stop', id: 'task-2' }))
    expect(stop.name).toBe('TaskStop')
    expect(JSON.parse(stop.args)).toEqual({ id: 'task-2' })
  })

  test('arguments that are not JSON reach the reader unchanged, for its validation to name', () => {
    const c = currentToolCall('background_task', '{not json')
    expect(c.name).toBe('TaskOutput')
    expect(c.args).toBe('{not json')
  })
})

describe('a stored transcript', () => {
  const old: ChatMessage[] = [
    { role: 'user', content: 'what is in src?' },
    {
      role: 'assistant', content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_dir', arguments: '{"path":"src"}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', name: 'list_dir', content: 'app.ts' },
    {
      role: 'assistant', content: null,
      tool_calls: [{ id: 'c2', type: 'function', function: { name: 'background_task', arguments: '{"action":"start","command":"npm test"}' } }],
    },
    { role: 'tool', tool_call_id: 'c2', name: 'background_task', content: 'started task-1' },
    { role: 'assistant', content: 'running' },
  ]

  test('loads with every call under its current name, so the model copies the right vocabulary', () => {
    const t = Transcript.fromJSONL(old.map((m) => JSON.stringify(m)).join('\n'))
    const calls = t.messages().flatMap((m) => m.tool_calls ?? []).map((c) => c.function.name)
    expect(calls).toEqual(['LS', 'Bash'])
    const replies = t.messages().filter((m) => m.role === 'tool').map((m) => m.name)
    expect(replies).toEqual(['LS', 'Bash'])
    const started = t.messages()[3]!.tool_calls![0]!.function.arguments
    expect(JSON.parse(started)).toEqual({ command: 'npm test', run_in_background: true })
  })

  test('a message that needs nothing is the same object back', () => {
    const fresh: ChatMessage = {
      role: 'assistant', content: null,
      tool_calls: [{ id: 'c9', type: 'function', function: { name: 'Read', arguments: '{"path":"a"}' } }],
    }
    expect(modernizeMessage(fresh)).toBe(fresh)
    const text: ChatMessage = { role: 'assistant', content: 'done' }
    expect(modernizeMessage(text)).toBe(text)
  })
})
