import { existsSync, readdirSync, rmSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { isWindowsDeviceName } from './device-names.js'
import { killTree } from './powershell.js'
import { bundledSkillsDir } from './skills/skills.js'

/**
 * The one place that knows how to find and launch bash.
 *
 * `Bash` is Claude Code's shell tool, and on Windows Claude Code runs it under Git Bash.
 * PrivateCode ships that shell rather than assuming it: `vendor/git/usr/bin/` holds bash and
 * the coreutils out of Git for Windows' own portable distribution (scripts/fetch-vendor.mjs,
 * vendor/git/PROVENANCE.md), staged beside the sidecar. A machine that installed Git for
 * Windows itself is the fallback, `PRIVATECODE_BASH` the override — and with none of the
 * three, the callers say so rather than pretending PowerShell is bash.
 *
 * The vendored `usr/bin` goes FIRST on the child's PATH: `ls`, `grep`, `sed`, `find` and
 * `sleep` are then the ones that came with bash, whatever else the machine has, and `git`,
 * `node`, `python` still resolve from the machine's own PATH after them. Windows' own
 * `curl.exe` and `tar.exe` (System32) are reached the same way.
 */

export interface BashLocation {
  exe: string
  /** The folder of coreutils to put first on PATH. */
  binDir: string
  source: 'env' | 'vendored' | 'git-for-windows'
}

/** Where this module sits, or null in the CommonJS bundle (see `bundledSkillsDir`). */
function moduleDir(): string | null {
  const url = import.meta.url as string | undefined
  if (typeof url !== 'string' || url === '') return null
  return dirname(fileURLToPath(url))
}

/** The vendored copy: `vendor/git` in a checkout, `vendor/git` beside the bundled sidecar. */
function vendoredCandidates(): string[] {
  const out: string[] = []
  const here = moduleDir()
  if (here !== null) out.push(join(here, '..', '..', 'vendor', 'git'), join(here, 'vendor', 'git'))
  const script = process.argv[1]
  if (script !== undefined) out.push(join(dirname(script), 'vendor', 'git'))
  return out
}

export function findBash(): BashLocation | null {
  const named = process.env['PRIVATECODE_BASH']
  if (named !== undefined && named !== '' && existsSync(named)) {
    return { exe: named, binDir: dirname(named), source: 'env' }
  }
  for (const root of vendoredCandidates()) {
    const exe = join(root, 'usr', 'bin', 'bash.exe')
    if (existsSync(exe)) return { exe, binDir: dirname(exe), source: 'vendored' }
  }
  if (process.platform !== 'win32') {
    return existsSync('/bin/bash') ? { exe: '/bin/bash', binDir: '/usr/bin', source: 'git-for-windows' } : null
  }
  const roots = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'],
    process.env['LOCALAPPDATA'] !== undefined ? join(process.env['LOCALAPPDATA'], 'Programs') : undefined]
  for (const root of roots) {
    if (root === undefined) continue
    const exe = join(root, 'Git', 'usr', 'bin', 'bash.exe')
    if (existsSync(exe)) return { exe, binDir: dirname(exe), source: 'git-for-windows' }
  }
  return null
}

/** The child's environment: the shell's coreutils first, then any extra folders, then PATH. */
export function bashEnv(bash: BashLocation, extraPath: readonly string[] = []): NodeJS.ProcessEnv {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  // The runtime this very process runs on — the vendored node.exe beside agent.cjs in a
  // release, the machine's node in a checkout — so `node` is on the tool's PATH on a machine
  // that never installed one. The bundled pptx skill is a node script, and a skill that only
  // works where node happens to be installed is a skill that works on the author's machine.
  const path = [bash.binDir, ...extraPath, dirname(process.execPath), process.env[key] ?? ''].filter((p) => p !== '').join(delimiter)
  // Where the bundled skills are, as a variable the model can write literally:
  // `node "$PRIVATECODE_SKILLS/pptx/pptx.cjs"`. Seen live: told the folder's path in prose,
  // the model wrote `$SKILL/pptx.cjs` — a variable nobody had set, which bash expanded to
  // nothing — and lost a step finding the absolute path. A variable that exists costs nothing.
  const skills = bundledSkillsDir()
  return {
    ...process.env,
    [key]: path,
    ...(skills !== null ? { PRIVATECODE_SKILLS: skills } : {}),
    HOME: process.env['HOME'] ?? process.env['USERPROFILE'] ?? homedir(),
    LANG: process.env['LANG'] ?? 'C.UTF-8',
    TERM: 'dumb',
  }
}

/**
 * A redirect to cmd.exe's `nul`, and the `/dev/null` it meant.
 *
 * To this shell a bare `nul` after `>`, `2>`, `>>`, `&>` or `<` is a relative path, and
 * the file it creates is the one `device-names.ts` describes: real, and undeletable by
 * anything that goes through Win32. Rewritten rather than refused, because the intention —
 * discard this stream — is not in doubt, and a refusal would cost the step it takes to
 * re-issue the command. Quoted `"nul"` and any case are the same mistake. `nul.txt` is not
 * matched here: it is a different mistake, and `removeDeviceNamedFiles` catches the file.
 */
const DEVICE_REDIRECT = /((?:^|[\s;&|(])(?:\d?>>?|&>|<)\s*)(["']?)nul\2(?=$|[\s;&|)])/gi

export function rewriteDeviceRedirects(command: string): { command: string; rewritten: boolean } {
  let rewritten = false
  const out = command.replace(DEVICE_REDIRECT, (_match, prefix: string) => {
    rewritten = true
    return `${prefix}/dev/null`
  })
  return { command: out, rewritten }
}

/**
 * Deletes every file in `dir` that carries a Windows device name, and returns their names.
 *
 * The `\\?\` prefix is the one way to address such a file: it turns the reserved-name
 * parsing off, which is why the file could be created through the NT API and cannot be
 * touched without it. Windows only — elsewhere `nul` is an ordinary file and none of this
 * code's business. Cheap: one directory listing.
 */
export function removeDeviceNamedFiles(dir: string): string[] {
  if (process.platform !== 'win32') return []
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const removed: string[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !isWindowsDeviceName(entry.name)) continue
    try {
      rmSync(`\\\\?\\${resolve(dir, entry.name)}`, { force: true })
      removed.push(entry.name)
    } catch { /* still there; the note names only what is gone */ }
  }
  return removed.sort()
}

/** argv for `bash.exe <command>`: one string, read by bash as typed — bar cmd.exe's `nul`. */
export function bashArgs(command: string): string[] {
  return ['-c', rewriteDeviceRedirects(command).command]
}

/** The spawn itself, split out so its concrete option types survive into `runBash`. */
export function spawnBash(bash: BashLocation, command: string, opts: { cwd: string; extraPath?: readonly string[]; buffer?: boolean }) {
  return execa(bash.exe, bashArgs(command), {
    cwd: opts.cwd,
    env: bashEnv(bash, opts.extraPath ?? []),
    extendEnv: false,
    reject: false,
    windowsHide: true,
    all: true,
    ...(opts.buffer === false ? { buffer: false } : {}),
  })
}

/**
 * Run one bash command to completion, where a timeout or an abort takes down the whole
 * process tree — the same discipline `runPowershell` follows, for the same reason.
 */
export async function runBash(
  bash: BashLocation,
  command: string,
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal | undefined; extraPath?: readonly string[] },
): Promise<{
  result: Awaited<ReturnType<typeof spawnBash>>
  stopped: 'cancelled' | 'timeout' | null
}> {
  const child = spawnBash(bash, command, { cwd: opts.cwd, ...(opts.extraPath !== undefined ? { extraPath: opts.extraPath } : {}) })
  let stopped: 'cancelled' | 'timeout' | null = null
  const stop = async (reason: 'cancelled' | 'timeout'): Promise<void> => {
    if (stopped !== null) return
    stopped = reason
    await killTree(child)
  }
  const timer = setTimeout(() => { void stop('timeout') }, opts.timeoutMs)
  const onAbort = (): void => { void stop('cancelled') }
  opts.signal?.addEventListener('abort', onAbort)
  const result = await child.finally(() => {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
  })
  return { result, stopped }
}
