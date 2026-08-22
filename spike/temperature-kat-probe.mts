/**
 * Re-running the temperature question against the model that is actually loaded.
 *
 * `llama/sampling.ts` pins temperature 0.6 and says "Qwen3.6's documented sampling profile,
 * do not deviate" — measured in `docs/SPIKE-TEMPERATURE.md` against Qwen3.6-35B-A3B. The
 * server now serves KAT-Coder-V2.5-Dev, whose own GGUF metadata carries
 * `general.sampling.temp = 1` (top_k 20 and top_p 0.95 are unchanged). A number pinned to a
 * different model is exactly the kind of thing that quietly stops being right.
 *
 * Same method as the original spike: one fixed hard task, `tool_choice: 'required'`, a full
 * tool array so the grammar pressure is realistic, and the arms differ only in temperature.
 * What is counted is what the agent loop actually needs — a call that arrives, names the
 * right tool, and carries a SEARCH string that is byte-exact in the file.
 *
 *   npx tsx spike/temperature-kat-probe.mts
 */
const BASE = process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080'
const RUNS = 6
const ARMS = [0.6, 1.0]

const FILE = String.raw`using System.Text.RegularExpressions;

namespace Billing.Services
{
    public sealed class InvoiceFormatter
    {
        // Matches "INV-000123" and nothing else. Do NOT relax this.
        private static readonly Regex Pattern = new(@"^INV-\d{6}$", RegexOptions.Compiled);

        public string Format(int n) => $"INV-{n:D6}";

        public bool IsValid(string s) => Pattern.IsMatch(s);

        public string Describe(string s)
        {
            var quoted = @"a ""quoted"" literal with \ backslashes";
            return IsValid(s) ? $"{s} is valid ({quoted})" : $"{s} is not valid";
        }
    }
}`

const TASK =
  'In src/InvoiceFormatter.cs, change Format so the numeric part is padded to EIGHT digits ' +
  'instead of six, and update the regex so it accepts exactly eight digits. Use edit_file ' +
  'with an exact SEARCH string copied from the file. Here is the file:\n\n' +
  '```csharp\n' + FILE + '\n```'

const tool = (name: string, description: string, props: Record<string, unknown>) => ({
  type: 'function' as const,
  function: { name, description, parameters: { type: 'object', required: Object.keys(props), properties: props } },
})
const S = (d: string) => ({ type: 'string', description: d })

const TOOLS = [
  tool('read_file', 'Read a file with line numbers.', { path: S('Path') }),
  tool('list_dir', 'List a directory.', { path: S('Path') }),
  tool('find_files', 'Find files by glob.', { glob: S('Glob') }),
  tool('search_code', 'Search with ripgrep.', { pattern: S('Regex') }),
  tool('symbol_outline', 'Tree-sitter outline of a file.', { path: S('Path') }),
  tool('git_status', 'Read-only git.', { action: S('Which') }),
  tool('edit_file', 'Apply a SEARCH/REPLACE edit to one file.', {
    path: S('Path'),
    search_text: S('The exact text to find, copied byte for byte from the file'),
    replace_text: S('What to put in its place'),
  }),
  tool('write_file', 'Write a whole file.', { path: S('Path'), content: S('Contents') }),
  tool('move_file', 'Move or rename.', { from: S('From'), to: S('To') }),
  tool('delete_file', 'Delete a file.', { path: S('Path') }),
  tool('run_command', 'Run a PowerShell command.', { command: S('Command') }),
  tool('background_task', 'Start/poll/stop a process.', { action: S('Which') }),
  tool('browser', 'Control a browser over CDP.', { action: S('Which') }),
  tool('todo_write', 'Write the visible plan.', { todos: S('Items') }),
  tool('ask_user', 'Ask the user a question.', { question: S('Question') }),
]

const SYSTEM =
  'You are PrivateCode, a coding agent working in the local workspace D:\\Projects\\Demo.\n\n' +
  'Work in small steps. Look at the result before deciding the next step.\n\n' +
  'Do not deliberate at length, and do not re-check a decision you have already made — ' +
  'if you notice yourself going over the same reasoning twice, stop and call the tool.\n' +
  'Prefer the smallest change that satisfies the request.'

interface Run {
  ok: boolean
  finish: string
  thinkTokens: number
  seconds: number
  called: string | null
  exact: boolean
  emptyArg: boolean
}

async function once(temperature: number): Promise<Run> {
  const started = performance.now()
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'kat',
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: TASK }],
      tools: TOOLS,
      tool_choice: 'required',
      max_tokens: 4000,
      stream: false,
      temperature,
      top_p: 0.95,
      top_k: 20,
    }),
  })
  const seconds = (performance.now() - started) / 1000
  const j = await res.json() as {
    choices?: { finish_reason?: string; message?: {
      content?: string | null; reasoning_content?: string | null
      tool_calls?: { function: { name: string; arguments: string } }[] } }[]
    usage?: { completion_tokens?: number }
  }
  const choice = j.choices?.[0]
  const msg = choice?.message
  const think = msg?.reasoning_content ?? ''
  const call = msg?.tool_calls?.[0]
  let exact = false
  let emptyArg = false
  if (call) {
    try {
      const args = JSON.parse(call.function.arguments) as { search_text?: string }
      const search = args.search_text ?? ''
      emptyArg = search.trim() === ''
      exact = search.trim() !== '' && FILE.includes(search)
    } catch { emptyArg = true }
  }
  return {
    ok: call !== undefined && call.function.name === 'edit_file' && exact,
    finish: choice?.finish_reason ?? '?',
    // Tokens are not reported per-channel, so thinking is measured in characters and
    // converted at the ~3.6 chars/token this tokenizer runs at on English prose.
    thinkTokens: Math.round(think.length / 3.6),
    seconds,
    called: call?.function.name ?? null,
    exact,
    emptyArg,
  }
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2
}

console.log(`server ${BASE}  |  ${RUNS} runs per arm  |  same task, tool_choice=required\n`)

const summary: { temp: number; usable: number; medSec: number; maxSec: number; medThink: number; maxThink: number; truncated: number; noCall: number }[] = []

for (const temp of ARMS) {
  console.log(`--- temperature ${temp}${temp === 0.6 ? '  (what the app pins today)' : "  (this model's own metadata)"} ---`)
  const runs: Run[] = []
  for (let i = 0; i < RUNS; i++) {
    const r = await once(temp)
    runs.push(r)
    console.log(
      `  run ${i + 1}: think ${String(r.thinkTokens).padStart(4)} tok, ${r.seconds.toFixed(1).padStart(5)} s, ` +
      `finish=${(r.finish).padEnd(10)} call=${(r.called ?? 'NONE').padEnd(10)} ` +
      `${r.ok ? 'usable' : r.emptyArg ? 'EMPTY ARG' : r.exact ? '-' : r.called ? 'ANCHOR MISS' : 'NO CALL'}`)
  }
  const usable = runs.filter((r) => r.ok).length
  const s = {
    temp,
    usable,
    medSec: median(runs.map((r) => r.seconds)),
    maxSec: Math.max(...runs.map((r) => r.seconds)),
    medThink: median(runs.map((r) => r.thinkTokens)),
    maxThink: Math.max(...runs.map((r) => r.thinkTokens)),
    truncated: runs.filter((r) => r.finish === 'length').length,
    noCall: runs.filter((r) => r.called === null).length,
  }
  summary.push(s)
  console.log(`  => usable ${usable}/${RUNS}, wall median ${s.medSec.toFixed(1)} s / max ${s.maxSec.toFixed(1)} s, ` +
    `thinking median ${s.medThink} / max ${s.maxThink} tok, truncated ${s.truncated}, no call ${s.noCall}\n`)
}

console.log('--- verdict ---')
for (const s of summary) {
  console.log(`  temp ${s.temp}: ${s.usable}/${RUNS} usable, median ${s.medSec.toFixed(1)} s, ` +
    `median thinking ${s.medThink} tok, ${s.truncated} truncated`)
}
