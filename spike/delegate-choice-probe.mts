/**
 * The delegate measurement, redone — because the first one was rigged three ways and I did
 * not notice until it was pointed out.
 *
 * What the first probe (`delegate-live-probe.mts`) actually measured, and why 0/2 and 0/3
 * meant much less than I read into them:
 *
 *  1. `delegate` was registered LAST, 22nd of 22. This file's own comment says registration
 *     order is the order schemas reach the model, and records `csharp_nav` being moved out
 *     of exactly that position for exactly this reason.
 *  2. The workspace was THREE files. One `search_code` answers anything about it, so
 *     searching was not the model failing to delegate — it was the model being right.
 *  3. The system prompt was two lines I wrote for the probe, not the one the app builds.
 *
 * So this one uses the real prompt, the real repository as the workspace, jobs that cannot
 * be answered by one search, and `delegate` in a position where it is met before the tools
 * it competes with.
 *
 *   npx tsx spike/delegate-choice-probe.mts
 */
import { buildSystemPrompt } from '../core/src/agent/prompt.js'
import { delegateTool } from '../core/src/tools/delegate.js'
import { buildRegistry } from '../core/src/tools/default-set.js'

const BASE = process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080'
const ROOT = 'D:\\Projects\\LocalAgent\\local-private-code-app'

const registry = buildRegistry()
const base = registry.schemas().map((s) => ({ type: 'function', function: s.function }))
const del = {
  type: 'function',
  function: {
    name: delegateTool.name,
    description: delegateTool.description,
    parameters: delegateTool.parameters,
  },
}

/** Where `delegate` sits in the array, which is where the model meets it in the prompt. */
const PLACEMENTS: Record<string, unknown[]> = {
  last: [...base, del],
  // Beside the tools it competes with: the model reaching for "find out" should meet it
  // before it meets the reading tools, the same reasoning that moved `csharp_nav`.
  first: [del, ...base],
}

/** Jobs that genuinely cannot be answered by one search of a 177-file repository. */
const BIG = [
  'Before I change how compaction picks what to drop, I need to know everything that ' +
    'depends on the current behaviour — every caller, every test that pins it, and every ' +
    'place that assumes the transcript shape it produces. Work that out.',
  'Someone reported that the permission gate lets something through it should not. Find out ' +
    'how a tool call gets from the model to the gate and back, every branch of it, so I know ' +
    'where to look.',
  'I want to add a second kind of checkpoint. Map how the existing one works end to end — ' +
    'what is stored, where, who writes it, who reads it back, and what would break.',
]

/** Jobs a competent caller should just do itself. A tool that gets used for these has made
 * every turn slower for nothing. */
const SMALL = [
  'What is 2 + 2?',
  'Read core/src/workspace.ts and tell me what canonicalize does.',
  'How many files are in core/src/tools?',
]

const SYSTEM = buildSystemPrompt({ workspaceRoot: ROOT, mode: 'normal' })

async function firstCall(tools: unknown[], ask: string): Promise<string> {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: ask }],
      tools, temperature: 0.7, top_p: 0.8, max_tokens: 400, stream: false,
    }),
  })
  const body = await res.json() as {
    choices?: { message?: { tool_calls?: { function?: { name?: string } }[] } }[]
  }
  return body.choices?.[0]?.message?.tool_calls?.[0]?.function?.name ?? '(no call)'
}

for (const [where, tools] of Object.entries(PLACEMENTS)) {
  for (const [label, asks] of [['big  ', BIG], ['small', SMALL]] as const) {
    const picked: string[] = []
    for (const ask of asks) picked.push(await firstCall(tools, ask))
    const n = picked.filter((p) => p === 'delegate').length
    console.log(`  ${where.padEnd(6)} ${label}  delegate ${n}/${asks.length}   ${picked.join(', ')}`)
  }
}
