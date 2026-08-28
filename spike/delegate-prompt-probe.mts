/**
 * Which WORDING of the system prompt makes the model reach for a worker?
 *
 * The owner's push, and it is a fair one: every failed measurement so far tested either NO
 * prompt support or one weak line — "a question that needs several files read goes to a
 * worker", which asks for a judgement ("needs several files"?) and offers no rule about
 * WHEN. Meanwhile the shipped prompt actively instructs the opposite behaviour: "Work in
 * small steps. Look at the result before deciding the next step" is a directive to read
 * incrementally yourself.
 *
 * The 0/703 law is about one instruction failing to override one habit. It is not a theorem
 * that all prose is inert — naming the shell in a tool description moved `&&` from 14/14 to
 * 3/14 the same week. So: several framings, measured.
 *
 *   A  bare            the shipped prompt — known 0/3
 *   B  judgement       my old weak line, as the control
 *   C  first-move      a RULE about the first call for investigation-shaped jobs
 *   D  orchestrator    a role: you coordinate, workers read
 *   E  cost            the reason, stated as a mechanic: reads you keep poison your context
 *
 * Big jobs should delegate; small jobs must not. A framing that delegates "read this file"
 * has made every turn slower and loses even if it aces the big jobs.
 *
 *   npx tsx spike/delegate-prompt-probe.mts
 */
import { buildSystemPrompt } from '../core/src/agent/prompt.js'
import { delegateTool } from '../core/src/tools/delegate.js'
import { buildRegistry } from '../core/src/tools/default-set.js'

const BASE = process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080'
const ROOT = 'D:\\Projects\\LocalAgent\\local-private-code-app'
const TRIALS = Number(process.env['TRIALS'] ?? 2)

const del = {
  type: 'function',
  function: {
    name: delegateTool.name,
    description: delegateTool.description,
    parameters: delegateTool.parameters,
  },
}
const TOOLS = [del, ...buildRegistry().schemas().map((s) => ({ type: 'function', function: s.function }))]

const SHIPPED = buildSystemPrompt({ workspaceRoot: ROOT, mode: 'normal' })

const FRAMINGS: Record<string, string> = {
  'A bare': SHIPPED,
  'B judgement': `${SHIPPED}\n\nA question that needs several files read before it can be answered goes to a worker: call delegate with the whole question.`,
  'C first-move':
    `${SHIPPED}\n\nWhen the request asks you to find out, map, trace or investigate something across ` +
    'the codebase, your FIRST call is delegate — hand the whole question to an investigate ' +
    'worker and continue from its answer. Read files yourself only for small, specific ' +
    'look-ups: one named file, one symbol, one quick check.',
  'D orchestrator':
    `${SHIPPED}\n\nYou coordinate; workers read. For any job whose answer is spread across several ` +
    'files, you do not open them yourself — you call delegate and put the whole question to ' +
    'a worker. Your own reads are for small, specific look-ups only.',
  'E cost':
    `${SHIPPED}\n\nEvery file you read stays in this conversation forever and crowds out later work. ` +
    'A worker reads in its own conversation and sends back only the answer. So for anything ' +
    'that means reading more than a couple of files, call delegate instead of reading — the ' +
    'answer arrives, the reading does not.',
}

const BIG = [
  'Before I change how compaction picks what to drop, find out everything that depends on ' +
    'its current behaviour — every caller, every test that pins it, and the transcript ' +
    'shape it produces.',
  'Map how a tool call travels from the model to the permission gate and back, every ' +
    'branch of it, so I know where to look.',
  'I want to add a second kind of checkpoint. Work out how the existing one works end to ' +
    'end — what is stored, where, who writes it, who reads it back.',
]
const SMALL = [
  'Read core/src/workspace.ts and tell me what canonicalize does.',
  'How many files are in core/src/tools?',
  'What does the constant MAX_ANSWER_CHARS equal in core/src/agent/subagent.ts?',
]

async function firstCall(system: string, ask: string): Promise<string> {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'system', content: system }, { role: 'user', content: ask }],
      tools: TOOLS, temperature: 0.7, top_p: 0.8, max_tokens: 300, stream: false,
    }),
  })
  const body = await res.json() as {
    choices?: { message?: { tool_calls?: { function?: { name?: string } }[] } }[]
  }
  return body.choices?.[0]?.message?.tool_calls?.[0]?.function?.name ?? '(no call)'
}

for (const [label, system] of Object.entries(FRAMINGS)) {
  let bigDel = 0
  let smallDel = 0
  const picks: string[] = []
  for (const ask of BIG) {
    for (let t = 0; t < TRIALS; t++) {
      const got = await firstCall(system, ask)
      if (got === 'delegate') bigDel++
      picks.push(got)
    }
  }
  for (const ask of SMALL) {
    const got = await firstCall(system, ask)
    if (got === 'delegate') smallDel++
  }
  console.log(
    `  ${label.padEnd(15)} big ${bigDel}/${BIG.length * TRIALS}   small ${smallDel}/${SMALL.length}` +
    `   (${picks.join(', ')})`,
  )
}
