import type { Validation } from './types.js'

/**
 * A background process's readiness condition — a port that answers, a file that appears,
 * a marker in the log. `Bash` takes it with `run_in_background`; `TaskOutput` polls until
 * it holds. Its own module because both tools need it and each imports the other.
 */
export interface ReadyWhen {
  port?: number
  file?: string
  log_contains?: string
}

/**
 * VALIDATED, not cast. `ready_when: {}` is schema-valid and grammar-reachable, and a
 * readiness condition that can never be true turns "poll until ready" into an endless poll.
 * Every tool validates its arguments semantically rather than against the schema alone.
 */
export function validateReadyWhen(value: unknown): Validation<ReadyWhen> {
  const raw = value as Record<string, unknown>
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'ready_when must be an object with one of: port, file, log_contains' }
  }
  const ready: ReadyWhen = {}
  if (raw['port'] !== undefined) {
    const port = raw['port']
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
      return { ok: false, error: 'ready_when.port must be an integer from 1 to 65535' }
    }
    ready.port = port
  }
  if (raw['file'] !== undefined) {
    const file = raw['file']
    if (typeof file !== 'string' || file.trim() === '') {
      return { ok: false, error: 'ready_when.file must be a non-empty path' }
    }
    ready.file = file.trim()
  }
  if (raw['log_contains'] !== undefined) {
    const marker = raw['log_contains']
    if (typeof marker !== 'string' || marker.trim() === '') {
      return { ok: false, error: 'ready_when.log_contains must be a non-empty string' }
    }
    ready.log_contains = marker.trim()
  }
  if (ready.port === undefined && ready.file === undefined && ready.log_contains === undefined) {
    return {
      ok: false,
      error: 'ready_when needs one usable condition: port, file, or log_contains. ' +
        'Omit it entirely if the process has none.',
    }
  }
  return { ok: true, args: ready }
}

/** The schema fragment both tools advertise. */
export const READY_WHEN_SCHEMA = {
  type: 'object',
  description: 'What shows the process is ready to be used, polled by TaskOutput.',
  properties: {
    port: { type: 'integer', description: 'TCP port on 127.0.0.1 that must answer.' },
    file: { type: 'string', description: 'Workspace-relative file that must exist.' },
    log_contains: { type: 'string', description: 'Substring that must appear in the output.' },
  },
} as const
