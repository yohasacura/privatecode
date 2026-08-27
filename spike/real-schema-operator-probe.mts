/**
 * The same question as `operator-grammar-probe.mts`, but against the schema the app actually
 * ships — not a synthetic one written to make a point.
 *
 * The earlier probe compared shapes in the abstract and found the list wins 0/14 against
 * 14/14. This one imports `runCommandTool` itself, so what is measured is the tool as it will
 * reach the model: its real description, its real `cwd` and `timeout_seconds` properties
 * beside the list, and the app's own sampling.
 *
 *   npx tsx spike/real-schema-operator-probe.mts
 */
import { runCommandTool } from '../core/src/tools/run-command.js'

const BASE = process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080'
const TRIALS = Number(process.env['TRIALS'] ?? 12)

const TOOL = {
  type: 'function',
  function: {
    name: runCommandTool.name,
    description: runCommandTool.description,
    parameters: runCommandTool.parameters,
  },
}

/** Three asks that each invite chaining in a different way. */
const ASKS = [
  'Install the npm dependencies and then run the test suite. One run_command call.',
  'Build the project and, if that works, run the tests. One run_command call.',
  'Restore, build and test the solution in one go.',
]

async function trial(ask: string): Promise<string> {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: 'You are a coding agent working in a local workspace.' },
        { role: 'user', content: ask },
      ],
      tools: [TOOL],
      temperature: 0.7,
      top_p: 0.8,
      max_tokens: 300,
      stream: false,
    }),
  })
  if (!res.ok) return `HTTP ${res.status}`
  const body = await res.json() as {
    choices?: { message?: { tool_calls?: { function?: { arguments?: string } }[]; content?: string } }[]
  }
  const call = body.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments
  if (call === undefined) return `(no tool call) ${(body.choices?.[0]?.message?.content ?? '').slice(0, 60)}`
  return call.replace(/\s+/g, ' ')
}

let chained = 0
let valid = 0
let total = 0
for (const ask of ASKS) {
  console.log(`\n${ask}`)
  for (let i = 0; i < Math.ceil(TRIALS / ASKS.length); i++) {
    const got = await trial(ask)
    total++
    if (/&&|\|\|/.test(got)) chained++
    // Also asked: does what it sends actually VALIDATE? A shape the model fills wrongly is
    // no better than an operator it cannot use.
    try {
      if (runCommandTool.validate(JSON.parse(got)).ok) valid++
    } catch { /* not JSON at all */ }
    console.log(`    ${got.slice(0, 92)}`)
  }
}
console.log(`\n${chained}/${total} contained && or ||`)
console.log(`${valid}/${total} validated as real arguments`)
