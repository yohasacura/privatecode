import { stat } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { execa } from 'execa'
import { POWERSHELL_EXE, powershellArgs } from '../powershell.js'
import { countLines, headLines, overflowNotice, spillToLog } from './output-log.js'
import type { ApprovalPreview, PermissionKey, Tool } from './types.js'

export interface RunCommandArgs {
  command: string
  timeout_seconds?: number
  cwd?: string
}

const DEFAULT_TIMEOUT_S = 120
const MAX_TIMEOUT_S = 600
/** Output cap. Everything returned is permanent transcript; a build log can be megabytes. */
const MAX_OUTPUT_CHARS = 8_000
/** Ceiling on the untruncated copy sent to the UI (see `ToolResult.display`). Large enough
 * for a real build or test log, small enough that one command cannot make the transcript
 * unbounded. */
const MAX_DISPLAY_CHARS = 400_000

/** Lines of the head shown inline when the rest went to a log file. Enough that a short
 * failure is answered without a second call, small enough to stay cheap. */
const HEAD_LINES = 60

/** Head-and-tail clip: the head names what ran, the tail carries the error that matters.
 * Still used for the UI copy and as the fallback when a log file cannot be written. */
export function clipOutput(text: string, limit = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text
  const head = Math.floor(limit * 0.6)
  const tail = limit - head
  const dropped = text.length - limit
  return `${text.slice(0, head)}\n... (${dropped} characters omitted from the middle; ` +
    `output is capped at ${limit}) ...\n${text.slice(-tail)}`
}

export const runCommandTool: Tool<RunCommandArgs> = {
  name: 'run_command',
  readOnly: false,
  description:
    'Run a PowerShell command in the workspace and return its combined output and exit ' +
    'code. Exit code 0 is evidence, not proof — verify with a follow-up check when it ' +
    'matters (some installers return 0 while work continues in the background). ' +
    'Long-running processes (dev servers, watchers) belong in background_task, not here.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The PowerShell command line to run.' },
      timeout_seconds: {
        type: 'integer',
        description: `Kill the command after this many seconds (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}).`,
      },
      cwd: {
        type: 'string',
        description: 'Workspace-relative directory to run in. Default: the workspace root.',
      },
    },
    required: ['command'],
  },
  validate(raw) {
    const r = raw as Partial<RunCommandArgs>
    if (typeof r?.command !== 'string' || r.command.trim() === '') {
      return { ok: false, error: 'command must be a non-empty string' }
    }
    if (r.timeout_seconds !== undefined) {
      if (!Number.isInteger(r.timeout_seconds) || r.timeout_seconds < 1 ||
          r.timeout_seconds > MAX_TIMEOUT_S) {
        return { ok: false, error: `timeout_seconds must be an integer from 1 to ${MAX_TIMEOUT_S}` }
      }
    }
    if (r.cwd !== undefined && (typeof r.cwd !== 'string' || r.cwd.trim() === '')) {
      return { ok: false, error: 'cwd must be a non-empty workspace-relative path when given' }
    }
    const args: RunCommandArgs = { command: r.command }
    if (r.timeout_seconds !== undefined) args.timeout_seconds = r.timeout_seconds
    if (r.cwd !== undefined) args.cwd = r.cwd
    return { ok: true, args }
  },
  permissionKey(args): PermissionKey {
    return { tool: 'run_command', command: args.command }
  },
  approvalPreview(args): ApprovalPreview {
    const oneLine = args.command.replace(/\s+/g, ' ').trim()
    return {
      summary: oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine,
      detail: `Run in PowerShell (cwd: ${args.cwd ?? 'workspace root'}):\n${args.command}`,
    }
  },
  async execute(args, ctx) {
    let cwd = ctx.workspace.root
    if (args.cwd) {
      try {
        cwd = ctx.workspace.resolve(args.cwd)
      } catch (e) {
        return { ok: false, content: (e as Error).message }
      }
      try {
        if (!(await stat(cwd)).isDirectory()) {
          return { ok: false, content: `cwd ${args.cwd} is not a directory` }
        }
      } catch {
        return { ok: false, content: `cwd ${args.cwd} does not exist` }
      }
    }
    const timeoutS = args.timeout_seconds ?? DEFAULT_TIMEOUT_S
    const started = performance.now()
    // reject: false — a non-zero exit is a result, not an exception. windowsHide keeps
    // PowerShell from flashing a console window once this runs under a UI shell.
    const child = execa(
      POWERSHELL_EXE,
      powershellArgs(args.command),
      {
        cwd,
        timeout: timeoutS * 1000,
        forceKillAfterDelay: 2_000,
        reject: false,
        windowsHide: true,
        all: true,
        ...(ctx.signal ? { cancelSignal: ctx.signal } : {}),
      },
    )
    // The same bytes the buffered result will contain, forwarded as they appear: a long
    // command used to be a frozen card until exit, and "is it working or wedged" was
    // unanswerable from the window. Streaming changes nothing about the result below.
    if (ctx.onLiveOutput) {
      // Not chunk.toString(): a chunk boundary can land mid-codepoint, and a split
      // multi-byte character would reach the live view as mojibake. The decoder holds the
      // partial bytes until the rest arrives.
      const decoder = new StringDecoder('utf8')
      child.all?.on('data', (chunk: Buffer | string) => {
        try {
          const text = typeof chunk === 'string' ? chunk : decoder.write(chunk)
          if (text !== '') ctx.onLiveOutput?.(text)
        } catch { /* display-only */ }
      })
    }
    const result = await child
    const seconds = ((performance.now() - started) / 1000).toFixed(1)
    const raw = (result.all ?? '').trim()
    // What a person sees. Still bounded -- a runaway build log must not be able to grow
    // the app's transcript without limit -- but two orders of magnitude above what the
    // model's permanent transcript can afford.
    const full = clipOutput(raw, MAX_DISPLAY_CHARS)

    // What the MODEL sees. When the output does not fit, it is not elided into a dead end:
    // the whole thing goes to a log file and the model is told how to page and filter it
    // (see output-log.ts). Falls back to the old head-and-tail clip only if the file
    // cannot be written.
    let out = raw
    if (raw.length > MAX_OUTPUT_CHARS) {
      const log = await spillToLog(ctx.workspace, 'run', raw)
      out = log === null
        ? clipOutput(raw)
        : `${headLines(raw, HEAD_LINES)}${overflowNotice(log, Math.min(HEAD_LINES, countLines(raw)))}`
    }

    if (result.isCanceled) {
      return { ok: false, content: 'Command cancelled by the user before it finished.' }
    }
    if (result.timedOut) {
      const head = `Command killed after ${timeoutS} s (timeout). Partial output:\n`
      const tail = '\nIf it legitimately needs longer, re-run with a larger ' +
        'timeout_seconds, or use background_task for something long-running.'
      return {
        ok: false,
        content: `${head}${out || '(none)'}${tail}`,
        display: `${head}${full || '(none)'}${tail}`,
      }
    }
    const code = result.exitCode ?? -1
    const header = `exit ${code} in ${seconds} s\n`
    return {
      ok: code === 0,
      content: `${header}${out || '(no output)'}`,
      display: `${header}${full || '(no output)'}`,
    }
  },
}
