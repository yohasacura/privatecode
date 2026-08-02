import { execa } from 'execa'
import { relative, sep } from 'node:path'
import { clipOutput } from './run-command.js'
import type { PermissionKey, Tool } from './types.js'

export type GitAction = 'status' | 'diff' | 'log' | 'blame'

export interface GitArgs {
  action: GitAction
  /** Workspace-relative path. Required for blame; optional narrowing for diff/log. */
  path?: string
  /** A git ref (branch, tag, sha, `HEAD~3`, ...). Only `diff` consults it. */
  base?: string
}

const VALID_ACTIONS: readonly GitAction[] = ['status', 'diff', 'log', 'blame']

/**
 * Refuses anything that is not plainly a ref: no leading `-` (which would be read by git
 * as an option, e.g. `--output=...` writing an attacker-chosen file) and nothing outside
 * a small, safe character set. This is the sole gate between model-supplied text and an
 * argv slot git treats as an option-or-ref, so it has to reject option-shaped input, not
 * just validate ref-shaped input.
 */
const BASE_PATTERN = /^[A-Za-z0-9_.\/~^-]{1,80}$/

/** Everything this tool returns to the model goes through this cap. */
const OUTPUT_CHAR_LIMIT = 6_000

/**
 * Fixed argv per action. The model chooses an action and, for some actions, a path/base;
 * it never contributes a raw flag. `--` before every path argument stops a path that
 * merely looks like an option (e.g. a file named `-x`) from being read as one.
 */
const ACTIONS: Record<GitAction, (a: GitArgs) => string[]> = {
  status: () => ['status', '--porcelain=v1', '--branch'],
  diff: (a) => ['diff', ...(a.base ? [a.base] : []), ...(a.path ? ['--', a.path] : [])],
  log: (a) => ['log', '--oneline', '-n', '20', ...(a.path ? ['--', a.path] : [])],
  blame: (a) => ['blame', '--date=short', '--', a.path!],
}

export const gitStatusTool: Tool<GitArgs> = {
  name: 'git_status',
  readOnly: true,
  description:
    'Read-only git inspection: status (dirty files + branch), diff (working tree vs a ' +
    'ref, optionally scoped to a path), log (last 20 commits, optionally scoped to a ' +
    'path), or blame (line-by-line authorship of a path, required for blame). Never ' +
    'mutates the repository. Output is capped at ' + OUTPUT_CHAR_LIMIT + ' characters.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...VALID_ACTIONS], description: 'One of status, diff, log, blame.' },
      path: { type: 'string', description: 'Workspace-relative path. Required for blame; optional narrowing for diff/log.' },
      base: { type: 'string', description: 'A git ref for diff (branch, tag, sha, HEAD~N, ...). Ignored by other actions.' },
    },
    required: ['action'],
  },
  validate(raw) {
    const r = raw as Partial<GitArgs>
    if (typeof r?.action !== 'string' || !VALID_ACTIONS.includes(r.action as GitAction)) {
      return { ok: false, error: `action must be one of: ${VALID_ACTIONS.join(', ')}` }
    }
    const action = r.action as GitAction
    if (r.path !== undefined && (typeof r.path !== 'string' || r.path.trim() === '')) {
      return { ok: false, error: 'path must be a non-empty workspace-relative path when given' }
    }
    if (action === 'blame' && r.path === undefined) {
      return { ok: false, error: 'blame requires path' }
    }
    if (r.base !== undefined) {
      if (typeof r.base !== 'string' || !BASE_PATTERN.test(r.base)) {
        return {
          ok: false,
          error: `base must be a plain git ref matching ${BASE_PATTERN} (no flags or option-like values)`,
        }
      }
    }
    const args: GitArgs = { action }
    if (r.path !== undefined) args.path = r.path
    if (r.base !== undefined) args.base = r.base
    return { ok: true, args }
  },
  permissionKey(): PermissionKey {
    return { tool: 'git_status' }
  },
  async execute(args, ctx) {
    // `args.path` is workspace-relative as the model wrote it; resolve() is the jail, and
    // the *normalized* relative form (re-derived from the resolved absolute path) is what
    // goes to git, not the caller's raw spelling — git wants paths relative to cwd, which
    // is the workspace root, and the raw spelling may use `.`, backslashes, or mixed case
    // that resolve() has already canonicalized away.
    let gitPath: string | undefined
    if (args.path !== undefined) {
      let abs: string
      try {
        abs = ctx.workspace.resolve(args.path)
      } catch (e) {
        return { ok: false, content: (e as Error).message }
      }
      const rel = relative(ctx.workspace.root, abs)
      gitPath = rel === '' ? '.' : rel.split(sep).join('/')
    }

    const resolved: GitArgs = { action: args.action }
    if (gitPath !== undefined) resolved.path = gitPath
    if (args.base !== undefined) resolved.base = args.base

    const argv = ACTIONS[args.action](resolved)
    const result = await execa('git', argv, {
      cwd: ctx.workspace.root,
      reject: false,
      windowsHide: true,
      all: true,
    })

    const all = (result.all ?? '').trim()
    if (result.failed || result.exitCode !== 0) {
      if (/not a git repository/i.test(all)) {
        return {
          ok: false,
          content:
            'The workspace is not a git repository (or git is not installed), so ' +
            'git_status has nothing to report.',
        }
      }
      return { ok: false, content: clipOutput(all, OUTPUT_CHAR_LIMIT) }
    }

    if (all === '') {
      const empty = args.action === 'status' || args.action === 'diff'
        ? '(clean: no changes)'
        : '(no output)'
      return { ok: true, content: empty }
    }
    return { ok: true, content: clipOutput(all, OUTPUT_CHAR_LIMIT) }
  },
}
