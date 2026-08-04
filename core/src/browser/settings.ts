import { readFileSync } from 'node:fs'
import { localSettingsPath, projectSettingsPath, userSettingsPath } from '../permissions/settings.js'
import type { BrowserOptions } from './manager.js'

/**
 * Browser settings, from the same three files everything else is configured in.
 *
 * ```json
 * { "browser": { "headless": false, "exePath": "C:\\...\\msedge.exe" } }
 * ```
 *
 * `headless` defaults to FALSE. The agent driving a visible window is not a debugging aid,
 * it is the point: someone watching an unattended run needs to see what the page is doing,
 * and a browser that works invisibly is one whose failures are only legible after the fact.
 * Anyone who wants it out of the way sets one line.
 */

export interface LoadedBrowserSettings {
  options: BrowserOptions
  problems: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readLayer(path: string, scope: string, problems: string[]): BrowserOptions {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      problems.push(`Could not read ${path}: ${(e as Error).message}`)
    }
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {} // the permission loader already reports this file as unparseable
  }
  if (!isRecord(parsed)) return {}
  const browser = parsed['browser']
  if (browser === undefined) return {}
  if (!isRecord(browser)) {
    problems.push(`"browser" in ${scope} settings must be an object; ignoring it`)
    return {}
  }

  const options: BrowserOptions = {}
  const headless = browser['headless']
  if (headless !== undefined) {
    if (typeof headless !== 'boolean') {
      problems.push(`"browser.headless" in ${scope} settings must be true or false; ignoring it`)
    } else {
      options.headless = headless
    }
  }
  const exePath = browser['exePath']
  if (exePath !== undefined) {
    if (typeof exePath !== 'string' || exePath.trim() === '') {
      problems.push(`"browser.exePath" in ${scope} settings must be a path; ignoring it`)
    } else {
      options.exePath = exePath
    }
  }
  return options
}

/** Later layers win, field by field — the same precedence permissions use. */
export function loadBrowserSettings(workspaceRoot: string): LoadedBrowserSettings {
  const problems: string[] = []
  const options: BrowserOptions = {}
  for (const [scope, path] of [
    ['user', userSettingsPath()],
    ['project', projectSettingsPath(workspaceRoot)],
    ['local', localSettingsPath(workspaceRoot)],
  ] as const) {
    Object.assign(options, readLayer(path, scope, problems))
  }
  return { options, problems }
}
