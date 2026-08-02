import { execa } from 'execa'
import { accessSync, constants as fsConstants } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Tool, ToolContext } from './types.js'

export interface SearchCodeArgs {
  pattern: string
  glob?: string
  max_results?: number
}

const DEFAULT_MAX = 80

/**
 * The same names `Workspace`'s denylist refuses for `read_file`, expressed as ripgrep
 * `--iglob` exclusions. This is belt, not suspenders: it keeps ripgrep from walking into
 * these files at all in the common case, but the actual guarantee is the per-line
 * `ctx.workspace.resolve()` check below, which is what still holds if one of these
 * patterns is wrong or incomplete.
 */
const DENIED_GLOBS = [
  '!.env', '!.env.*',
  '!id_rsa', '!id_ed25519',
  '!*.pem', '!*.pfx', '!*.p12',
  '!.npmrc', '!credentials',
]

function exists(path: string): boolean {
  try {
    accessSync(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * `vendor/ripgrep/rg.exe`, resolved relative to this module rather than to `process.cwd()`,
 * so it is found the same way regardless of where the tool process was launched from.
 */
function vendoredRgPath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // core/src/tools -> core/src -> core -> repo root -> vendor/ripgrep/rg.exe
  return join(here, '..', '..', '..', 'vendor', 'ripgrep', 'rg.exe')
}

/**
 * Search `PATH` for `rg` ourselves rather than handing a bare command name to execa.
 *
 * Measured directly: on Windows, `execa('rg', ..., { reject: false })` for a command that
 * does not exist resolves (it does not throw) with `exitCode: 1` - the same code ripgrep
 * itself uses for "no matches". A bare, unresolved command name makes a missing binary and
 * a real empty result indistinguishable. Resolving to a concrete, verified-to-exist path
 * ourselves avoids ever handing execa a name it has to guess at.
 */
function findOnPath(): string | null {
  const pathEnv = process.env.PATH ?? process.env.Path ?? ''
  const exeName = process.platform === 'win32' ? 'rg.exe' : 'rg'
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, exeName)
    if (exists(candidate)) return candidate
  }
  return null
}

type RgResolution = { ok: true; path: string } | { ok: false; message: string }

/**
 * Resolution is cached, but keyed on the current value of `PRIVATECODE_RG` rather than
 * cached unconditionally: tests (and, in principle, a long-lived process) can change that
 * variable between calls, and a stale cache would silently keep using whatever resolved
 * first.
 */
let cache: { envValue: string | undefined; resolution: RgResolution } | null = null

function computeResolution(envValue: string | undefined): RgResolution {
  if (envValue !== undefined && envValue.trim() !== '') {
    // An explicit override is exactly that: no fallback beneath it. If it is broken, the
    // caller asked for this exact binary and needs to be told so, not silently handed a
    // different one.
    if (exists(envValue)) return { ok: true, path: envValue }
    return {
      ok: false,
      message:
        `ripgrep is unavailable: PRIVATECODE_RG is set to "${envValue}", but no file exists ` +
        'there. Fix or unset PRIVATECODE_RG so search_code can fall back to the vendored ' +
        'or system ripgrep.',
    }
  }

  const vendored = vendoredRgPath()
  if (exists(vendored)) return { ok: true, path: vendored }

  const onPath = findOnPath()
  if (onPath !== null) return { ok: true, path: onPath }

  return {
    ok: false,
    message:
      'ripgrep is unavailable: no binary found. Tried the vendored copy at ' +
      `"${vendored}" and "rg" on PATH. search_code cannot run without ripgrep - restore ` +
      'vendor/ripgrep/rg.exe, install ripgrep on PATH, or set PRIVATECODE_RG to a working ' +
      'rg executable.',
  }
}

function resolveRg(): RgResolution {
  const envValue = process.env.PRIVATECODE_RG
  if (cache !== null && cache.envValue === envValue) return cache.resolution
  const resolution = computeResolution(envValue)
  cache = { envValue, resolution }
  return resolution
}

/**
 * Whether a `path:line:text` result line names a file `ctx.workspace.resolve()` accepts.
 * This is the actual boundary, independent of whether `DENIED_GLOBS` above matched: it
 * runs every result path through the same jail `read_file` uses, including the
 * canonicalization and 8.3/junction checks a glob pattern cannot express.
 */
function lineStaysInsideWorkspace(line: string, ctx: ToolContext): boolean {
  const match = /^(.*?):\d+:/.exec(line)
  if (!match) return true // defensive: --line-number always produces this shape
  try {
    ctx.workspace.resolve(match[1] as string)
    return true
  } catch {
    return false
  }
}

export const searchCodeTool: Tool<SearchCodeArgs> = {
  name: 'search_code',
  description:
    'Search the workspace with a regular expression (ripgrep). Returns file:line:text. ' +
    'This is the primary way to locate code; it is exact and never stale.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Rust-flavoured regular expression.' },
      glob: { type: 'string', description: 'Optional file filter, e.g. "*.ts".' },
      max_results: { type: 'integer', description: `Cap on matches, default ${DEFAULT_MAX}.` },
    },
    required: ['pattern'],
  },
  validate(raw) {
    const r = raw as Partial<SearchCodeArgs>
    if (typeof r?.pattern !== 'string' || r.pattern.trim() === '') {
      return { ok: false, error: 'pattern must be a non-empty regular expression' }
    }
    const args: SearchCodeArgs = { pattern: r.pattern }
    if (typeof r.glob === 'string' && r.glob.trim() !== '') args.glob = r.glob
    if (Number.isInteger(r.max_results) && (r.max_results as number) > 0) {
      args.max_results = r.max_results as number
    }
    return { ok: true, args }
  },
  async execute(args, ctx) {
    const resolution = resolveRg()
    if (!resolution.ok) {
      return { ok: false, content: `search_code failed: ${resolution.message}` }
    }

    const max = args.max_results ?? DEFAULT_MAX
    const argv = [
      '--line-number', '--no-heading', '--color', 'never',
      '--max-count', String(max),
      '--glob', '!node_modules', '--glob', '!.git',
    ]
    for (const g of DENIED_GLOBS) argv.push('--iglob', g)
    if (args.glob) argv.push('--glob', args.glob)
    argv.push('--regexp', args.pattern, '.')

    // A local wrapper, spawned with concrete literal options, so `ReturnType<typeof spawn>`
    // below resolves to the exact narrowed result shape (numeric exitCode, string stdout).
    // Annotating with `ReturnType<typeof execa>` directly instead picks execa's most
    // generic overload and widens `stdout` to a `string | string[] | Uint8Array` union.
    const spawn = () =>
      execa(resolution.path, argv, {
        cwd: ctx.workspace.root,
        reject: false,
        timeout: 30_000,
        ...(ctx.signal ? { cancelSignal: ctx.signal } : {}),
      })

    let result: Awaited<ReturnType<typeof spawn>>
    try {
      result = await spawn()
    } catch (e) {
      // A rejected promise here means ripgrep could not be run at all (e.g. the resolved
      // path stopped existing, or is not a valid executable) - a spawn failure, never a
      // search result.
      return {
        ok: false,
        content: `search_code failed: ripgrep could not be run (${(e as Error).message})`,
      }
    }

    // Ripgrep's contract: 0 = matches found, 1 = ran fine, no matches, 2 = a real error
    // (bad regex, unreadable path, ...). `reject: false` also resolves (rather than
    // throws) when the process could not be spawned at all - measured directly against a
    // nonexistent binary and against a file that exists but is not a valid executable -
    // and in both cases `exitCode` is not a number. That case must not fall through to
    // "no matches": a search that never ran is not a successful empty result.
    if (typeof result.exitCode !== 'number') {
      return {
        ok: false,
        content:
          `search_code failed: ripgrep did not run (${result.shortMessage ?? 'unknown spawn failure'})`,
      }
    }
    if (result.exitCode === 2) {
      return { ok: false, content: `search_code failed: ${result.stderr || 'ripgrep reported an error'}` }
    }
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      return {
        ok: false,
        content:
          `search_code failed: ripgrep exited with unexpected status ${result.exitCode}` +
          `${result.stderr ? `: ${result.stderr}` : ''}`,
      }
    }

    const lines = result.stdout
      .split('\n')
      .filter((l) => l.trim() !== '')
      .filter((line) => lineStaysInsideWorkspace(line, ctx))

    if (lines.length === 0) {
      return { ok: true, content: `No matches for /${args.pattern}/` }
    }
    const capped = lines.length >= max ? `\n(stopped at ${max} matches)` : ''
    return { ok: true, content: lines.slice(0, max).join('\n') + capped }
  },
}
