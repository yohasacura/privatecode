/**
 * Does it delegate MID-TURN, which is the only place delegating makes sense?
 *
 * Every earlier probe measured the FIRST call of a cold turn, and read 0/3 as "the model
 * will not delegate". That was the wrong moment to look. Step one of any investigation is a
 * search — correctly — and a caller that delegated before it knew what it was looking at
 * would be doing something silly. Delegation pays several steps in, when the reading has
 * branched and one branch is a whole job of its own.
 *
 * So this runs a REAL turn — the Agent, this repository, `delegate` in the registry — and
 * asks what it reached for across the whole turn rather than at the start of one.
 *
 *   npx tsx spike/delegate-inturn-probe.mts
 */
import { Agent } from '../core/src/agent/loop.js'
import { LlamaClient } from '../core/src/llama/client.js'
import { runSubAgent, ROLES } from '../core/src/agent/subagent.js'
import { createToolset } from '../core/src/tools/default-set.js'
import { Transcript } from '../core/src/transcript/transcript.js'
import { Workspace } from '../core/src/workspace.js'

const ROOT = 'D:\\Projects\\LocalAgent\\local-private-code-app'
const client = new LlamaClient({
  baseUrl: process.env['LLAMA_URL'] ?? 'http://127.0.0.1:8080',
  model: 'qwen',
})

// No manual register any more: `delegate` ships in the default set now, which is itself
// part of what this probe verifies — the prompt paragraph keys off that registration.
const toolset = createToolset({ workspaceRoot: ROOT })
const workspace = new Workspace(ROOT)

/** Jobs whose reading genuinely branches: answering needs several independent threads. */
const JOBS = [
  'I am about to change how compaction decides what to drop. Before I touch it, I need ' +
    'three things: every caller of it, every test that pins its current behaviour, and ' +
    'what the transcript looks like on the far side of a swap. Find all three out.',
  'Map how a tool call travels from the model to the permission gate and back, and ' +
    'separately map what the checkpoint system stores and who reads it. I need both before ' +
    'I can plan a change that touches them together.',
]

for (const job of JOBS) {
  const calls: string[] = []
  const transcript = new Transcript()
  const agent = new Agent({
    client,
    registry: toolset.registry,
    context: {
      workspace,
      reads: toolset.reads,
      // The real thing, so a delegate call actually runs a worker rather than reporting that
      // none is available — the reply it gets back is part of what it decides from next.
      delegate: async (role, task, sig) => {
        const found = ROLES.find((r) => r.name === role)
        if (!found) return { role, text: '', steps: 0, ms: 0, problem: 'no such role' }
        return await runSubAgent(
          { client, registry: toolset.registry, context: { workspace, reads: toolset.reads } },
          found, task, sig,
        )
      },
    },
    transcript,
    // NOT plan mode, and the first two runs of this probe were invalidated by exactly
    // that: plan mode intersects the tool list with the registry's read-only names, and
    // `delegate` is deliberately not read-only — so the tool was never offered, the
    // prompt paragraph (keyed to its availability) never rendered, and "0 delegations
    // in 72 calls" measured a choice that did not exist. Normal mode with an explicit
    // read-only list plus delegate offers the real choice while keeping the probe
    // unable to write.
    mode: 'normal',
    allowedTools: ['read_file', 'search_code', 'list_dir', 'find_files', 'symbol_outline', 'delegate'],
    maxSteps: 10,
    events: {
      onTextDelta: () => {},
      onToolCall: (name) => calls.push(name),
    },
  })

  const started = Date.now()
  const turn = await agent.runTurn(job)
  const delegated = calls.filter((c) => c === 'delegate').length
  console.log(`\n${((Date.now() - started) / 1000).toFixed(0)}s, ${turn.steps} steps, stopped: ${turn.stoppedBecause}`)
  console.log(`  calls: ${calls.join(', ')}`)
  console.log(`  delegate used ${delegated} time(s)`)
}
