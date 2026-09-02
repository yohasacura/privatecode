import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { memo } from 'preact/compat'
import type { VNode } from 'preact'
import { Play, Square, Terminal } from 'lucide-preact'
import type { JobInfo } from '@core/host/protocol'
import type { ProtocolClient } from '../lib/client'
import type { ChatItem } from '../lib/state'
import { formatDuration } from '../lib/format'
import { presentTool } from '../lib/tools'
import { useJobs } from '../lib/use-jobs'
import { Button, IconButton } from '../ui/button'
import { Chip } from '../ui/chip'
import { PanelEmpty, PanelError, PanelNote, PanelRow, PanelSection } from '../components/panel'

/**
 * Everything this workspace ran: the agent's commands, the agent's long-lived processes, and
 * the ones you started yourself — one console, in the order they happened
 * (docs/UI-REDESIGN-2026-09.md §7 "Terminal").
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
  tone: 'running' | 'ok' | 'fail' | 'stopped' | 'refused'
  output: string
  clipped: boolean
}

/** How many of the newest command rows are mounted. Each keeps its command whole output in
 * a <pre>, and a turn with no step ceiling can run thousands — the same reason the transcript
 * is capped, in the sibling panel that was handed the same array and given neither guard. */
const VISIBLE_COMMANDS = 200

/** Output past this many lines folds behind "show all"; the tail is what is shown, because
 * the end of a build log is where the verdict is. */
const OUTPUT_LINES = 40

const TONE_TEXT: Record<Line['tone'], string> = {
  running: 'text-accent', ok: 'text-green', fail: 'text-red', stopped: 'text-faint', refused: 'text-yellow',
}

/**
 * The permission engine's "no", as the core words a `Not run:`. A batch skipped after an
 * earlier failure is also `Not run:` and is NOT a command — it never happened, and a row
 * for it read as "npm test — failed" to someone checking on an overnight run. A call the
 * engine refused is different: the person deciding what to allow needs to see what was
 * asked, so it gets a row in its own tone, never "failed".
 */
const REFUSED = /^Not run: (?=.*(?:permission|denied|deny|refus|not allowed|blocked|rule))/i

/** The agent's own `Bash` calls, in transcript order. Its `background_task`
 * processes arrive through the job registry instead, which knows whether they are still
 * alive; a transcript entry only knows what one poll returned. */
export function agentCommands(items: ChatItem[]): Line[] {
  const lines: Line[] = []
  for (const item of items) {
    if (item.kind !== 'tool' || item.name !== 'Bash') continue
    if (item.result?.content.startsWith('Not run:')) {
      if (!REFUSED.test(item.result.content)) continue
      const p = presentTool(item.name, item.args)
      lines.push({
        key: `t${item.id}`,
        at: item.startedAtMs ?? 0,
        origin: 'agent',
        command: p.target,
        state: 'refused',
        tone: 'refused',
        output: item.result.content.slice('Not run:'.length).trim(),
        clipped: false,
      })
      continue
    }
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

/**
 * The memo key for the derived command list.
 *
 * `items` is a new array on every streamed token, so keying on the array itself would never
 * hit; the two counts are exact for everything a token can do (an item appended, a tool call
 * resolving) and cost a loop instead of a JSON.parse per command per token.
 *
 * The third number is the identity of the transcript, and it is why this is a function rather
 * than two inline expressions. A session switch REPLACES `items` wholesale, and both counts
 * are small integers that collide readily between two short sessions — resuming a stored
 * session whose item count and resolved-tool count happened to match the one you were in left
 * the PREVIOUS conversation's commands on screen, with their output, under the new session's
 * name. The oldest item's id settles it: ids are handed out by a counter that is deliberately
 * carried ACROSS a switch (state.ts's `session-switched` keeps `nextId`), so a restored
 * session can never reuse an id the previous one already spent.
 */
export function commandsKey(items: readonly ChatItem[]): [number, number, number] {
  let resolved = 0
  for (const item of items) {
    if (item.kind === 'tool' && item.result !== undefined) resolved++
  }
  return [items.length, resolved, items[0]?.id ?? 0]
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

const CommandRow = memo(function CommandRow({
  line, defaultOpen, onStop,
}: {
  line: Line
  defaultOpen: boolean
  onStop?: () => void
}): VNode {
  const [open, setOpen] = useState(defaultOpen)
  const [all, setAll] = useState(false)
  const rows = line.output === '' ? [] : line.output.split('\n')
  const folded = !all && rows.length > OUTPUT_LINES
  const shown = folded ? rows.slice(-OUTPUT_LINES) : rows
  return (
    <PanelRow
      open={open}
      onToggle={() => setOpen((o) => !o)}
      label={
        <>
          <Chip tone={line.origin === 'agent' ? 'accent' : 'blue'} class="mr-1.5 h-4 px-1 text-[10px] uppercase tracking-[0.04em]">
            {line.origin}
          </Chip>
          <span class="text-faint">$</span> {line.command}
        </>
      }
      mono
      title={line.command}
      meta={<span class={TONE_TEXT[line.tone]} data-tone={line.tone}>{line.state}</span>}
      {...(onStop !== undefined
        ? {
            actions: (
              <IconButton size="sm" label="Stop this process" onClick={onStop}>
                <Square />
              </IconButton>
            ),
          }
        : {})}
    >
      <pre
        data-output=""
        class="m-0 max-h-[300px] overflow-auto whitespace-pre-wrap break-words border-l-2 border-border px-2.5 py-1.5 font-mono text-[11.5px] leading-[1.5] text-dim"
      >
        {line.clipped && <span class="text-faint">…earlier output dropped…{'\n'}</span>}
        {folded && <span class="text-faint">…{rows.length - OUTPUT_LINES} earlier lines folded…{'\n'}</span>}
        {rows.length === 0
          ? (line.tone === 'running' ? '(no output yet)' : '(no output)')
          : shown.join('\n')}
      </pre>
      {rows.length > OUTPUT_LINES && (
        <Button size="sm" variant="ghost" class="mt-1" onClick={() => setAll((v) => !v)} data-action="output-more">
          {all ? `Show the last ${OUTPUT_LINES} lines` : `Show all ${rows.length} lines`}
        </Button>
      )}
    </PanelRow>
  )
})

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

  // The agent's commands are re-derived only when the transcript can actually have gained
  // one — an item appended, a tool resolving, or the whole transcript being replaced by a
  // session switch. Without it, every frame of a streaming step re-walked the whole
  // transcript and re-JSON.parsed the arguments of every command the turn had ever run.
  const agentLines = useMemo(
    () => agentCommands(items),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see `commandsKey`
    commandsKey(items),
  )
  const jobsKey = finished.map((j) => `${j.id}:${j.output.length}`).join(',')
  const allLines = useMemo(
    () => [...agentLines, ...finished.map((j) => jobLine(j, now))].sort((a, b) => a.at - b.at),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `now` only moves a running job's
    // clock, and running jobs are rendered in their own section above this list
    [agentLines, jobsKey],
  )
  // And only the newest are mounted, for the reason the transcript is capped: every row keeps
  // its command's whole output in a <pre>, and a turn with no step ceiling can run thousands.
  const lines = allLines.length > VISIBLE_COMMANDS ? allLines.slice(-VISIBLE_COMMANDS) : allLines
  const hiddenCommands = allLines.length - lines.length

  // Follow the output while new lines arrive. This console is short-lived and always read
  // from the bottom, so it pins unconditionally rather than tracking intent the way the
  // transcript does.
  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
    // Keyed on the UNCAPPED count: `lines.length` stops changing once the cap is reached, so
    // this console — whose whole job is to show what is happening now — would have stopped
    // following the moment a run passed two hundred commands.
  }, [allLines.length, jobs.map((j) => j.output.length).join(',')])

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
    <div data-panel="terminal" class="flex h-full min-h-0 flex-col">
      {/* Pinned, and above the console rather than inside it: after an eight-hour run the
          live dev server is what you need first and would otherwise be a thousand lines up. */}
      {running.length > 0 && (
        <div class="max-h-[45%] shrink-0 overflow-y-auto border-b border-border bg-raised">
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

      <div class="flex min-h-0 flex-1 flex-col overflow-y-auto" ref={bodyRef}>
        {lines.length === 0 && running.length === 0 && (
          <PanelEmpty
            icon={<Terminal />}
            title="Nothing has run yet"
            hint="Commands the agent runs appear here, and so do the ones you type below."
          />
        )}
        {hiddenCommands > 0 && (
          <PanelNote>
            {hiddenCommands} earlier command{hiddenCommands === 1 ? '' : 's'} not shown — this
            console keeps the newest so a long run stays responsive.
          </PanelNote>
        )}
        {lines.map((line) => <CommandRow key={line.key} line={line} defaultOpen={false} />)}
      </div>

      {error !== null && <PanelError message={error} />}
      {jobsError !== null && <PanelError message={jobsError} onRetry={refresh} />}

      <div class="flex shrink-0 items-center gap-2 border-t border-border-soft bg-bg py-1.5 pl-3 pr-2 transition-colors duration-(--duration-fast) focus-within:border-accent-line">
        <span class="font-mono text-[11.5px] text-faint" aria-hidden="true">$</span>
        <input
          data-terminal-input=""
          class="min-w-0 flex-1 border-0 bg-transparent font-mono text-[11.5px] text-fg outline-none placeholder:font-ui placeholder:text-faint"
          value={command}
          disabled={!canRun}
          aria-label="Run a command yourself"
          onInput={(e) => setCommand(e.currentTarget.value)}
          onKeyDown={onKeyDown}
          placeholder={canRun ? 'run a command yourself (not sent to the model)' : 'open a workspace first'}
        />
        <IconButton size="sm" label="Run" onClick={run} disabled={!canRun || command.trim() === ''}>
          <Play />
        </IconButton>
      </div>
    </div>
  )
}
