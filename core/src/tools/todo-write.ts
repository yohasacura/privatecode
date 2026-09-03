import type { Tool } from './types.js'
import type { TodoItem } from '../interaction.js'

export interface TodoWriteArgs {
  /** Close the plan and remove it. Exclusive with every other field. */
  clear?: boolean
  todos?: TodoItem[]
  complete?: number[]
  start?: number
  add?: { text: string; done_when?: string }[]
}

/**
 * The plan, and the two very different sizes of edit it takes.
 *
 * It had exactly one shape: send the whole list, every time. Writing a plan that way is
 * natural — you are writing all of it anyway. TICKING one box that way is not: it means
 * re-emitting five to twelve items with their text and their done_when, verbatim, or the
 * plan silently mutates. That is a thousand-odd characters of JSON, ten to twenty seconds
 * of generation on this machine, to record a single boolean.
 *
 * Reported by the owner: "the model stopped using the plan — it creates it, then never marks
 * anything and forgets about it." That is precisely the shape of the bill. Creation is a
 * whole-list write and happens; every update after it costs the same as creation and does
 * not. Nothing was wrong with the model's memory, and no amount of reminding it would have
 * helped: the harness was asking for a paragraph to record a tick.
 *
 * So the common edits are now index-sized. `complete: [2, 3]` is about ten tokens, which is
 * the size the action actually is.
 */
/** The ceiling both forms share. Enforced in the patch path too, or `add` becomes the way
 * around it and a plan can grow past the only form that could restructure it. */
const MAX_TODOS = 50

/** The plan as the model should see it: numbered, so the indices it is asked to send back
 * are the ones in front of it, and marked, so what is left is obvious at a glance. */
function renderPlan(todos: readonly TodoItem[]): string {
  const mark = (s: TodoItem['status']): string =>
    s === 'completed' ? 'x' : s === 'in_progress' ? '>' : ' '
  const lines = todos.map((t, i) => `${i + 1}. [${mark(t.status)}] ${t.text}`)
  const open = todos.filter((t) => t.status !== 'completed').length
  return `${lines.join('\n')}\n(${open} of ${todos.length} still open)`
}

/**
 * An index-sized edit applied to the plan, or the reason it could not be.
 *
 * Out-of-range indices are refused with the range spelled out rather than silently skipped:
 * a model that ticked step 7 of a five-step plan believes step 7 is done, and the quietest
 * possible failure here is the one that leaves the plan and the model disagreeing.
 */
function applyPatch(current: readonly TodoItem[], patch: TodoWriteArgs): TodoItem[] | string {
  if (current.length === 0) {
    return 'there is no plan yet — call TodoWrite with `todos` to create one first'
  }
  const touched = [...(patch.complete ?? []), ...(patch.start !== undefined ? [patch.start] : [])]
  const outside = touched.filter((n) => n > current.length)
  if (outside.length > 0) {
    return `no step ${outside.join(', ')} — the plan has ${current.length} steps, numbered 1 to ` +
      `${current.length}:\n${renderPlan(current)}`
  }
  const done = new Set(patch.complete ?? [])
  const wasInProgress = current.findIndex((t) => t.status === 'in_progress') + 1
  // MOVING FORWARD FINISHES WHAT YOU WERE ON, and this default is the difference between the
  // feature working and not. Measured live: told the plan and asked to bring it up to date,
  // the model reliably calls `start: 3` and says nothing about step 2 — it treats "I am on
  // the next one" as the whole message, because to a person it is. Demoting the old step to
  // pending (the first version here) threw that away and left the plan reading worse than
  // before the call: 1/6 correct. Completing it instead: 6/6.
  //
  // Only FORWARD, though. Naming an earlier step is going back to something, and finishing
  // the step you are abandoning is exactly the wrong reading of that.
  const advanced = patch.start !== undefined && wasInProgress > 0 && patch.start > wasInProgress
  const next = current.map((t, i) => {
    const n = i + 1
    // `start` wins over `complete` for the SAME step, and the order matters. The plan-focus
    // note tells the model to finish step N and say `complete: [N]`; doing exactly that and
    // also naming N as the one in progress used to leave N completed and the plan with no
    // cursor at all — after which the note picks the first pending step, which is BEHIND
    // where the work is, and points the model backwards. A step you say you are on is a step
    // you are on.
    if (patch.start === n) return { ...t, status: 'in_progress' as const }
    if (done.has(n)) return { ...t, status: 'completed' as const }
    if (n === wasInProgress && patch.start !== undefined) {
      return { ...t, status: advanced ? ('completed' as const) : ('pending' as const) }
    }
    return t
  })
  for (const step of patch.add ?? []) next.push({ ...step, status: 'pending' as const })
  // The same ceiling the whole-list form enforces. Without it `add` was the way round it:
  // a plan could walk past fifty a step at a time and then be un-editable by the only form
  // that can restructure it, because that one refuses more than fifty.
  if (next.length > MAX_TODOS) {
    return `that would make ${next.length} steps and the plan holds at most ${MAX_TODOS} — ` +
      'complete or restructure what is there first'
  }
  return next
}

export const todoWriteTool: Tool<TodoWriteArgs> = {
  name: 'TodoWrite',
  readOnly: true,
  description:
    'Record the plan for a multi-step task, and keep it current as you work.\n' +
    'To UPDATE as you go — the common case, and cheap — send only what changed: ' +
    '`complete: [2, 3]` marks those steps done, `start: 4` marks that one in progress, ' +
    '`add: [...]` appends steps the work uncovered. Indices are 1-based, as shown in the ' +
    'plan. Do not re-send the whole list to tick a box.\n' +
    'To CREATE or restructure the plan, send `todos` with the full list; that replaces it. ' +
    'Give each step a done_when: what will actually show it is finished.\n' +
    'The plan survives compaction and app restarts, so on a long task this is what ' +
    'remembers the shape of the work when the conversation no longer does.\n' +
    'To CLOSE it, send `clear: true` — when the task is done, or when it turned out not to ' +
    'need a plan. A finished plan left on screen is a card the person has to dismiss and a ' +
    'shape the next task has to work around. Send it with your final answer: once every ' +
    'step is done, closing the plan ends the turn on that answer. `complete: [n], clear: true` ' +
    'ticks the last step and closes in one call.',
  parameters: {
    type: 'object',
    properties: {
      clear: {
        type: 'boolean',
        description:
          'Close the plan and remove it. Use when the work it described is finished, or ' +
          'when it turned out not to need a plan at all. May come with `complete`/`start`/' +
          '`add` (they land first, then the plan closes), never with `todos`.',
      },
      complete: {
        type: 'array',
        items: { type: 'number' },
        description: '1-based indices of steps that are now finished. The cheap, usual update.',
      },
      start: {
        type: 'number',
        description: '1-based index of the step you are now on. Moving forward marks the ' +
          'step you were on as finished, so "start: 3" is the whole update when step 2 is done.',
      },
      add: {
        type: 'array',
        description: 'Steps this work uncovered, appended to the end as pending.',
        items: {
          type: 'object',
          required: ['text'],
          properties: {
            text: { type: 'string', description: 'One implementation step.' },
            done_when: { type: 'string', description: 'What will show it is finished.' },
          },
        },
      },
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
        description: '1–50 todo items. Only for creating or restructuring the plan.',
      },
    },
  },
  validate(raw) {
    const r = raw as Partial<TodoWriteArgs>
    // Closing, first and alone.
    //
    // There was no way to do it at all: `todos: []` is refused as "at least 1 item", and the
    // only two callers that could empty the plan are the window's own button and the
    // acceptance gate retiring a satisfied contract. So a model that had finished could
    // either tick every box and leave a completed card on screen, or replace the plan with a
    // different one — which is what the owner watched it do.
    //
    // Exclusive rather than merged with the rest, because "close this" and "edit this" are
    // different intentions and a call that did both would have to pick an order to apply
    // them in, and either order is a guess about what was meant.
    if (r?.clear === true) {
      if (r.todos !== undefined) {
        return {
          ok: false,
          error: 'clear closes the plan and cannot be combined with `todos` — send clear on its own',
        }
      }
      if (r.complete === undefined && r.start === undefined && r.add === undefined) {
        return { ok: true, args: { clear: true } }
      }
      // With ticks it falls through to the patch checks below, and closes AFTER they land.
      // "Finished the last step; close the plan" is one thought, and it was one call live —
      // `complete: [4], clear: true`, sent with the final answer — refused here as "cannot
      // be combined", then re-sent without the tick: a step spent on a rule. Only the order
      // could be in question, and a closed plan cannot be edited, so there is only one.
    }
    // The index-sized edits, checked first because they are the common call. Several may
    // arrive together — "finished 2, starting 3" is one thought and should be one call.
    if (r?.todos === undefined) {
      const patch: TodoWriteArgs = {}
      if (r?.complete !== undefined) {
        if (!Array.isArray(r.complete) || r.complete.some((n) => !Number.isInteger(n) || n < 1)) {
          return { ok: false, error: 'complete must be an array of 1-based step numbers' }
        }
        patch.complete = r.complete as number[]
      }
      if (r?.start !== undefined) {
        if (!Number.isInteger(r.start) || (r.start as number) < 1) {
          return { ok: false, error: 'start must be a 1-based step number' }
        }
        patch.start = r.start as number
      }
      if (r?.add !== undefined) {
        if (!Array.isArray(r.add)) return { ok: false, error: 'add must be an array of steps' }
        const added: { text: string; done_when?: string }[] = []
        for (let i = 0; i < r.add.length; i++) {
          const step = r.add[i] as { text?: unknown; done_when?: unknown } | undefined
          if (typeof step?.text !== 'string' || step.text.trim() === '') {
            return { ok: false, error: `add[${i}].text must be a non-empty string` }
          }
          added.push({
            text: step.text.trim().slice(0, 200),
            ...(typeof step.done_when === 'string' && step.done_when.trim() !== ''
              ? { done_when: step.done_when.trim().slice(0, 200) } : {}),
          })
        }
        patch.add = added
      }
      if (patch.complete === undefined && patch.start === undefined && patch.add === undefined) {
        return {
          ok: false,
          error: 'nothing to do: send `complete`/`start`/`add` to update the plan, or ' +
            '`todos` with the full list to create or restructure it',
        }
      }
      return { ok: true, args: r?.clear === true ? { ...patch, clear: true } : patch }
    }
    if (!Array.isArray(r?.todos)) {
      return { ok: false, error: 'todos must be an array' }
    }
    if (r.todos.length === 0) {
      return { ok: false, error: 'todos must have at least 1 item' }
    }
    if (r.todos.length > MAX_TODOS) {
      return { ok: false, error: `todos must have at most ${MAX_TODOS} items` }
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

    if (args.clear === true) {
      let before = ctx.todos.list()
      if (args.complete !== undefined || args.start !== undefined || args.add !== undefined) {
        // The ticks first: what closes is the plan as the model last described it.
        const applied = applyPatch(before, args)
        if (typeof applied === 'string') return { ok: false, content: applied }
        before = applied
      }
      const had = before.length
      const open = before.filter((t) => t.status !== 'completed').length
      ctx.todos.set([])
      ctx.interaction?.todosChanged?.(ctx.todos.list())
      return {
        ok: true,
        content: had === 0
          ? 'There was no plan to close.'
          : `Plan closed; ${had} ${had === 1 ? 'step is' : 'steps are'} gone.`,
        // Closing a plan with nothing left open is the last act of a task, and the model
        // performs it WITH its answer: watched live, the final summary and `clear` arrived
        // in one message, the loop ran the call and asked for another step, and the model
        // wrote the same summary and closed the same (now absent) plan three more times
        // before once sending the text alone. Saying so lets the loop end the turn on that
        // text — see `ToolResult.endsTurn`. A plan closed with steps still open is an
        // abandonment or a restructure, and the turn goes on.
        ...(open === 0 ? { endsTurn: true } : {}),
      }
    }

    if (args.todos === undefined) {
      const applied = applyPatch(ctx.todos.list(), args)
      if (typeof applied === 'string') return { ok: false, content: applied }
      ctx.todos.set(applied)
      ctx.interaction?.todosChanged?.(ctx.todos.list())
      // The whole plan comes back, numbered. The result of a call is prefix the model
      // reads on its next step, and this project's one measured law is that information
      // there routes it while instructions do not — so the cheapest moment to show what
      // the plan now says is the moment it changed.
      return { ok: true, content: renderPlan(applied) }
    }

    ctx.todos.set(args.todos)
    ctx.interaction?.todosChanged?.(ctx.todos.list())
    // The numbered plan, on the CREATE path too. This was the one branch that answered with
    // a count — "6 todos recorded, 1 in progress, 5 pending" — so the very first thing the
    // model saw after writing a plan was the one view that does not show the indices every
    // later update has to send back. It learned the numbering from the notes instead, one
    // nudge later than it needed to.
    return { ok: true, content: renderPlan(args.todos) }
  },
}
