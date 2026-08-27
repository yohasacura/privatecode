/**
 * Can the model be made UNABLE to write `&&`, rather than merely told not to?
 *
 * The report: the model keeps writing `npm install && npm test`, and the shell every command
 * runs in is Windows PowerShell 5.1, which has no `&&` at all — it is a parse error, so
 * nothing runs. The owner's ask is explicit: understand it before generating, not fail and
 * retry.
 *
 * This project's own measured law says which fixes are worth trying. From
 * docs/SPIKE-KAT-CODER.md: **instructions do not route behaviour (0/703); structure does.**
 * Three paragraphs of correct, emphatic prose lost to one habit. So the question is not
 * whether a better description helps — it is whether a SAMPLER constraint can make `&&`
 * inexpressible.
 *
 * Three arms, same prompt, same tools, and the prompt is chosen to invite the habit:
 *
 *   A  bare schema                    the baseline: how often does it reach for `&&`
 *   B  schema + `pattern` on command  does llama.cpp compile it into the tool grammar
 *   C  bare schema + prose in the     the thing the law predicts will not work, measured
 *      tool description               so the claim is this project's own rather than folklore
 *
 *   npx tsx spike/operator-grammar-probe.mts
 */
const BASE = process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080'
const TRIALS = Number(process.env['TRIALS'] ?? 8)

/** Forbids `&&` and `||` anywhere in the string. Deliberately blunt: a pattern that tried to
 * allow them inside quotes would be a regex parsing a shell, which is the thing not to do. */
const NO_CHAIN = '^(?:[^&|]|&(?!&)|\\|(?!\\|))*$'

interface Arm { label: string; describe: string; pattern?: string }

const ARMS: Arm[] = [
  { label: 'A bare', describe: 'Run a command in the workspace and return its output and exit code.' },
  { label: 'B pattern', describe: 'Run a command in the workspace and return its output and exit code.', pattern: NO_CHAIN },
  {
    label: 'C prose',
    describe:
      'Run a command in the workspace and return its output and exit code. The shell is ' +
      'Windows PowerShell 5.1, which has NO `&&` and NO `||` — they are a parse error and ' +
      'nothing runs. Separate statements with `;`.',
  },
]

function toolFor(arm: Arm): unknown {
  const command: Record<string, unknown> = {
    type: 'string',
    description: 'The command line to run.',
  }
  if (arm.pattern !== undefined) command['pattern'] = arm.pattern
  return {
    type: 'function',
    function: {
      name: 'run_command',
      description: arm.describe,
      parameters: { type: 'object', required: ['command'], properties: { command } },
    },
  }
}

const ASK =
  'Install the npm dependencies and then run the test suite. Do it in ONE run_command call.'

async function trial(arm: Arm): Promise<string | null> {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: 'You are a coding agent working in a local workspace.' },
        { role: 'user', content: ASK },
      ],
      tools: [toolFor(arm)],
      // Sampling as the app runs it, so the count is about the arm and not about a
      // temperature this harness never uses.
      temperature: 0.7,
      top_p: 0.8,
      max_tokens: 300,
      stream: false,
    }),
  })
  if (!res.ok) return `HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`
  const body = await res.json() as {
    choices?: { message?: { tool_calls?: { function?: { arguments?: string } }[]; content?: string } }[]
  }
  const call = body.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments
  if (call === undefined) return `(no tool call) ${(body.choices?.[0]?.message?.content ?? '').slice(0, 90)}`
  try {
    return String((JSON.parse(call) as { command?: unknown }).command ?? call)
  } catch {
    return call
  }
}

for (const arm of ARMS) {
  const seen: string[] = []
  let chained = 0
  let refused = 0
  for (let i = 0; i < TRIALS; i++) {
    const got = await trial(arm)
    if (got === null) continue
    if (got.startsWith('HTTP ')) { refused++; seen.push(got); continue }
    if (/&&|\|\|/.test(got)) chained++
    seen.push(got.replace(/\s+/g, ' ').slice(0, 76))
  }
  console.log(`\n${arm.label}  —  ${chained}/${TRIALS} used && or ||${refused ? `, ${refused} rejected by the server` : ''}`)
  for (const s of seen) console.log(`    ${s}`)
}

/**
 * The recipe the law actually prescribes: make the wrong thing INEXPRESSIBLE.
 *
 * A pattern was the cheap version and arm B shows this build ignores it. The other way to
 * remove a choice is to remove the place it is written: if the argument is a LIST of
 * commands, there is no separator to pick, because the separator is JSON array structure.
 * Whether the model will actually fill a list instead of jamming one string into it is the
 * question, and it is a question for the model, not for reasoning.
 */
const LIST_ARMS: { label: string; describe: string }[] = [
  { label: 'D list, bare', describe: 'Run one or more commands in the workspace, in order, stopping at the first failure.' },
  {
    label: 'E list + one line',
    describe:
      'Run one or more commands in the workspace, in order, stopping at the first failure. ' +
      'One command per array entry — do not join them with `&&`, `||` or `;`.',
  },
]

function listTool(describe: string): unknown {
  return {
    type: 'function',
    function: {
      name: 'run_command',
      description: describe,
      parameters: {
        type: 'object',
        required: ['commands'],
        properties: {
          commands: {
            type: 'array',
            items: { type: 'string' },
            description: 'The command lines to run, in order.',
          },
        },
      },
    },
  }
}

async function listTrial(describe: string): Promise<string> {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: 'You are a coding agent working in a local workspace.' },
        { role: 'user', content: ASK },
      ],
      tools: [listTool(describe)],
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
  if (call === undefined) return `(no tool call) ${(body.choices?.[0]?.message?.content ?? '').slice(0, 70)}`
  return call.replace(/\s+/g, ' ').slice(0, 90)
}

for (const arm of LIST_ARMS) {
  const seen: string[] = []
  let chained = 0
  for (let i = 0; i < TRIALS; i++) {
    const got = await listTrial(arm.describe)
    if (/&&|\|\|/.test(got)) chained++
    seen.push(got)
  }
  console.log(`\n${arm.label}  —  ${chained}/${TRIALS} still contained && or ||`)
  for (const s of seen) console.log(`    ${s}`)
}
