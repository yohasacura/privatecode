import { parseArgs } from 'node:util'
import { Agent } from './agent/loop.js'
import { LlamaClient } from './llama/client.js'
import { Workspace } from './workspace.js'
import { buildRegistry, READ_ONLY_TOOLS } from './tools/default-set.js'

const DEFAULT_SERVER = 'http://127.0.0.1:8080'
const MODEL = 'Qwen3.6-35B-A3B'

function fmtDuration(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`
}

/** Actionable, not a stack trace: names the server and how to start it. */
function serverUnreachableMessage(server: string, detail?: string): string {
  return (
    `\nCould not reach llama.cpp at ${server}${detail ? ` (${detail})` : ''}.\n` +
    'Start it with D:\\LocalAgentAI\\Start-QwenServer.bat and wait for the dashboard to ' +
    'show RUNNING with VRAM free, then try again. Pass --server <url> if it runs ' +
    'somewhere else.\n'
  )
}

async function main() {
  const { values } = parseArgs({
    options: {
      workspace: { type: 'string' },
      task: { type: 'string' },
      server: { type: 'string', default: DEFAULT_SERVER },
      plan: { type: 'boolean', default: false },
      steps: { type: 'string', default: '40' },
    },
  })
  if (!values.workspace || !values.task) {
    console.error('usage: npm run agent -- --workspace <dir> --task "<text>" [--plan] [--server <url>] [--steps <n>]')
    process.exitCode = 2
    return
  }

  const server = values.server ?? DEFAULT_SERVER
  const client = new LlamaClient({ baseUrl: server, model: MODEL })

  // A dead or unreachable server is not a turn outcome — it is checked up front so the
  // failure names the server and the fix instead of surfacing mid-turn as a raw
  // transport exception once the model already looks like it is "thinking".
  if (!(await client.health())) {
    console.error(serverUnreachableMessage(server))
    process.exitCode = 1
    return
  }

  const registry = buildRegistry()
  const mode = values.plan ? 'plan' : 'normal'
  if (mode === 'plan') {
    // Agent derives its own restriction from the registry regardless of what is passed
    // here; this line only tells the user what that restriction is.
    console.log(`\x1b[90mplan mode: read-only tools only (${READ_ONLY_TOOLS.join(', ')})\x1b[0m`)
  }

  const agent = new Agent({
    client,
    registry,
    context: { workspace: new Workspace(values.workspace) },
    mode,
    maxSteps: Number(values.steps),
    events: {
      // A step can run 40-90 s; printing nothing until it ends is the one thing this
      // interface must not do. This line is the countdown's starting gun.
      onStepStart: (i) => console.log(
        `\x1b[90m--- step ${i.step} (budget ${fmtDuration(i.timeoutMs)}) ---\x1b[0m`),
      onThinking: (t) => console.log(`\x1b[90m[thinking, ~${Math.ceil(t.length / 4)} tok]\x1b[0m`),
      onContinuation: (s) => console.log(
        `\x1b[33m! step ${s} ran out of room while thinking; forcing an action now\x1b[0m`),
      onToolCall: (n, a) => console.log(`\x1b[36m\u2192 ${n}\x1b[0m ${a.slice(0, 200)}`),
      onToolResult: (n, r) => console.log(
        `${r.ok ? '\x1b[32m\u2713' : '\x1b[31m\u2717'} ${n}\x1b[0m ${r.content.split('\n')[0]?.slice(0, 200)}`),
      onAssistantText: (t) => console.log(`\n${t}\n`),
      onStepDone: (i) => console.log(
        `\x1b[90m  ${i.seconds.toFixed(1)}s` +
        `${i.tokensPerSecond ? `, ${i.tokensPerSecond.toFixed(1)} tok/s` : ''}` +
        `${i.continued ? ', continued after truncation' : ''}\x1b[0m`),
    },
  })

  let result
  try {
    result = await agent.runTurn(values.task)
  } catch (e) {
    // runTurn absorbs abort/timeout into stoppedBecause, but a genuine transport failure
    // (server crashed, connection refused mid-turn) still escapes as an exception — that
    // is not a turn outcome and must not print as an unhandled stack trace.
    console.error(serverUnreachableMessage(server, e instanceof Error ? e.message : String(e)))
    process.exitCode = 1
    return
  }

  console.log(`\n--- ${result.stoppedBecause} after ${result.steps} steps ---`)
  if (result.stoppedBecause === 'timeout' || result.stoppedBecause === 'truncated') {
    console.log(
      '(this is a real outcome on a slow local model, not necessarily a defect in the task)')
  }
  process.exitCode = result.stoppedBecause === 'done' ? 0 : 1
}

// process.exitCode, never process.exit(): forcing an immediate exit while an
// AbortSignal.timeout() from a just-finished step is still pending its own teardown
// crashes node on Windows (observed: "Assertion failed: !(handle->flags &
// UV_HANDLE_CLOSING), file src\win\async.c"). Setting exitCode and letting the event
// loop drain naturally avoids racing that teardown and still reports the right code.
main().catch((e) => { console.error(e); process.exitCode = 1 })
