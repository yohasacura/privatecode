import { glob } from 'node:fs/promises'
import { isAbsolute, join, posix, relative, sep, win32 } from 'node:path'
import type { Mount } from '../mounts.js'
import type { Workspace } from '../workspace.js'
import { fsErrorReason } from './atomic-write.js'
import type { Tool } from './types.js'

export interface FindFilesArgs { glob: string }

const MAX_RESULTS = 200

/** Either separator may appear in a model-written pattern, on any platform. */
const SEPARATOR = /[\\/]/

/** Path segments never enumerated, matched whole - the same rule list_dir applies. */
const HIDDEN_SEGMENTS = new Set(['.git', 'node_modules'].map((s) => s.toLowerCase()))

/**
 * Absolute under either platform's rules, not just the host's: a pattern is model-written
 * text, and `C:/secrets/*` must be refused when the host is POSIX just as `/etc/*` must be
 * refused when the host is Windows.
 */
function isAbsolutePattern(pattern: string): boolean {
  return isAbsolute(pattern) || win32.isAbsolute(pattern) || posix.isAbsolute(pattern)
}

/**
 * Node's glob matches nothing rather than throwing on an unparseable pattern, so a typo is
 * indistinguishable from an empty result and costs the model a whole turn to discover.
 * Unbalanced brackets and braces are the cases that actually occur. A backslash is treated
 * as a path separator, not as a glob escape, because on the target platform that is what a
 * model means by it - so `foo\[bar` is reported as unclosed rather than read as an escape.
 */
function globSyntaxProblem(pattern: string): string | null {
  let braces = 0
  let inClass = false
  for (const ch of pattern) {
    if (inClass) {
      if (ch === ']') inClass = false
      continue
    }
    if (ch === '[') inClass = true
    else if (ch === '{') braces++
    else if (ch === '}') {
      braces--
      if (braces < 0) return "unmatched '}'"
    }
  }
  if (inClass) return "unclosed '['"
  if (braces > 0) return "unclosed '{'"
  return null
}

/**
 * Why this pattern cannot be run, or null. Applied in validate() so a bad pattern never
 * reaches the filesystem, and again in execute() so calling execute() directly is not a
 * way around it.
 */
function patternProblem(pattern: string): string | null {
  if (isAbsolutePattern(pattern)) {
    return `Glob must be relative to the workspace root: "${pattern}" is an absolute path`
  }
  if (pattern.split(SEPARATOR).some((segment) => segment === '..')) {
    return `Glob must stay inside the workspace: "${pattern}" contains a ".." segment`
  }
  const syntax = globSyntaxProblem(pattern)
  if (syntax !== null) return `Invalid glob pattern "${pattern}": ${syntax}`
  return null
}

/** `*`, `?`, `[`, `{` — the characters that make a segment a pattern rather than a name. */
const GLOB_META = /[*?[\]{}]/

/**
 * Which folders to run the pattern in, and with what.
 *
 * One rule covering both things a person means. `engine/**\/*.rs` names a folder, so it runs
 * only there; `**\/*.rs` names none, so it runs in all of them and every result comes back
 * prefixed. Deciding by "is the first segment literally one of the folder names" rather than
 * by requiring a prefix keeps the useful case — find this everywhere — one call instead of
 * one per folder.
 */
function globJobs(pattern: string, workspace: Workspace): { mount: Mount; pattern: string }[] {
  if (!workspace.multi) return [{ mount: workspace.mounts[0] as Mount, pattern }]

  const cut = pattern.search(SEPARATOR)
  const head = cut === -1 ? pattern : pattern.slice(0, cut)
  if (!GLOB_META.test(head)) {
    const named = workspace.mounts.find((m) => m.name.toLowerCase() === head.toLowerCase())
    if (named) {
      const rest = cut === -1 ? '' : pattern.slice(cut + 1)
      return [{ mount: named, pattern: rest === '' ? '**/*' : rest }]
    }
  }
  return workspace.mounts.map((mount) => ({ mount, pattern }))
}

export const findFilesTool: Tool<FindFilesArgs> = {
  name: 'find_files',
  readOnly: true,
  description:
    'Find files by glob pattern, for example "src/**/*.ts". Directories are not returned. ' +
    'In a workspace with several folders, a pattern that starts with a folder name searches ' +
    'only that folder; one that does not searches all of them.',
  parameters: {
    type: 'object',
    properties: { glob: { type: 'string', description: 'Glob relative to the workspace root.' } },
    required: ['glob'],
  },
  validate(raw) {
    const r = raw as Partial<FindFilesArgs>
    if (typeof r?.glob !== 'string' || r.glob.trim() === '') {
      return { ok: false, error: 'glob must be a non-empty pattern' }
    }
    const problem = patternProblem(r.glob)
    if (problem !== null) return { ok: false, error: problem }
    return { ok: true, args: { glob: r.glob } }
  },
  async execute(args, ctx) {
    const problem = patternProblem(args.glob)
    if (problem !== null) return { ok: false, content: problem }

    const matches: string[] = []
    const multi = ctx.workspace.multi
    for (const job of globJobs(args.glob, ctx.workspace)) {
      try {
        // Known limitation, not an oversight: Node's fs.glob has no `dot` option, so there is
        // no way to opt a pattern into matching dotted path segments. A non-dotted pattern
        // (e.g. "**/*.yml") therefore cannot reach a dotted path (e.g. ".github/workflows/ci.yml");
        // the caller must write an explicitly dotted pattern (e.g. ".github/**/*.yml") to see it.
        // Measured directly against fs.glob on Node v24.18.1 - passing `dot: true` is silently
        // ignored, not rejected, which is why it must not be passed at all.
        for await (const entry of glob(job.pattern, { cwd: job.mount.root, withFileTypes: true })) {
          // The tool is called find_files: a bare directory name is indistinguishable from
          // an extensionless file, and the model will call read_file on it.
          if (entry.isDirectory()) continue
          const rel = relative(job.mount.root, join(entry.parentPath, entry.name))
          const segments = rel.split(sep)
          if (segments.some((segment) => HIDDEN_SEGMENTS.has(segment.toLowerCase()))) continue
          // Enumeration goes through the same jail as reading. glob is given the model's raw
          // pattern, so containment and the secrets denylist have to be enforced on what
          // comes back out, not on what went in.
          const addressed = multi ? `${job.mount.name}/${segments.join('/')}` : rel
          try {
            ctx.workspace.resolve(addressed)
          } catch {
            continue
          }
          matches.push(multi ? addressed : segments.join('/'))
        }
      } catch (e) {
        // Held to the same bar as the other three read tools: no absolute path, no raw
        // errno. Stated plainly because it matters: this branch is NOT covered by a test.
        // fs.glob swallows per-entry failures rather than throwing — measured against a
        // nonexistent root and against an ACL-denied subdirectory, both of which returned an
        // ordinary result — so there is no honest way to reach it from the outside today.
        return { ok: false, content: `Glob failed: ${fsErrorReason(job.mount.root, e)}` }
      }
    }

    if (matches.length === 0) return { ok: true, content: `No files match ${args.glob}` }

    // Sort before capping, so the shown subset is genuinely the first N in sorted order
    // rather than an arbitrary slice of traversal order wearing a sorted disguise.
    matches.sort()
    const shown = matches.slice(0, MAX_RESULTS)
    const capped = matches.length > MAX_RESULTS
      ? `\n(${MAX_RESULTS} of ${matches.length} matches shown; narrow the pattern)`
      : ''
    return { ok: true, content: shown.join('\n') + capped }
  },
}
