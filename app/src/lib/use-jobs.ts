import { useCallback, useEffect, useState } from 'preact/hooks'
import type { JobInfo } from '@core/host/protocol'
import type { ProtocolClient } from './client'

/**
 * Polls the host's process registry while the caller is actually on screen.
 *
 * Polling is fine here in a way it would not be for `status`: `jobs.list` reads an
 * in-memory map inside the sidecar and never touches the llama.cpp server, so it cannot
 * violate the single-slot discipline no matter how often it fires. `active` is what keeps
 * it from running for a panel nobody is looking at.
 */
export function useJobs(
  client: ProtocolClient,
  active: boolean,
  intervalMs = 1000,
): { jobs: JobInfo[]; refresh: () => void; error: string | null } {
  const [jobs, setJobs] = useState<JobInfo[]>([])
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    client.call('jobs.list', {})
      .then((r) => { setJobs(r.jobs); setError(null) })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [client])

  useEffect(() => {
    if (!active) return
    refresh()
    const id = setInterval(refresh, intervalMs)
    return () => clearInterval(id)
  }, [active, refresh, intervalMs])

  return { jobs, refresh, error }
}
