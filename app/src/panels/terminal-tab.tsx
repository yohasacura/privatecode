import { useEffect, useRef, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import type { JobInfo } from '@core/host/protocol'
import type { ProtocolClient } from '../lib/client'
import type { ChatItem } from '../lib/state'
import { formatDuration } from '../lib/format'
import { presentTool } from '../lib/tools'
import { useJobs } from '../lib/use-jobs'
import { Icon } from '../components/icons'
import { PanelEmpty, PanelError, PanelRow, PanelSection } from '../components/panel'

/**
 * Everything this workspace ran: the agent's commands, the agent's long-lived processes, and
 * the ones you started yourself — one console, in the order they happened.
 *
 * This absorbed the Jobs tab. They were two tabs asking one question, and splitting it cost
 * twice: the column had five tabs where four fit (the fifth was clipped off the panel out of
 * the box), and a dev server the agent started was filed away from the command that started
 * it. What Jobs genuinely added was that a live process must not be something you scroll a
 * log to find — so running processes are pinned above the console rather than given their
 * own tab.
 *
 * A command you type here does NOT go through the permission engine and does NOT enter the
 * model's context. That is deliberate and stated in the UI: the engine exists to bound what
 * the model may do unattended, and there is no model in this path — you typed it. Keeping it
 * out of the transcript means running `git log` to orient yourself never costs context or
 * confuses the model about what it did.
 */

interface Line {
  key: string
  /** Epoch ms, for ordering. The agent's commands carry the `atMs` the reducer stamps on
   * `tool.call`; jobs carry `startedAt`. Concatenating the two lists instead pushed every
   * new agent command ABOVE your older ones, so the live output this panel exists to show
   * scrolled off the top while the view parked on a stale `git log`. */
  at: number
  origin: 'agent' | 'you'
  command: string
  state: string
  tone: 'running' | 'ok' | 'fail' | 'stopped'
  output: string
  clipped: boolean
}

const TONE_CLASS: Record<Line['tone'], string> = {
  running: 'job-running', ok: 'job-ok', fail: 'job-fail', stopped: 'job-stopped',
}

/** The agent's own `run_command` calls, in transcript order. Its `background_task`
 * processes arrive through the job registry instead, which knows whether they are still
 * alive; a transcript entry only knows what one poll returned. */
function agentCommands(items: ChatItem[]): Line[] {
  const lines: Line[] = []
  for (const item of items) {
    if (item.kind !== 'tool' || item.name !== 'run_command') continue
    const p = presentTool(item.name, item.args)
    lines.push({
      key: `t${item.id}`,
      at: item.startedAtMs ?? 0,
      origin: 'agent',
      command: p.target,
      state: item.result === undefined ? 'running' : item.result.ok ? 'done' : 'failed',
      tone: item.result === undefined ? 'running' : item.result.ok ? 'ok' : 'fail',
      output: item.result?.content ?? '',
      clipped: false,
    })
  }
  return lines
}

function jobLine(job: JobInfo, now: number): Line {
  return {
    key: job.id,
    at: job.startedAt,
    origin: job.origin === 'user' ? 'you' : 'agent',
    command: job.command,
    state: job.running
      ? `running ${formatDuration(now - job.startedAt)}`
      : job.stopped ? 'stopped' : `exit ${job.exitCode ?? '?'}`,
    tone: job.running ? 'running' : job.stopped ? 'stopped' : job.exitCode === 0 ? 'ok' : 'fail',
    output: job.output,
    clipped: job.clipped,
  }
}

function CommandRow({
  line, defaultOpen, onStop,
}: {
  line: Line
  defaultOpen: boolean
  onStop?: () => void
}): VNode {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <PanelRow
      open={open}
      onToggle={() => setOpen((o) => !o)}
      label={
        <>
          <span class={`term-origin term-origin-${line.origin}`}>{line.origin}</span>
          <span class="term-prompt">$</span> {line.command}
        </>
      }
      mono
      title={line.command}
      meta={<span class={TONE_CLASS[line.tone]}>{line.state}</span>}
      {...(onStop !== undefined
        ? {
            actions: (
              <button class="icon-button" onClick={onStop} title="Stop this process">
                {Icon.stop()}
              </button>
            ),
          }
        : {})}
    >
      <pre class="term-output">
        {line.clipped && <span class="dim">…earlier output dropped…{'\n'}</span>}
        {line.output === '' ? '(no output yet)' : line.output}
      </pre>
    </PanelRow>
  )
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
  const { jobs, refresh, error: jobsError } = useJobs(client, active)
  const [command, setCommand] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [historyAt, setHistoryAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const now = Date.now()

  const running = jobs.filter((j) => j.running)
  const finished = jobs.filter((j) => !j.running)
  const lines = [...agentCommands(items), ...finished.map((j) => jobLine(j, now))]
    .sort((a, b) => a.at - b.at)

  // Follow the output while new lines arrive. This console is short-lived and always read
  // from the bottom, so it pins unconditionally rather than tracking intent the way the
  // transcript does.
  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines.length, jobs.map((j) => j.output.length).join(',')])

  function stop(id: string): void {
    client.call('jobs.stop', { id })
      .then(refresh)
      .catch(() => { /* the next poll tells the truth */ })
  }

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
      {/* Pinned, and above the console rather than inside it: after an eight-hour run the
          live dev server is what you need first and would otherwise be a thousand lines up. */}
      {running.length > 0 && (
        <div class="terminal-running">
          <PanelSection title="Running now" count={running.length}>
            {running.map((job) => (
              <CommandRow
                key={job.id}
                line={jobLine(job, now)}
                defaultOpen
                onStop={() => stop(job.id)}
              />
            ))}
          </PanelSection>
        </div>
      )}

      <div class="terminal-body" ref={bodyRef}>
        {lines.length === 0 && running.length === 0 && (
          <PanelEmpty
            icon={Icon.terminal()}
            title="Nothing has run yet"
            hint="Commands the agent runs appear here, and so do the ones you type below."
          />
        )}
        {lines.map((line) => <CommandRow key={line.key} line={line} defaultOpen={false} />)}
      </div>

      {error !== null && <PanelError message={error} />}
      {jobsError !== null && <PanelError message={jobsError} onRetry={refresh} />}

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
