import { execa } from 'execa'
import { statSync } from 'node:fs'
import { delimiter, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Mount } from '../mounts.js'
import type { Workspace } from '../workspace.js'
import type { Tool } from './types.js'

export interface SearchCodeArgs {
  pattern: string
  glob?: string
  max_results?: number
  /** Workspace-relative file or directory to search instead of the whole workspace. */
  path?: string
}

const DEFAULT_MAX = 80

/**
 * Ripgrep's own cap on how much of a matching line it prints, and a second, absolute cap
 * applied in JS to the finished `path:line:text` line.
 *
 * `max_results` caps the line *count*; nothing capped the line *width*. Measured: a
 * fixture with one 4,000,000-character line containing the needle returned `ok: true`
 * with 4,000,037 characters of content - permanently, into an append-only transcript.
 * Minified bundles, lockfiles, base64 blobs and single-line JSON are ordinary files, and
 * the `node_modules`/`.git` exclusions do not cover `dist/`.
 *
 * The JS cap is not redundant with the ripgrep one: `--max-columns` bounds the *matched
 * line*, not the `path:line:` prefix ripgrep prepends, and it is a ripgrep flag, so it
 * stops applying the moment the argv changes. The width bound is the guarantee; the flag
 * is only the cheap way to get most of it without shipping megabytes through the pipe.
 */
const MAX_COLUMNS = 300
const MAX_LINE_CHARS = 400

/** How much of ripgrep's stderr is worth quoting back when it warns rather than fails. */
const MAX_WARNING_LINES = 3
const MAX_WARNING_CHARS = 300

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

/**
 * The environment every ripgrep invocation gets.
 *
 * `RIPGREP_CONFIG_PATH` lets an ambient environment variable inject arbitrary flags into
 * the search engine. Verified directly: a config file containing `--hidden --no-ignore`
 * changed which files were walked, and `--pre=<path>` made ripgrep try to launch that
 * command against every file it visited. The denylist layers held in both cases, so this
 * was never a demonstrated leak - but an offline privacy tool must not let the
 * environment reconfigure its own search engine. Setting the key to `undefined` makes
 * Node drop it from the child's environment entirely rather than pass it through.
 */
const RG_ENV = { RIPGREP_CONFIG_PATH: undefined }

/**
 * `F_OK` alone was not enough: it accepts a *directory* at the resolved path, and a
 * directory is one of the shapes a broken `PRIVATECODE_RG` actually takes.
 */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
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
 * a real empty result indistinguishable. Resolving to a concrete path ourselves, and then
 * proving that path is ripgrep, avoids ever handing execa a name it has to guess at.
 */
function findOnPath(): string | null {
  const pathEnv = process.env.PATH ?? process.env.Path ?? ''
  const exeName = process.platform === 'win32' ? 'rg.exe' : 'rg'
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, exeName)
    if (isFile(candidate)) return candidate
  }
  return null
}

function firstLine(text: string): string {
  return (text.split('\n')[0] ?? '').trim()
}

/** `ripgrep 14.1.1 (rev 4649aa9700)` - the first line of a genuine `rg --version`. */
const RIPGREP_BANNER = /^ripgrep \d+\.\d+/

type RgCheck = { ok: true } | { ok: false; detail: string }

/**
 * Prove that the resolved path *is* ripgrep, by running it, once, at resolution time.
 *
 * Existence was never the property that mattered. Measured against a workspace with 15
 * genuine matches, varying `PRIVATECODE_RG`, the old code returned `ok: true, "No
 * matches"` - i.e. it told the model the user's code does not contain what it searched
 * for - for a directory, for a text file named `fake.bat`, for a text file named
 * `credentials.json`, and for `C:\Windows\System32\hostname.exe`. Only a text file named
 * `fake.exe` failed loudly, because only that shape makes execa fail to spawn at all.
 *
 * The reason is that the broken shapes are not spawn failures. A directory or a `.bat`
 * goes through `cmd.exe` and exits 1 with a shell error on stderr - indistinguishable
 * from "no matches" by exit code alone. A text file with a non-executable extension exits
 * 0 with empty stdout. Both fell through to the "No matches" branch. So the extension
 * decided the outcome, which is exactly the wrong thing to depend on.
 *
 * A `--version` handshake is decided by behaviour instead, and covers every shape at once
 * including a real, wrong executable, which no amount of filesystem inspection can catch.
 */
/**
 * Windows extensions that can actually be EXECUTED, from `PATHEXT`.
 *
 * Anything else handed to the OS as a command is not run, it is OPENED — Windows passes it
 * to whatever application owns the extension. Measured while chasing a complaint that the
 * test suite kept opening editor tabs: the `--version` handshake below, given a fixture
 * called `credentials.json`, produced
 *
 *     cmd.exe /q /d /s /c "…\credentials.json "--version""
 *
 * and Windows launched VS Code on it. That is a real defect in the product and not only in
 * the test: `PRIVATECODE_RG` pointing at a data file is a typo, and answering a typo by
 * opening the file in someone's editor is a side effect nobody asked a search tool for.
 */
const WINDOWS_EXECUTABLE = new Set(
  (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim().toLowerCase()).filter(Boolean),
)

/** Whether the OS would RUN this path, as opposed to opening it in an application. */
function looksExecutable(path: string): boolean {
  if (process.platform !== 'win32') return true
  const dot = path.lastIndexOf('.')
  const slash = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  if (dot <= slash) return false // no extension at all: Windows cannot run it
  return WINDOWS_EXECUTABLE.has(path.slice(dot).toLowerCase())
}

async function verifyIsRipgrep(path: string): Promise<RgCheck> {
  if (!looksExecutable(path)) {
    return { ok: false, detail: 'it is not an executable file (Windows would open it, not run it)' }
  }

  const spawn = () =>
    execa(path, ['--version'], { reject: false, timeout: 10_000, env: RG_ENV })

  let result: Awaited<ReturnType<typeof spawn>>
  try {
    result = await spawn()
  } catch (e) {
    return { ok: false, detail: `it could not be run (${(e as Error).message})` }
  }
  if (typeof result.exitCode !== 'number') {
    return {
      ok: false,
      detail: `it could not be run (${result.shortMessage ?? 'unknown spawn failure'})`,
    }
  }
  if (result.exitCode !== 0) {
    const why = result.stderr ? `: ${firstLine(result.stderr)}` : ''
    return { ok: false, detail: `\`--version\` exited with status ${result.exitCode}${why}` }
  }
  const banner = firstLine(result.stdout)
  if (!RIPGREP_BANNER.test(banner)) {
    return {
      ok: false,
      detail:
        banner === ''
          ? '`--version` printed nothing'
          : `\`--version\` printed "${banner}"`,
    }
  }
  return { ok: true }
}

type RgResolution = { ok: true; path: string } | { ok: false; message: string }

const REMEDY =
  'search_code cannot run without ripgrep - restore vendor/ripgrep/rg.exe, install ' +
  'ripgrep on PATH, or set PRIVATECODE_RG to a working rg executable.'

/**
 * Resolution is cached, but keyed on the current value of `PRIVATECODE_RG` rather than
 * cached unconditionally: tests (and, in principle, a long-lived process) can change that
 * variable between calls, and a stale cache would silently keep using whatever resolved
 * first. What is cached is the *verdict* - path plus proof - not merely the path, so the
 * `--version` handshake costs one extra spawn per distinct override, not one per search.
 * The promise itself is cached so concurrent searches share a single handshake.
 */
let cache: { envValue: string | undefined; resolution: Promise<RgResolution> } | null = null

async function computeResolution(envValue: string | undefined): Promise<RgResolution> {
  if (envValue !== undefined && envValue.trim() !== '') {
    // An explicit override is exactly that: no fallback beneath it. If it is broken, the
    // caller asked for this exact binary and needs to be told so, not silently handed a
    // different one.
    if (!isFile(envValue)) {
      return {
        ok: false,
        message:
          `ripgrep is unavailable: PRIVATECODE_RG is set to "${envValue}", but that is ` +
          `not a file. ${REMEDY}`,
      }
    }
    const check = await verifyIsRipgrep(envValue)
    if (!check.ok) {
      return {
        ok: false,
        message:
          `ripgrep is unavailable: PRIVATECODE_RG is set to "${envValue}", but that ` +
          `binary is not ripgrep - ${check.detail}. ${REMEDY}`,
      }
    }
    return { ok: true, path: envValue }
  }

  const tried: string[] = []

  const vendored = vendoredRgPath()
  if (isFile(vendored)) {
    const check = await verifyIsRipgrep(vendored)
    if (check.ok) return { ok: true, path: vendored }
    tried.push(`the vendored copy at "${vendored}" is not ripgrep - ${check.detail}`)
  } else {
    tried.push(`no file at the vendored path "${vendored}"`)
  }

  const onPath = findOnPath()
  if (onPath !== null) {
    const check = await verifyIsRipgrep(onPath)
    if (check.ok) return { ok: true, path: onPath }
    tried.push(`"${onPath}" from PATH is not ripgrep - ${check.detail}`)
  } else {
    tried.push('no "rg" on PATH')
  }

  return { ok: false, message: `ripgrep is unavailable: ${tried.join('; ')}. ${REMEDY}` }
}

function resolveRg(): Promise<RgResolution> {
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
 *
 * A line that does not parse is dropped, not passed through. Nothing ripgrep prints under
 * the current flags takes another shape - but a safety filter that forwards whatever it
 * failed to understand is a bypass waiting for the argv to change, and `--context`,
 * `--heading` and `--json` all change it. Dropping an unparseable line costs at most one
 * unhelpful line of output; forwarding it costs the guarantee.
 */
function addressLine(line: string, mount: Mount, workspace: Workspace): string | null {
  const match = /^(.*?):\d+:/.exec(line)
  if (!match) return null
  const rel = match[1] as string
  const addressed = workspace.multi ? `${mount.name}/${rel}` : rel
  try {
    workspace.resolve(addressed)
  } catch {
    return null
  }
  // A single-folder workspace gets ripgrep's own text back unchanged, down to the `.\`
  // prefix it emits — this tool's output shape is not what multi-folder support is for.
  if (!workspace.multi) return line
  const clean = rel.split(/[\\/]/).filter((s) => s !== '' && s !== '.').join('/')
  return `${mount.name}/${clean}${line.slice(rel.length)}`
}

function truncateLine(line: string): string {
  if (line.length <= MAX_LINE_CHARS) return line
  return `${line.slice(0, MAX_LINE_CHARS)} [... line truncated]`
}

function summariseStderr(stderr: string): string {
  const text = stderr.split('\n').map((l) => l.trimEnd()).filter((l) => l !== '')
    .slice(0, MAX_WARNING_LINES).join('; ')
  return text.length <= MAX_WARNING_CHARS ? text : `${text.slice(0, MAX_WARNING_CHARS)}...`
}

/**
 * Every diagnostic line ripgrep itself writes - including a warning, such as an
 * ignore-file parse error, that does not set an error exit code - is prefixed `rg: `.
 * Verified directly against the vendored binary: a workspace whose only `.gitignore` line
 * is `[` makes a real search exit 1 with `rg: .\.gitignore: line 1: error parsing glob
 * '[': unclosed character class; missing ']'` on stderr and nothing on stdout. Exit 1
 * with non-empty stderr is therefore not, by itself, proof the resolved binary isn't
 * ripgrep - it is ripgrep's own ordinary shape for "nothing found, but here is a warning".
 *
 * Ripgrep prefixes only the *first* line of a multi-line message. When a .gitignore has
 * two bad lines, stderr looks like:
 *   rg: .\.gitignore: line 1: error ...
 *   .\.gitignore: line 2: error ...
 *
 * Judge only the first non-empty line: if it carries the `rg: ` prefix, treat the
 * output as ripgrep's own. Every impostor shape measured produces stderr where the
 * *first* line lacks the prefix: a shell error routed through `cmd.exe` ("'C:\...' is
 * not recognized as an internal or external command", "'this' is not recognized...") or
 * a real-but-wrong executable's own error text ("sethostname: Use the ...").
 */
function hasNonRipgrepStderr(stderr: string): boolean {
  const firstLine = stderr
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '')

  // Check only the first non-empty line
  return firstLine !== undefined && !firstLine.startsWith('rg:')
}

/** Minor 3: the same bounded suffix ripgrep's own warnings get on the exit-2 (partial
 * error) path, attached whenever ripgrep wrote diagnostics, on whichever successful exit
 * code it used. Before this, stderr was discarded entirely on exit 0 and exit 1, so a
 * malformed `.gitignore` produced real matches - or a genuine "no matches" - with no hint
 * that part of the ignore configuration had failed to parse. */
function warningSuffix(stderr: string): string {
  return stderr ? `\n(warning: ${summariseStderr(stderr)})` : ''
}

export const searchCodeTool: Tool<SearchCodeArgs> = {
  name: 'search_code',
  readOnly: true,
  description:
    // "The primary way to locate code" claimed the whole territory, including questions it
    // cannot answer: it matches characters, so it cannot tell a call from a comment or find
    // a class that inherits an implementation without naming it. Narrowed to what is true.
    'Search the workspace with a regular expression (ripgrep). Returns file:line:text, ' +
    'ordered by path. This is the primary way to locate code BY TEXT; it is exact and never ' +
    'stale, but it matches characters rather than symbols — for what a C# name means, ' +
    'csharp_nav answers from the compiler instead. Very long lines are truncated, and on a ' +
    'truncated line the text that matched the pattern may itself have been cut and so may ' +
    'not appear in what is returned.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Rust-flavoured regular expression.' },
      glob: { type: 'string', description: 'Optional file filter, e.g. "*.ts".' },
      max_results: { type: 'integer', description: `Cap on matches, default ${DEFAULT_MAX}.` },
      path: {
        type: 'string',
        description:
          'Workspace-relative file or directory to search instead of the whole workspace. ' +
          'Use this to search a saved output log, or to scope a search to one subtree.',
      },
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
    if (typeof r.path === 'string' && r.path.trim() !== '') args.path = r.path.trim()
    return { ok: true, args }
  },
  async execute(args, ctx) {
    let resolution: RgResolution
    try {
      resolution = await resolveRg()
    } catch (e) {
      return {
        ok: false,
        content: `search_code failed: ripgrep could not be resolved (${(e as Error).message})`,
      }
    }
    if (!resolution.ok) {
      return { ok: false, content: `search_code failed: ${resolution.message}` }
    }

    const max = args.max_results ?? DEFAULT_MAX
    const argv = [
      '--line-number', '--no-heading', '--color', 'never',
      // `--with-filename` is load-bearing, not cosmetic. Given a single FILE to search,
      // ripgrep omits the path and prints `777:text` instead of `path:777:text` — and
      // `lineStaysInsideWorkspace` (the actual jail boundary for results) drops every line
      // it cannot parse as `path:line:`. So a scoped search of one file silently returned
      // "no matches" for a file that plainly contained the pattern. Forcing the filename on
      // keeps ripgrep's output shape invariant, which is exactly what that filter assumes.
      '--with-filename',
      // Determinism. `--max-count` is ripgrep's *per-file* cap and ripgrep walks
      // directories in parallel, so which matches survive the cap was whichever worker
      // threads finished first: eight identical calls with `max_results: 2` over five
      // equal files produced three distinct answers. `--sort path` fixes the walk order
      // (ripgrep sorts each directory's entries during traversal), which makes "the first
      // N matches" a well-defined set. It costs parallelism - `--sort path` is documented
      // as "always single-threaded" - which is the price of a tool whose description
      // promises exactness. The alternative, dropping `--max-count` and sorting in JS,
      // costs more: it makes ripgrep stream every match in the workspace through the pipe
      // before anything can be discarded, which is the same unbounded-output problem
      // `--max-columns` above exists to avoid.
      '--sort', 'path',
      // `max + 1`, not `max`: ripgrep's `--max-count` is per file, so asking it for
      // exactly `max` makes "there were more" and "there were exactly this many"
      // indistinguishable whenever the matches live in one file - which is why the old
      // `lines.length >= max` test claimed truncation that had not happened. One spare
      // line per file is enough to tell the two apart.
      '--max-count', String(max + 1),
      '--max-columns', String(MAX_COLUMNS), '--max-columns-preview',
      '--glob', '!node_modules', '--glob', '!.git',
    ]
    // Naming a location explicitly means you want what is IN it, so a scoped search also
    // looks inside dot-directories -- which is what makes a saved output log under
    // `.privatecode/logs/` searchable at all. An unscoped search keeps ripgrep's default
    // (hidden paths skipped), so nothing about existing whole-workspace searches changes.
    //
    // One ripgrep run per folder, because ripgrep searches a directory tree and a workspace
    // of folders from three different drives is not one. A scoped search picks the folder out
    // of the path and runs once; an unscoped one runs everywhere and merges.
    const jobs: { mount: Mount; target: string }[] = []
    if (args.path !== undefined) {
      let abs: string
      try {
        abs = ctx.workspace.resolve(args.path)
      } catch (e) {
        return { ok: false, content: (e as Error).message }
      }
      const mount = ctx.workspace.mountFor(abs)
      if (mount === undefined) return { ok: false, content: `${args.path} is not inside this workspace` }
      // Single-folder: hand ripgrep the caller's own spelling, so its output is byte-for-byte
      // what it has always been (`relative()` returns `src\auth.ts` where the model wrote
      // `src/auth.ts`, and that separator reaches the transcript).
      const within = ctx.workspace.multi ? relative(mount.root, abs) : args.path
      jobs.push({ mount, target: within === '' ? '.' : within })
      argv.push('--hidden')
    } else {
      for (const mount of ctx.workspace.mounts) jobs.push({ mount, target: '.' })
    }
    for (const g of DENIED_GLOBS) argv.push('--iglob', g)
    if (args.glob) argv.push('--glob', args.glob)
    argv.push('--regexp', args.pattern)

    /** One ripgrep run, over one folder. Everything about how ripgrep reports itself lives
     * here; the caller only merges. */
    async function runOne(
      job: { mount: Mount; target: string },
    ): Promise<{ ok: true; lines: string[]; stderr: string } | { ok: false; content: string }> {
      // A local wrapper, spawned with concrete literal options, so `ReturnType<typeof spawn>`
      // below resolves to the exact narrowed result shape (numeric exitCode, string stdout).
      // Annotating with `ReturnType<typeof execa>` directly instead picks execa's most
      // generic overload and widens `stdout` to a `string | string[] | Uint8Array` union.
      const spawn = () =>
        execa((resolution as { path: string }).path, [...argv, job.target], {
          cwd: job.mount.root,
          reject: false,
          timeout: 30_000,
          env: RG_ENV,
          ...(ctx.signal ? { cancelSignal: ctx.signal } : {}),
        })

      let result: Awaited<ReturnType<typeof spawn>>
      try {
        result = await spawn()
      } catch (e) {
        // A rejected promise here means ripgrep could not be run at all (e.g. the resolved
        // path stopped existing between the handshake and now) - a spawn failure, never a
        // search result.
        return {
          ok: false,
          content: `search_code failed: ripgrep could not be run (${(e as Error).message})`,
        }
      }

      // Ripgrep's contract: 0 = matches found, 1 = ran fine, no matches, 2 = an error
      // occurred (which may be per-file and non-fatal - see below). `reject: false` also
      // resolves (rather than throws) when the process could not be spawned at all, and in
      // that case `exitCode` is not a number. That must not fall through to "no matches": a
      // search that never ran is not a successful empty result.
      if (typeof result.exitCode !== 'number') {
        return {
          ok: false,
          content:
            `search_code failed: ripgrep did not run (${result.shortMessage ?? 'unknown spawn failure'})`,
        }
      }
      const exitCode = result.exitCode
      if (exitCode !== 0 && exitCode !== 1 && exitCode !== 2) {
        return {
          ok: false,
          content:
            `search_code failed: ripgrep exited with unexpected status ${exitCode}` +
            `${result.stderr ? `: ${summariseStderr(result.stderr)}` : ''}`,
        }
      }

      const stderr = result.stderr.trim()

      // The two shapes a non-ripgrep binary produces when it survives the handshake or when
      // ripgrep itself is wedged. Neither can be a real search result: ripgrep does not exit
      // 0 without printing a match, and it does not exit 1 (no matches) while complaining.
      if (exitCode === 0 && result.stdout.trim() === '') {
        return {
          ok: false,
          content:
            'search_code failed: ripgrep reported matches (exit 0) but printed nothing, so ' +
            'the search cannot be trusted' + (stderr ? `: ${summariseStderr(stderr)}` : ''),
        }
      }
      if (exitCode === 1 && hasNonRipgrepStderr(stderr)) {
        return {
          ok: false,
          // Deliberately avoids the words "no matches": that phrase is what a successful
          // empty search says, and callers (including this suite) key on it. Only reached
          // when some stderr line lacks ripgrep's own `rg: ` prefix - a genuine ripgrep
          // warning (e.g. a malformed ignore-file line) exits 1 with prefixed stderr and
          // falls through to the ordinary "no matches" path below, warning attached.
          content:
            'search_code failed: ripgrep exited 1 (nothing found) but wrote to stderr that ' +
            `is not one of its own diagnostics, so the search did not run as asked: ${summariseStderr(stderr)}`,
        }
      }

      const lines = result.stdout
        .split('\n')
        .map((l) => l.replace(/\r$/, ''))
        .filter((l) => l.trim() !== '')
        .map((line) => addressLine(line, job.mount, ctx.workspace))
        .filter((line): line is string => line !== null)

      // Exit 2 is "an error happened", not "the search is void": ripgrep uses it for
      // non-fatal per-file errors too, and still prints every good match. Verified by
      // denying read access to one file beside a matching one - raw ripgrep printed the
      // real match *and* exited 2, while this tool threw the match away and returned
      // ok: false. One ACL-restricted file, cloud placeholder or locked file must not make
      // search useless workspace-wide. Hard-fail only when there is nothing usable.
      if (exitCode === 2 && lines.length === 0) {
        return { ok: false, content: `search_code failed: ${summariseStderr(stderr) || 'ripgrep reported an error'}` }
      }
      return { ok: true, lines, stderr }
    }

    // Concurrent across folders, ordered on the way out. This used to be a sequential loop,
    // reasoned as "`--sort path` already makes each run single-threaded, and the merge is
    // only well defined if each folder's block arrives whole" — the second half of which is
    // what actually mattered, and it survives: each run still collects into its OWN array
    // and the arrays are concatenated in `jobs` order below, so the merged result is
    // byte-identical to what the loop produced. What does not survive is the first half.
    // Single-threaded is a statement about ONE ripgrep; it is the reason to overlap the
    // folders rather than a reason not to, because a four-folder workspace was spending
    // four single-threaded walks end to end on a machine with cores standing idle.
    const outcomes = await Promise.all(jobs.map(runOne))

    const lines: string[] = []
    const notes: string[] = []
    const failures: string[] = []
    for (const [i, outcome] of outcomes.entries()) {
      const job = jobs[i] as { mount: Mount; target: string }
      if (!outcome.ok) {
        failures.push(ctx.workspace.multi ? `${job.mount.name}: ${outcome.content}` : outcome.content)
        continue
      }
      lines.push(...outcome.lines)
      if (outcome.stderr) {
        notes.push(ctx.workspace.multi ? `${job.mount.name}: ${outcome.stderr}` : outcome.stderr)
      }
    }

    // Every folder failed: there is no result to report, only the failure.
    if (failures.length === jobs.length) return { ok: false, content: failures[0] as string }
    // Some folder failed: the matches from the others are real and are worth more than a
    // refusal, but a search that silently skipped a folder would be a lie by omission.
    const trouble = failures.length > 0 ? `\n(not searched — ${failures.join('; ')})` : ''
    const stderr = notes.join('; ')

    if (lines.length === 0) {
      return { ok: true, content: `No matches for /${args.pattern}/${warningSuffix(stderr)}${trouble}` }
    }

    // Computed from the pre-slice count: `>=` claimed truncation whenever exactly `max`
    // matches existed, which is the common case for a small max_results.
    const capped = lines.length > max ? `\n(stopped at ${max} ${max === 1 ? 'match' : 'matches'})` : ''
    return {
      ok: true,
      content: lines.slice(0, max).map(truncateLine).join('\n') + capped + warningSuffix(stderr) + trouble,
    }
  },
}
