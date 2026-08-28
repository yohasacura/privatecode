/**
 * Does cutting the system prompt in half make the remaining rules land harder?
 *
 * The instruction-stacking research says all-instruction compliance decays roughly as p^N,
 * and the shipped prompt carries ~14 standing imperatives. The owner's own read of it —
 * "задушено" — is the same claim in one word. So: the shipped prompt against a pruned one
 * that keeps only the measured-load-bearing rules, on three measurable behaviours:
 *
 *   1. delegate pickup on investigation-shaped jobs   (the rule that went 8/12 under load)
 *   2. false delegation on small look-ups             (the failure that would cancel a win)
 *   3. the English pin under a Russian ask            (a rule BOTH arms keep — if pruning
 *      helps, THIS is where it shows: same rule, less competition)
 *
 * What the pruned arm keeps, and why each line: identity (orientation), act-don't-ruminate
 * (the measured anti-runaway lever), the delegate first-move rule (measured 8/12), batching
 * (measured: without it multi-edit steps re-split), the English pin (owner's standing rule,
 * measured drift without it). Dropped: smallest-change, targeted-search, the three-way
 * English elaboration, the don't-re-check elaboration — none of them measured, all of them
 * competing.
 *
 *   npx tsx spike/pruned-prompt-probe.mts
 */
import { buildSystemPrompt } from '../core/src/agent/prompt.js'
import { buildRegistry } from '../core/src/tools/default-set.js'

const BASE = process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080'
const ROOT = 'D:\\Projects\\LocalAgent\\local-private-code-app'
const TRIALS = Number(process.env['TRIALS'] ?? 4)

const TOOLS = buildRegistry().schemas().map((s) => ({ type: 'function', function: s.function }))

const FULL = buildSystemPrompt({ workspaceRoot: ROOT, mode: 'normal', delegation: true })

const PRUNED = [
  `You are PrivateCode, a coding agent working in the local workspace ${ROOT}.`,
  '',
  'Work in small steps and look at each result before the next; never say something works',
  'unless a command you ran shows it. Decide and act — do not go over the same reasoning twice.',
  '',
  'When the request asks you to find out, map, trace or investigate something across the',
  'codebase, your FIRST call is delegate: hand the whole question to a worker and continue',
  'from its answer. Read files yourself for small, specific look-ups.',
  '',
  'You may call several independent tools in one step.',
  '',
  'Always reply in English, whatever language the user writes in; keep code, paths and',
  'command output exactly as they are.',
].join('\n')

console.log(`full prompt: ~${FULL.length} chars   pruned: ~${PRUNED.length} chars\n`)

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
  'What does MAX_ANSWER_CHARS equal in core/src/agent/subagent.ts?',
]
/** No tools needed, so the reply is prose — where the language pin either holds or does not. */
const RUSSIAN = [
  'Объясни своими словами, что такое чекпойнт в этом проекте и зачем он нужен. Не открывай файлы, просто расскажи.',
  'Расскажи в двух абзацах, как ты понимаешь разницу между режимами plan и autopilot. Файлы не читай.',
]

async function chat(system: string, ask: string, withTools: boolean): Promise<{ call: string; text: string }> {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'system', content: system }, { role: 'user', content: ask }],
      ...(withTools ? { tools: TOOLS } : {}),
      temperature: 0.7, top_p: 0.8, max_tokens: 500, stream: false,
    }),
  })
  const body = await res.json() as {
    choices?: { message?: { tool_calls?: { function?: { name?: string } }[]; content?: string } }[]
  }
  const m = body.choices?.[0]?.message
  return {
    call: m?.tool_calls?.[0]?.function?.name ?? '(no call)',
    text: m?.content ?? '',
  }
}

const hasCyrillic = (s: string): boolean => /[а-яА-ЯёЁ]/.test(s)

for (const [label, system] of [['FULL  ', FULL], ['PRUNED', PRUNED]] as const) {
  let bigDel = 0
  for (const ask of BIG) {
    for (let t = 0; t < TRIALS; t++) {
      if ((await chat(system, ask, true)).call === 'delegate') bigDel++
    }
  }
  let smallDel = 0
  for (const ask of SMALL) {
    if ((await chat(system, ask, true)).call === 'delegate') smallDel++
  }
  let english = 0
  let langTrials = 0
  for (const ask of RUSSIAN) {
    for (let t = 0; t < 2; t++) {
      const r = await chat(system, ask, false)
      langTrials++
      if (r.text.trim() !== '' && !hasCyrillic(r.text)) english++
    }
  }
  console.log(
    `${label}  delegate on big ${bigDel}/${BIG.length * TRIALS}   false on small ${smallDel}/${SMALL.length}` +
    `   English under Russian ask ${english}/${langTrials}`,
  )
}
