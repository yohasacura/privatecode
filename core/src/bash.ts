import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { killTree } from './powershell.js'

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
  const path = [bash.binDir, ...extraPath, process.env[key] ?? ''].filter((p) => p !== '').join(delimiter)
  return {
    ...process.env,
    [key]: path,
    HOME: process.env['HOME'] ?? process.env['USERPROFILE'] ?? homedir(),
    LANG: process.env['LANG'] ?? 'C.UTF-8',
    TERM: 'dumb',
  }
}

/** argv for `bash.exe <command>`: one string, read by bash exactly as typed. */
export function bashArgs(command: string): string[] {
  return ['-c', command]
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
