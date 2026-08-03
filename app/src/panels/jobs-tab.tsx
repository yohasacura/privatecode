import { useState } from 'preact/hooks'
import type { VNode } from 'preact'
import type { JobInfo } from '@core/host/protocol'
import type { ProtocolClient } from '../lib/client'
import { formatDuration } from '../lib/format'
import { useJobs } from '../lib/use-jobs'
import { Icon } from '../components/icons'

/**
 * Jobs tab: every process this session started that is still alive, or died and left
 * output worth reading — dev servers, watchers, long builds.
 *
 * Before this existed, a `background_task` the model started was visible only through
 * whatever the model chose to poll and paste back. This reads the registry directly, so a
 * dev server's log is available without asking the model for it, and Stop is a button
 * rather than a request.
 */

function stateLabel(job: JobInfo, now: number): { text: string; cls: string } {
  if (job.running) return { text: `running ${formatDuration(now - job.startedAt)}`, cls: 'job-running' }
  if (job.stopped) return { text: 'stopped', cls: 'job-stopped' }
  if (job.exitCode === 0) return { text: 'exited 0', cls: 'job-ok' }
  return { text: `exited ${job.exitCode ?? '?'}`, cls: 'job-fail' }
}

export function JobsTab({ client, active }: { client: ProtocolClient; active: boolean }): VNode {
  const { jobs, refresh, error } = useJobs(client, active)
  const now = Date.now()

  if (error) return <div class="panel-error" onClick={refresh}>{error} (click to retry)</div>
  if (jobs.length === 0) {
    return <div class="panel-placeholder">Nothing running. Long-lived processes appear here.</div>
  }

  return (
    <div class="jobs-tab">
      {jobs.map((job) => (
        <JobRow key={job.id} job={job} now={now} onStop={() => {
          client.call('jobs.stop', { id: job.id }).then(refresh).catch(() => { /* the next poll tells the truth */ })
        }} />
      ))}
    </div>
  )
}

function JobRow({ job, now, onStop }: { job: JobInfo; now: number; onStop: () => void }): VNode {
  const [open, setOpen] = useState(job.running)
  const state = stateLabel(job, now)

  return (
    <div class="job">
      <div class="job-head">
        <button class="change-toggle" onClick={() => setOpen((o) => !o)}>
          {open ? Icon.chevronDown() : Icon.chevronRight()}
        </button>
        <span class={`job-state ${state.cls}`}>{state.text}</span>
        <span class="job-command" title={job.command}>{job.command}</span>
        <span class="tag">{job.origin}</span>
        {job.running && (
          <button class="icon-button" onClick={onStop} title="Stop this process">{Icon.stop()}</button>
        )}
      </div>
      {open && (
        <pre class="job-output">
          {job.clipped && <span class="dim">…earlier output dropped…{'\n'}</span>}
          {job.output === '' ? '(no output yet)' : job.output}
        </pre>
      )}
    </div>
  )
}
