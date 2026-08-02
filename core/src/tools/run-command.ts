import { stat } from 'node:fs/promises'
import { execa } from 'execa'
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

/** Head-and-tail clip: the head names what ran, the tail carries the error that matters. */
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
    const result = await execa(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', args.command],
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
    const seconds = ((performance.now() - started) / 1000).toFixed(1)
    const out = clipOutput((result.all ?? '').trim())
    if (result.isCanceled) {
      return { ok: false, content: 'Command cancelled by the user before it finished.' }
    }
    if (result.timedOut) {
      return {
        ok: false,
        content: `Command killed after ${timeoutS} s (timeout). Partial output:\n` +
          `${out || '(none)'}\nIf it legitimately needs longer, re-run with a larger ` +
          'timeout_seconds, or use background_task for something long-running.',
      }
    }
    const code = result.exitCode ?? -1
    return {
      ok: code === 0,
      content: `exit ${code} in ${seconds} s\n${out || '(no output)'}`,
    }
  },
}
