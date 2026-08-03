import { useEffect, useRef, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import type { ProtocolClient } from '../lib/client'
import type { ChatItem } from '../lib/state'
import { presentTool } from '../lib/tools'
import { useJobs } from '../lib/use-jobs'
import { Icon } from '../components/icons'

/**
 * Terminal tab: one console showing every command that ran in this workspace — the ones the
 * agent ran (from the transcript, permission-gated as always) and the ones you ran yourself
 * (through `terminal.run`), interleaved by the order they happened.
 *
 * A command you type here does NOT go through the permission engine and does NOT enter the
 * model's context. That is deliberate and stated in the UI: the engine exists to bound what
 * the model may do unattended, and there is no model in this path — you typed it. Keeping
 * it out of the transcript means running `git log` to orient yourself never costs context
 * or confuses the model about what it did.
 */

interface Line {
  key: string
  origin: 'agent' | 'you'
  command: string
  state: string
  stateCls: string
  output: string
  clipped: boolean
}

/** The agent's own `run_command` calls, in transcript order. `background_task` is left to
 * the Jobs tab, which shows it live rather than as a frozen poll result. */
function agentCommands(items: ChatItem[]): Line[] {
  const lines: Line[] = []
  for (const item of items) {
    if (item.kind !== 'tool' || item.name !== 'run_command') continue
    const p = presentTool(item.name, item.args)
    lines.push({
      key: `t${item.id}`,
      origin: 'agent',
      command: p.target,
      state: item.result === undefined ? 'running' : item.result.ok ? 'done' : 'failed',
      stateCls: item.result === undefined ? 'job-running' : item.result.ok ? 'job-ok' : 'job-fail',
      output: item.result?.content ?? '',
      clipped: false,
    })
  }
  return lines
}

export function TerminalTab({
  client, items, active, canRun,
}: {
  client: ProtocolClient
  items: ChatItem[]
  active: boolean
  /** False before a workspace is open -- `terminal.run` has nowhere to run. */
  canRun: boolean
}): VNode {
  const { jobs, refresh } = useJobs(client, active)
  const [command, setCommand] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [historyAt, setHistoryAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  const yourCommands: Line[] = jobs
    .filter((j) => j.origin === 'user')
    .map((j) => ({
      key: j.id,
      origin: 'you' as const,
      command: j.command,
      state: j.running ? 'running' : j.stopped ? 'stopped' : `exit ${j.exitCode ?? '?'}`,
      stateCls: j.running ? 'job-running' : j.exitCode === 0 ? 'job-ok' : 'job-fail',
      output: j.output,
      clipped: j.clipped,
    }))

  const lines = [...agentCommands(items), ...yourCommands]

  // Follow the output while new lines arrive. This console is short-lived and always read
  // from the bottom, so it pins unconditionally rather than tracking intent the way the
  // transcript does.
  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines.length, jobs.map((j) => j.output.length).join(',')])

  function run(): void {
    const text = command.trim()
    if (text === '' || !canRun) return
    setCommand('')
    setHistory((h) => [...h, text])
    setHistoryAt(null)
    client.call('terminal.run', { command: text })
      .then(() => { setError(null); refresh() })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  /** Up/Down walk previously-run commands, as any shell does. */
  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter') { e.preventDefault(); run(); return }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    if (history.length === 0) return
    e.preventDefault()
    const at = historyAt ?? history.length
    const next = e.key === 'ArrowUp' ? Math.max(0, at - 1) : Math.min(history.length, at + 1)
    setHistoryAt(next === history.length ? null : next)
    setCommand(next === history.length ? '' : (history[next] ?? ''))
  }

  return (
    <div class="terminal-tab">
      <div class="terminal-body" ref={bodyRef}>
        {lines.length === 0 && (
          <div class="panel-placeholder">
            Commands run in this workspace appear here — the agent's and yours.
          </div>
        )}
        {lines.map((line) => (
          <div key={line.key} class="term-line">
            <div class="term-command">
              <span class={`term-origin term-origin-${line.origin}`}>{line.origin}</span>
              <span class="term-prompt">$</span>
              <span class="term-text">{line.command}</span>
              <span class={`term-state ${line.stateCls}`}>{line.state}</span>
            </div>
            {line.output !== '' && (
              <pre class="term-output">
                {line.clipped && <span class="dim">…earlier output dropped…{'\n'}</span>}
                {line.output}
              </pre>
            )}
          </div>
        ))}
      </div>

      {error && <div class="panel-error">{error}</div>}

      <div class="terminal-input-row">
        <span class="term-prompt">$</span>
        <input
          class="terminal-input"
          value={command}
          disabled={!canRun}
          onInput={(e) => setCommand(e.currentTarget.value)}
          onKeyDown={onKeyDown}
          placeholder={canRun ? 'run a command yourself (not sent to the model)' : 'open a workspace first'}
        />
        <button class="icon-button" onClick={run} disabled={!canRun || command.trim() === ''} title="Run">
          {Icon.play()}
        </button>
      </div>
    </div>
  )
}
