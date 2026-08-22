/**
 * Can this build be made to call ONE named tool out of a larger, stable tools array?
 *
 * That is the hinge of the prefix fix. The gates currently guarantee structure by sending a
 * one-tool array with `tool_choice: 'required'` — which is exactly what voids the prompt
 * cache, because the tool block renders at the very front of the prompt. Keeping the
 * session's array stable and naming the wanted function instead would make the whole gate a
 * pure append. It only works if the server actually CONSTRAINS to the named function.
 *
 *   npx tsx spike/tool-choice-probe.mts
 */
const BASE = process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080'
const TRIALS = 5

const t = (name: string, description: string, prop: string) => ({
  type: 'function' as const,
  function: {
    name,
    description,
    parameters: { type: 'object', required: [prop], properties: { [prop]: { type: 'string', description: prop } } },
  },
})

const READ = t('read_file', 'Read a file with line numbers.', 'path')
const SEARCH = t('search_code', 'Search the workspace with ripgrep.', 'pattern')
const ACCEPT = t('report_acceptance', 'Report, criterion by criterion, whether the contract is met.', 'items')

async function ask(
  label: string, tools: unknown[], toolChoice: unknown, prompt: string,
): Promise<void> {
  const names: string[] = []
  let refusal = ''
  for (let i = 0; i < TRIALS; i++) {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'kat',
        messages: [{ role: 'user', content: prompt }],
        tools,
        tool_choice: toolChoice,
        max_tokens: 300,
        stream: false,
        temperature: 0.6, top_p: 0.95, top_k: 20,
        chat_template_kwargs: { enable_thinking: false },
      }),
    })
    const j = await res.json() as {
      choices?: { message?: { tool_calls?: { function: { name: string } }[]; content?: string } }[]
      error?: { message?: string }
    }
    if (!res.ok) { refusal = j.error?.message ?? JSON.stringify(j).slice(0, 200); break }
    const called = j.choices?.[0]?.message?.tool_calls?.map((c) => c.function.name) ?? []
    names.push(called.length === 0 ? '(no call)' : called.join('+'))
  }
  if (refusal) { console.log(`${label.padEnd(52)} REJECTED: ${refusal.slice(0, 120)}`); return }
  const tally = new Map<string, number>()
  for (const n of names) tally.set(n, (tally.get(n) ?? 0) + 1)
  const summary = [...tally.entries()].map(([n, c]) => `${n} x${c}`).join(', ')
  console.log(`${label.padEnd(52)} ${summary}`)
}

console.log(`server ${BASE}, ${TRIALS} trials each\n`)

const NEUTRAL = 'The task is finished. Do what you are supposed to do next.'
const INVITING = 'Read the file store0.ts and tell me what it does.'

console.log('--- the shape the gates use today (one tool, required) ---')
await ask('[ACCEPT] + required, neutral prompt', [ACCEPT], 'required', NEUTRAL)
await ask('[ACCEPT] + required, prompt inviting a read', [ACCEPT], 'required', INVITING)

console.log('\n--- the shape the prefix fix needs (stable array, named choice) ---')
await ask('[READ,SEARCH,ACCEPT] + named ACCEPT, neutral', [READ, SEARCH, ACCEPT],
  { type: 'function', function: { name: 'report_acceptance' } }, NEUTRAL)
await ask('[READ,SEARCH,ACCEPT] + named ACCEPT, inviting', [READ, SEARCH, ACCEPT],
  { type: 'function', function: { name: 'report_acceptance' } }, INVITING)

console.log('\n--- controls ---')
await ask('[READ,SEARCH,ACCEPT] + required, inviting', [READ, SEARCH, ACCEPT], 'required', INVITING)
await ask('[READ,SEARCH,ACCEPT] + auto, inviting', [READ, SEARCH, ACCEPT], 'auto', INVITING)
