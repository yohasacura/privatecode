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
 * Restricts a ref to a small, safe character set (letters, digits, underscore, dot, slash,
 * tilde, caret, hyphen). Note that the pattern *alone* does not refuse a leading `-`, since
 * `-` is itself one of the allowed characters — `-O../outside.txt` matches it just fine.
 * `validate` additionally rejects any base starting with `-` (which git would otherwise read
 * as an option, e.g. `-O<file>` writing to an attacker-chosen path); the character-class
 * pattern plus that explicit leading-dash rejection together close the option-injection hole.
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
      if (r.base.startsWith('-')) {
        return {
          ok: false,
          error: 'base must be a git ref (branch, tag, or commit); options are not accepted',
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

    // `core.quotePath=false` ahead of every action: git otherwise C-escapes any path byte
    // outside ASCII, so a file named in Cyrillic, or with an accent, reaches the model as
    // "\321\202\320\265..." — a string it cannot match against anything it has read, and
    // cannot pass back to a tool. The flag changes only how paths are PRINTED.
    const argv = ['-c', 'core.quotePath=false', ...ACTIONS[args.action](resolved)]
    const result = await execa('git', argv, {
      cwd: ctx.workspace.root,
      reject: false,
      windowsHide: true,
      all: true,
    })

    const all = (result.all ?? '').trim()
    if (result.failed || result.exitCode !== 0) {
      if (result.exitCode === undefined) {
        // execa never got a process to run (e.g. ENOENT: git isn't on PATH), so `all` and
        // `exitCode` are both undefined — there is no process output to report.
        return {
          ok: false,
          content:
            'git could not be run (is git installed and on PATH?), so git_status has ' +
            'nothing to report.',
        }
      }
      if (/not a git repository/i.test(all)) {
        return {
          ok: false,
          content:
            'The workspace is not a git repository (or git is not installed), so ' +
            'git_status has nothing to report.',
        }
      }
      const clipped = clipOutput(all, OUTPUT_CHAR_LIMIT)
      return {
        ok: false,
        content: clipped === '' ? `exit ${result.exitCode} with no output` : clipped,
      }
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
