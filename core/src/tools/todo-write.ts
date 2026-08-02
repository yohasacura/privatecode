import type { Tool } from './types.js'
import type { TodoItem } from '../interaction.js'

export interface TodoWriteArgs {
  todos: TodoItem[]
}

export const todoWriteTool: Tool<TodoWriteArgs> = {
  name: 'todo_write',
  readOnly: true,
  description:
    'Record a list of todos. Replace-whole-list semantics: every call replaces the entire todo list. ' +
    'Notifies the host if a listener is connected.',
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
      if (item.status === 'in_progress') {
        inProgressCount++
      }
    }

    if (inProgressCount > 1) {
      return { ok: false, error: 'at most one todo may have status in_progress' }
    }

    return { ok: true, args: { todos: r.todos } }
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
