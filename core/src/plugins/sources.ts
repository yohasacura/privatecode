import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { execa } from 'execa'
import type { MarketplaceSource } from './store.js'

/**
 * Where marketplaces and plugins come from, and how each is brought onto this machine
 * (docs/PLUGINS-2026-09.md §3). Everything a person types after `marketplace add` is
 * parsed here; everything a marketplace entry's `source` names is fetched here.
 *
 * Git does the git work — `execa('git', …)`, the same way the checkpoint store drives it —
 * and a zip is unpacked by the `tar` that ships with Windows 10 and later. Nothing here runs
 * a command a plugin wrote: a `command` source is refused (§7).
 */

const GIT_TIMEOUT_MS = 120_000
const FETCH_TIMEOUT_MS = 60_000

/**
 * What `/plugin marketplace add <text>` was given.
 *
 * The rules are Claude Code's: `owner/repo` and `owner/repo@ref` are GitHub; an `https://`
 * URL ending in `marketplace.json` is a hosted file; a `github.com`/`gitlab.com` URL, an
 * `.git` URL, an `ssh` address or a `/_git/` path is a repository (`#ref` selects a ref);
 * anything that exists on disk is a directory (or a `marketplace.json` in one). A host typed
 * without `https://` is refused with the fix, as Claude Code refuses it.
 */
export function parseMarketplaceSource(text: string, cwd: string = process.cwd()): { source: MarketplaceSource } | { error: string } {
  const raw = text.trim()
  if (raw === '') return { error: 'say where the marketplace is: owner/repo, a git URL, a marketplace.json URL, or a folder' }

  // A path first: `./x`, `C:\x`, `x/marketplace.json`, or anything that exists here.
  const asPath = isAbsolute(raw) ? raw : resolve(cwd, raw)
  if (raw.startsWith('./') || raw.startsWith('../') || raw.startsWith('.\\') || isAbsolute(raw) || existsSync(asPath)) {
    if (!existsSync(asPath)) return { error: `${raw} does not exist` }
    const dir = basename(asPath).toLowerCase() === 'marketplace.json' ? resolve(asPath, '..', '..') : asPath
    if (!statSync(dir).isDirectory()) return { error: `${raw} is not a directory` }
    return { source: { source: 'directory', path: dir } }
  }

  if (/^git@[^:]+:.+/.test(raw)) {
    const [url, ref] = splitRef(raw)
    return { source: { source: 'git', url, ...(ref !== undefined ? { ref } : {}) } }
  }

  if (/^https?:\/\//i.test(raw)) {
    const [url, ref] = splitRef(raw)
    let parsed: URL
    try { parsed = new URL(url) } catch { return { error: `${raw} is not a URL` } }
    const host = parsed.hostname.toLowerCase()
    const path = parsed.pathname
    if (/marketplace\.json$/i.test(path)) return { source: { source: 'url', url } }
    const isRepo = host === 'github.com' || host === 'gitlab.com' || host.endsWith('.gitlab.com') || /\.git$/i.test(path) || path.includes('/_git/')
    if (isRepo) {
      if (host === 'github.com' && !/\.git$/i.test(path)) {
        const m = /^\/([^/]+)\/([^/]+?)(?:\/tree\/([^/]+))?\/?$/.exec(path)
        if (m !== null) return { source: { source: 'github', repo: `${m[1]}/${m[2]}`, ...((m[3] ?? ref) !== undefined ? { ref: (m[3] ?? ref) as string } : {}) } }
      }
      return { source: { source: 'git', url, ...(ref !== undefined ? { ref } : {}) } }
    }
    return { error: `${raw} is neither a git repository nor a marketplace.json. For a git host that is not github.com or gitlab.com, end the URL with .git` }
  }

  // A GitHub owner has no dots, which is what tells `owner/repo` from `host.com/path`.
  const shorthand = /^([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+?)(?:@([^\s]+))?$/.exec(raw)
  if (shorthand !== null) {
    return { source: { source: 'github', repo: `${shorthand[1]}/${shorthand[2]}`, ...(shorthand[3] !== undefined ? { ref: shorthand[3] } : {}) } }
  }
  if (/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}\//.test(raw)) {
    return { error: `${raw} looks like a host without its scheme — add https:// (and .git for a git host that is not github.com or gitlab.com)` }
  }
  return { error: `${raw} is not owner/repo, a git URL, a marketplace.json URL or a folder` }
}

function splitRef(url: string): [string, string | undefined] {
  const hash = url.indexOf('#')
  if (hash === -1) return [url, undefined]
  const ref = url.slice(hash + 1).trim()
  return [url.slice(0, hash), ref === '' ? undefined : ref]
}

export function describeMarketplaceSource(source: MarketplaceSource): string {
  switch (source.source) {
    case 'github': return `github.com/${source.repo}${source.ref !== undefined ? `@${source.ref}` : ''}`
    case 'git': return `${source.url}${source.ref !== undefined ? `#${source.ref}` : ''}`
    case 'url': return source.url
    case 'directory': return source.path
  }
}

export function githubUrl(repo: string): string {
  return `https://github.com/${repo}.git`
}

// ---- git ------------------------------------------------------------------------------------

async function git(args: string[], cwd?: string): Promise<string> {
  const result = await execa('git', args, {
    ...(cwd !== undefined ? { cwd } : {}),
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    reject: false,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().split('\n').slice(-3).join(' ')
    throw new Error(`git ${args[0]} failed: ${detail || `exit ${result.exitCode}`}`)
  }
  return result.stdout
}

export async function gitAvailable(): Promise<boolean> {
  try { await git(['--version']); return true } catch { return false }
}

export interface CloneOptions { ref?: string; sha?: string }

/**
 * Clones `url` into `dest`. Shallow at the tip of `ref` (or the default branch); when a
 * `sha` is pinned, that commit is fetched and checked out — the pin is what makes a
 * community catalog safe to install from, so it is honoured, not treated as a hint.
 */
export async function cloneRepo(url: string, dest: string, opts: CloneOptions = {}): Promise<{ sha: string }> {
  mkdirSync(resolve(dest, '..'), { recursive: true })
  if (opts.sha !== undefined) {
    await git(['clone', '--no-checkout', '--filter=blob:none', url, dest])
    try {
      await git(['fetch', '--depth', '1', 'origin', opts.sha], dest)
    } catch {
      // A server that refuses to serve a bare commit: take the whole history, once.
      await git(['fetch', '--unshallow', 'origin'], dest).catch(() => git(['fetch', 'origin'], dest))
    }
    await git(['checkout', '--quiet', opts.sha], dest)
    return { sha: (await git(['rev-parse', 'HEAD'], dest)).trim() }
  }
  const args = ['clone', '--depth', '1']
  if (opts.ref !== undefined) args.push('--branch', opts.ref)
  args.push(url, dest)
  await git(args)
  return { sha: (await git(['rev-parse', 'HEAD'], dest)).trim() }
}

/** Brings a clone to the tip of what it tracks. Returns the commit it now sits on. */
export async function updateClone(dest: string, opts: CloneOptions = {}): Promise<{ sha: string; changed: boolean }> {
  const before = (await git(['rev-parse', 'HEAD'], dest)).trim()
  if (opts.sha !== undefined) {
    if (before === opts.sha) return { sha: before, changed: false }
    try { await git(['fetch', '--depth', '1', 'origin', opts.sha], dest) } catch { await git(['fetch', 'origin'], dest) }
    await git(['checkout', '--quiet', opts.sha], dest)
    return { sha: opts.sha, changed: true }
  }
  const branch = opts.ref ?? (await git(['rev-parse', '--abbrev-ref', 'HEAD'], dest)).trim()
  await git(['fetch', '--depth', '1', 'origin', branch === 'HEAD' ? 'HEAD' : branch], dest)
  await git(['reset', '--hard', '--quiet', 'FETCH_HEAD'], dest)
  const after = (await git(['rev-parse', 'HEAD'], dest)).trim()
  return { sha: after, changed: after !== before }
}

export function isGitClone(dir: string): boolean {
  return existsSync(join(dir, '.git'))
}

/** The commit a clone sits on. */
export async function headSha(dest: string): Promise<string> {
  return (await git(['rev-parse', 'HEAD'], dest)).trim()
}

/**
 * Removes a directory that may be a clone. Git marks its pack files read-only, which on
 * Windows can turn an unlink into EPERM; the retry clears the attribute first.
 */
export function removeTree(dir: string): void {
  if (!existsSync(dir)) return
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 2 })
  } catch {
    clearReadOnly(dir)
    rmSync(dir, { recursive: true, force: true, maxRetries: 2 })
  }
}

function clearReadOnly(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) clearReadOnly(p)
    else { try { chmodSync(p, 0o666) } catch { /* already gone */ } }
  }
}

// ---- files -----------------------------------------------------------------------------------

/** Copies a plugin's files, leaving `.git` and `node_modules` behind. */
export function copyTree(from: string, to: string): void {
  mkdirSync(resolve(to, '..'), { recursive: true })
  cpSync(from, to, {
    recursive: true,
    dereference: false,
    filter: (src) => {
      const name = basename(src)
      return name !== '.git' && name !== 'node_modules'
    },
  })
}

/**
 * A fingerprint of a directory's contents: relative paths and sizes, hashed. The version
 * of a plugin that has no version of its own and no commit to name (a local folder, an
 * archive) — so an edit is an update and an unchanged folder is not.
 */
export function hashTree(dir: string): string {
  const hash = createHash('sha256')
  const walk = (d: string, rel: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const p = join(d, entry.name)
      const r = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(p, r)
      else if (entry.isFile()) {
        const s = statSync(p)
        hash.update(`${r}\0${s.size}\0${Math.floor(s.mtimeMs)}\n`)
      }
    }
  }
  walk(dir, '')
  return hash.digest('hex').slice(0, 12)
}

export async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' })
  if (!response.ok) throw new Error(`${url} answered ${response.status} ${response.statusText}`)
  return await response.text()
}

/**
 * Downloads a zip and unpacks it into `dest`. When the archive holds one top-level folder
 * — the usual shape of a release archive — that folder's contents become the plugin.
 */
export async function fetchArchive(url: string, dest: string, sha256?: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' })
  if (!response.ok) throw new Error(`${url} answered ${response.status} ${response.statusText}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (sha256 !== undefined) {
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest.toLowerCase() !== sha256.toLowerCase()) {
      throw new Error(`${url}: the archive's sha256 is ${digest}, not the ${sha256} the marketplace pinned — not installed`)
    }
  }
  const scratch = mkdtempSync(join(resolve(dest, '..'), '.unpack-'))
  try {
    const zip = join(scratch, 'plugin.zip')
    writeFileSync(zip, bytes)
    const out = join(scratch, 'out')
    mkdirSync(out)
    const result = await execa('tar', ['-xf', zip, '-C', out], { timeout: GIT_TIMEOUT_MS, windowsHide: true, reject: false })
    if (result.exitCode !== 0) throw new Error(`could not unpack ${url}: ${(result.stderr || '').trim().split('\n').pop() ?? `exit ${result.exitCode}`}`)
    const top = readdirSync(out, { withFileTypes: true }).filter((e) => e.name !== '__MACOSX')
    const root = top.length === 1 && top[0]!.isDirectory() ? join(out, top[0]!.name) : out
    copyTree(root, dest)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** A scratch directory beside the cache, removed by the caller. */
export function scratchDir(under: string): string {
  mkdirSync(under, { recursive: true })
  return mkdtempSync(join(under, '.tmp-'))
}
