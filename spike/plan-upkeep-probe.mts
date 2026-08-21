/**
 * Does the model actually tick the plan now?
 *
 * The claim is that it stopped updating the plan because updating cost as much as writing
 * one: `todo_write` replaced the whole list, so recording a single finished step meant
 * re-emitting every step verbatim. The fix gives it an index-sized edit. That is a claim
 * about behaviour and only the real model can settle it, so this is an A/B — same
 * transcript, same nudge, only the tool's shape differs — over N trials each.
 *
 *   npx tsx spike/plan-upkeep-probe.mts [trials]
 */
import { LlamaClient } from '../core/src/llama/client.js'
import type { ChatMessage, ToolSchema } from '../core/src/llama/types.js'
import { buildRegistry } from '../core/src/tools/default-set.js'
import { todoWriteTool } from '../core/src/tools/todo-write.js'
import { TodoStore } from '../core/src/interaction.js'

const client = new LlamaClient({
  baseUrl: process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080',
  model: 'qwen',
})

const TRIALS = Number(process.argv[2] ?? 6)

const PLAN = [
  'Read InvoiceService.allocate and find the race',
  'Wrap the allocation in a transaction with a row lock',
  'Add a regression test that fails without the lock',
  'Run the suite and fix what it reports',
]

/** The whole-list-only tool, as it was before the change. */
const OLD_TOOL: ToolSchema = {
  type: 'function',
  function: {
    name: 'todo_write',
    description:
      'Record the plan for a multi-step task, and keep it current as you work. Every call ' +
      'replaces the whole list. It survives compaction and app restarts, so on a long task ' +
      'this is what remembers the shape of the work when the conversation no longer does. ' +
      'Give each step a done_when: what will actually show it is finished.',
    parameters: {
      type: 'object',
      required: ['todos'],
      properties: {
        todos: {
          type: 'array',
          description: '1-50 todo items.',
          items: {
            type: 'object',
            required: ['text', 'status'],
            properties: {
              text: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              done_when: { type: 'string' },
            },
          },
        },
      },
    },
  },
}

const NEW_TOOL: ToolSchema = {
  type: 'function',
  function: {
    name: todoWriteTool.name,
    description: todoWriteTool.description,
    parameters: todoWriteTool.parameters,
  },
}

function planLines(): string {
  return PLAN.map((t, i) => `  ${i + 1}. [${i === 0 ? 'x' : i === 1 ? '>' : ' '}] ${t}`).join('\n')
}

/** A transcript that looks like the middle of the task: the plan exists, step 1 is done,
 * step 2 has just been finished in the code, and the upkeep note has landed — unless
 * `nudged` is false, which is the state the bug was actually reported in: nobody asks, the
 * model simply works and never volunteers an update. */
function transcript(cheap: boolean, nudged = true): ChatMessage[] {
  const nudge = cheap
    ? `[Plan upkeep: 3 files written since the plan was last updated.\n${planLines()}\n` +
      'Bring it up to date now — `todo_write` with `complete: [n]` for the steps that are ' +
      'finished, `start: n` for the one you are on, `add` for anything this work uncovered. ' +
      'Send only what changed; do not re-send the list. The plan is what survives ' +
      'compaction; a stale plan is lost work.]'
    : '[Plan upkeep: 3 files written since the plan was last updated. Call todo_write NOW — ' +
      'mark finished steps completed, add steps this work uncovered. The plan is what ' +
      'survives compaction; a stale plan is lost work.]'
  return [
    {
      role: 'system',
      content:
        'You are a coding agent working in a TypeScript repository. Work in small steps and ' +
        'call one tool at a time.',
    },
    { role: 'user', content: 'Invoice numbers skip values under load. Find the race and fix it properly.' },
    {
      role: 'assistant',
      content:
        'I read src/invoice.ts. `allocate` reads the counter and writes it back in two ' +
        'separate queries with no transaction, so two concurrent callers get the same value.',
    },
    {
      role: 'assistant',
      content:
        'I have wrapped the allocation in db.transaction with `select ... for update`, and ' +
        'updated the two call sites in BillingController. src/invoice.ts, ' +
        'src/billing-controller.ts and src/db.ts are written.',
    },
    ...(nudged
      ? [{ role: 'user' as const, content: nudge }]
      : [{ role: 'user' as const, content: '[Continue.]' }]),
  ]
}

/**
 * What the plan says after the call, by running the REAL tool against a real store.
 *
 * The first version of this re-implemented the patch logic here, and then a fix to the
 * shipped code changed nothing in the numbers — because the probe was measuring its own
 * copy. A probe that simulates the thing it is testing measures the simulation.
 *
 * Step 2 is finished in the transcript, so a correct update leaves 1 and 2 done and 3 in
 * progress.
 */
async function statusesAfter(argsJson: string): Promise<string> {
  const store = new TodoStore()
  store.set(PLAN.map((text, i) => ({
    text,
    status: i === 0 ? 'completed' as const : i === 1 ? 'in_progress' as const : 'pending' as const,
  })))
  const v = todoWriteTool.validate(JSON.parse(argsJson))
  if (!v.ok) return `refused: ${v.error.slice(0, 40)}`
  const r = await todoWriteTool.execute(v.args, { todos: store } as never)
  if (!r.ok) return `refused: ${r.content.slice(0, 40)}`
  const short = (s: string): string => (s === 'completed' ? 'x' : s === 'in_progress' ? '>' : '.')
  const line = store.list().map((t) => short(t.status)).join('')
  return `${line}  ${line.startsWith('xx>') ? 'CORRECT' : 'step 2 not closed'}`
}

interface Outcome { called: boolean; cheap: boolean; chars: number; secs: number; what: string }

async function trial(cheap: boolean, nudged = true): Promise<Outcome> {
  const registry = buildRegistry()
  const schemas = registry.schemas().map((s) =>
    s.function.name === 'todo_write' ? (cheap ? NEW_TOOL : OLD_TOOL) : s)
  const started = Date.now()
  const r = await client.chat({
    messages: transcript(cheap, nudged),
    tools: schemas,
    maxTokens: 3_000,
    disableThinking: true,
  })
  const secs = (Date.now() - started) / 1000
  const call = r.message.tool_calls?.find((c) => c.function.name === 'todo_write')
  if (!call) {
    const other = r.message.tool_calls?.[0]?.function.name
    return { called: false, cheap, chars: 0, secs, what: other ? `called ${other}` : 'no tool call' }
  }
  const args = call.function.arguments
  let shape = 'todos (whole list)'
  try {
    const parsed = JSON.parse(args)
    if (parsed.todos === undefined) {
      shape = `complete=${JSON.stringify(parsed.complete ?? null)} start=${parsed.start ?? '-'}`
    }
  } catch { shape = 'unparseable' }
  return { called: true, cheap, chars: args.length, secs, what: `${shape}  ->  ${await statusesAfter(args)}` }
}

async function arm(label: string, cheap: boolean, nudged: boolean): Promise<void> {
  const out: Outcome[] = []
  for (let i = 0; i < TRIALS; i++) out.push(await trial(cheap, nudged))
  const hits = out.filter((o) => o.called)
  const correct = out.filter((o) => o.what.includes('CORRECT'))
  const avgChars = hits.length > 0 ? Math.round(hits.reduce((a, o) => a + o.chars, 0) / hits.length) : 0
  const avgSecs = (out.reduce((a, o) => a + o.secs, 0) / out.length).toFixed(1)
  console.log(`\n=== ${label}`)
  for (const o of out) console.log(`   ${o.called ? 'updated ' : 'SKIPPED '} ${o.what}${o.chars ? `  (${o.chars} ch)` : ''}`)
  console.log(`   updated ${hits.length}/${TRIALS}, CORRECT ${correct.length}/${TRIALS}, mean ${avgChars} ch, ${avgSecs}s`)
}

async function main(): Promise<void> {
  // The reported bug lives in the un-nudged arms: nobody asks, and the model just works.
  await arm('OLD, no nudge', false, false)
  await arm('NEW, no nudge', true, false)
  await arm('OLD + nudge', false, true)
  await arm('NEW + nudge', true, true)
}

main().catch((e) => { console.error(e); process.exit(1) })
