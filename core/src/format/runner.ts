import { readFile } from 'node:fs/promises'
import { execa } from 'execa'
import { ruleFor, type FormatRule } from './config.js'
import { POWERSHELL_EXE, powershellArgs } from '../powershell.js'
import type { Workspace } from '../workspace.js'

/**
 * Runs the project's formatter on a file the agent just wrote.
 *
 * It lives INSIDE the write path rather than in an after-tool hook, and that placement is
 * the entire reason it exists separately. `edit_file` returns a diff, and the model's next
 * edit anchors a SEARCH block on the text in that diff. If formatting happens after the
 * tool has already built its result, the diff shows text that is no longer on disk and the
 * next anchor misses — the agent then re-reads, retries, and burns a turn discovering that
 * its own output was rewritten underneath it. Formatting here means the diff is rendered
 * against the post-format file, so what the model was shown is what it can anchor to.
 */

/** A formatter is a fast, local, deterministic tool; anything slower than this is either
 * wedged or the wrong tool for an inline step. */
const TIMEOUT_MS = 20_000

/** After this many failures the runner stops trying for the rest of the session. A broken
 * formatter command must cost a few seconds once, not on every single edit. */
const MAX_FAILURES = 3

export interface FormatOutcome {
  /** A rule matched and the command was executed. */
  ran: boolean
  /** The file's bytes differ from what the tool wrote. */
  changed: boolean
  /** One line for the model, when there is something it must know. */
  note?: string
}

export interface FormatRunner {
  /** `relativePath` is workspace-relative; the returned text is the file's content AFTER
   * formatting, or null when nothing ran and the caller should keep what it wrote. */
  run(relativePath: string, signal?: AbortSignal): Promise<FormatOutcome & { text: string | null }>
}

export function createFormatRunner(rules: FormatRule[], workspace: Workspace): FormatRunner {
  let failures = 0

  return {
    async run(relativePath, signal) {
      if (rules.length === 0) return { ran: false, changed: false, text: null }
      if (failures >= MAX_FAILURES) return { ran: false, changed: false, text: null }
      const rule = ruleFor(rules, relativePath)
      if (!rule) return { ran: false, changed: false, text: null }

      let abs: string
      try {
        abs = workspace.resolve(relativePath)
      } catch {
        return { ran: false, changed: false, text: null }
      }

      const before = await readFile(abs, 'utf8').catch(() => null)
      const command = rule.command.split('$FILE').join(relativePath)

      try {
        const result = await execa(
          POWERSHELL_EXE,
          powershellArgs(command),
          {
            cwd: workspace.root,
            timeout: TIMEOUT_MS,
            reject: false,
            windowsHide: true,
            all: true,
            ...(signal ? { cancelSignal: signal } : {}),
          },
        )
        if (result.exitCode !== 0) {
          failures++
          // Named, not swallowed: a formatter that rejects the file usually means the edit
          // produced something that does not parse, which the model must know NOW rather
          // than discovering three steps later.
          const detail = (result.all ?? '').trim().split('\n').slice(0, 3).join(' ')
          return {
            ran: true,
            changed: false,
            text: null,
            note: `the formatter (${rule.command}) exited ${result.exitCode ?? '?'}` +
              `${detail ? `: ${detail}` : ''}`,
          }
        }
      } catch (e) {
        failures++
        return {
          ran: true, changed: false, text: null,
          note: `the formatter could not be run: ${(e as Error).message}`,
        }
      }

      const after = await readFile(abs, 'utf8').catch(() => null)
      if (after === null) return { ran: true, changed: false, text: null }
      const changed = after !== before
      return {
        ran: true,
        changed,
        text: after,
        // Only said when it is true and actionable: the diff below it is already the
        // post-format text, so this explains why it may not look like what was asked for.
        ...(changed ? { note: 'the project formatter reformatted this file; the diff below is the result' } : {}),
      }
    },
  }
}
