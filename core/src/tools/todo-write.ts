import type { Tool } from './types.js'
import type { TodoItem } from '../interaction.js'

export interface TodoWriteArgs {
  todos: TodoItem[]
}

export const todoWriteTool: Tool<TodoWriteArgs> = {
  name: 'todo_write',
  readOnly: true,
  description:
    'Record the plan for a multi-step task, and keep it current as you work. Every call ' +
    'replaces the whole list. It survives compaction and app restarts, so on a long task ' +
    'this is what remembers the shape of the work when the conversation no longer does. ' +
    'Give each step a done_when: what will actually show it is finished.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The todo item text.' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
              description: 'The status of the todo.',
            },
            done_when: {
              type: 'string',
              description:
                'What will show this step is done — a command that passes, a file that ' +
                'exists, a behaviour you can observe. Not a restatement of the step.',
            },
          },
          required: ['text', 'status'],
        },
        description: '1–50 todo items.',
      },
    },
    required: ['todos'],
  },
  validate(raw) {
    const r = raw as Partial<TodoWriteArgs>
    if (!Array.isArray(r?.todos)) {
      return { ok: false, error: 'todos must be an array' }
    }
    if (r.todos.length === 0) {
      return { ok: false, error: 'todos must have at least 1 item' }
    }
    if (r.todos.length > 50) {
      return { ok: false, error: 'todos must have at most 50 items' }
    }

    const validStatuses = new Set(['pending', 'in_progress', 'completed'])
    let inProgressCount = 0

    for (let i = 0; i < r.todos.length; i++) {
      const item = r.todos[i]
      if (typeof item?.text !== 'string' || item.text.trim() === '') {
        return { ok: false, error: `todos[${i}].text must be a non-empty string` }
      }
      if (item.text.length > 200) {
        return { ok: false, error: `todos[${i}].text must be at most 200 characters` }
      }
      if (!validStatuses.has(item.status)) {
        return { ok: false, error: `todos[${i}].status must be 'pending', 'in_progress', or 'completed'` }
      }
      if (item.done_when !== undefined &&
          (typeof item.done_when !== 'string' || item.done_when.length > 200)) {
        return { ok: false, error: `todos[${i}].done_when must be a string of at most 200 characters` }
      }
      if (item.status === 'in_progress') {
        inProgressCount++
      }
    }

    if (inProgressCount > 1) {
      return { ok: false, error: 'at most one todo may have status in_progress' }
    }

    // Normalised rather than passed through: `todos` arrives as `Partial<TodoItem>[]` and
    // the persisted plan must not carry stray keys the model invented.
    const todos = r.todos.map((t) => ({
      text: t!.text!,
      status: t!.status!,
      ...(typeof t!.done_when === 'string' && t!.done_when.trim() !== ''
        ? { done_when: t!.done_when.trim() }
        : {}),
    }))
    return { ok: true, args: { todos } }
  },
  async execute(args, ctx) {
    if (!ctx.todos) {
      return { ok: false, content: 'todo list is not available in this session' }
    }

    ctx.todos.set(args.todos)
    ctx.interaction?.todosChanged?.(ctx.todos.list())

    const completed = args.todos.filter((t) => t.status === 'completed').length
    const inProgress = args.todos.filter((t) => t.status === 'in_progress').length
    const pending = args.todos.filter((t) => t.status === 'pending').length

    let msg = `${args.todos.length} todos recorded`
    const parts = []
    if (inProgress > 0) parts.push(`${inProgress} in progress`)
    if (completed > 0) parts.push(`${completed} completed`)
    if (pending > 0) parts.push(`${pending} pending`)
    if (parts.length > 0) {
      msg += ` (${parts.join(', ')})`
    }
    msg += '.'

    return { ok: true, content: msg }
  },
}
