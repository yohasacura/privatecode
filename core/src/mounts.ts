import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { ensurePrivateDir, PRIVATE_DIR } from './private-dir.js'
import type { AgentMode } from './permissions/engine.js'
import {
  DEFAULT_VERIFY_TIMEOUT_MS, MAX_VERIFY_TIMEOUT_MS, type VerifySpec,
} from './verify/config.js'

/**
 * A workspace is one folder that holds the state, plus any number of folders attached to it
 * from anywhere on disk.
 *
 * WHY THE DEFINITION LIVES IN THE PRIMARY FOLDER. VS Code keeps a `.code-workspace` file
 * wherever you put it, which then has to be found again. Here the file is
 * `<primary>/.privatecode/workspace.json`: opening the primary folder restores the whole
 * workspace, nothing new has to be filed anywhere, and every piece of existing state —
 * sessions, checkpoints, settings, the work log — keeps the home it already has. The cost is
 * that one folder is distinguished, which is true of every real project anyway.
 *
 * WHY THE MODEL SEES NAMES AND NOT PATHS. Every mount is addressed as `<name>/rest/of/path`.
 * The absolute path never enters the prompt, which is shorter, keeps the layout of someone's
 * disk out of the context window, and gives permission rules a scope for free: `edit_file(api/**)`
 * now means exactly what it says.
 *
 * WHY ATTACHED FOLDERS DO NOT GET A VOTE. Only the primary folder's settings, hooks,
 * formatter and verify command are ever loaded. An attached repository carrying its own
 * `.privatecode/settings.json` that grants `edit_file(**)`, or a `verify` command that runs,
 * would be an escalation by reference — you pointed at a folder to read it and it reconfigured
 * the agent. Per-folder verify commands live in the primary's `workspace.json` instead.
 */

/**
 * `read` folders are refused by the jail itself, above the permission engine, so no rule can
 * open them. This binds the file tools; `run_command` was never contained by the jail and
 * still is not.
 */
export type MountAccess = 'write' | 'read'

export interface Mount {
  /** Model-visible name. Unique within the workspace, never contains a separator. */
  name: string
  /** Absolute, resolved. */
  root: string
  access: MountAccess
  /** Exactly one mount is primary, and it is always first. */
  primary: boolean
}

/** One attached folder as stored on disk. */
export interface FolderSpec {
  /** Relative to the primary folder when they share a drive, absolute otherwise. */
  path: string
  name?: string
  access?: MountAccess
}

/**
 * What this particular combination of folders is FOR.
 *
 * A workspace is not only a set of folders, it is a way of working with them: the production
 * repository beside its reference wants `normal` mode and a real test command; a scratch pile
 * wants `autopilot` and no checks at all. Without this, both open the same way and the mode
 * has to be set by hand on every launch — which means it eventually is not.
 *
 * Lives in the primary folder's `workspace.json` and nowhere else, for the same reason
 * settings do: a verify command is a shell command, and an attached folder that could supply
 * one would be running code by reference.
 */
export interface WorkspaceProfile {
  /** Mode a new session starts in. Absent keeps `normal`, which is what it has always been. */
  mode?: AgentMode
  /** Folder name -> its check. A string is the command; the object form adds a timeout. */
  verify?: Record<string, string | { command: string; timeoutMs?: number }>
}

export interface WorkspaceFile {
  version: 1
  /** What to call the whole thing in the window. Defaults to the primary folder's name. */
  name?: string
  folders: FolderSpec[]
  profile?: WorkspaceProfile
}

const MODES: readonly AgentMode[] = ['normal', 'plan', 'auto-edit', 'autopilot']

/**
 * The profile, validated, with every rejection reported rather than silently dropped.
 *
 * A folder name that matches nothing is the one worth saying out loud: it looks like a
 * configured check and is in fact a check that will never run, which is exactly the shape of
 * "I thought that was covered".
 */
export function readProfile(
  file: WorkspaceFile | null, mounts: readonly Mount[], where: string,
): { mode?: AgentMode; verify: Record<string, VerifySpec>; problems: string[] } {
  const problems: string[] = []
  const verify: Record<string, VerifySpec> = {}
  const profile = file?.profile
  if (profile === undefined || profile === null || typeof profile !== 'object') {
    return { verify, problems }
  }

  let mode: AgentMode | undefined
  if (profile.mode !== undefined) {
    if (MODES.includes(profile.mode)) mode = profile.mode
    else problems.push(`${where}: profile.mode "${String(profile.mode)}" is not one of ${MODES.join(', ')}; ignored`)
  }

  if (profile.verify !== undefined) {
    if (typeof profile.verify !== 'object' || Array.isArray(profile.verify)) {
      problems.push(`${where}: profile.verify must be an object of folder name -> command`)
    } else {
      for (const [folder, value] of Object.entries(profile.verify)) {
        if (!mounts.some((m) => m.name === folder)) {
          problems.push(`${where}: profile.verify names "${folder}", which is not a folder in this workspace; it will never run`)
          continue
        }
        const command = typeof value === 'string' ? value : value?.command
        if (typeof command !== 'string' || command.trim() === '') {
          problems.push(`${where}: profile.verify."${folder}" must be a command string`)
          continue
        }
        const raw = typeof value === 'string' ? undefined : value.timeoutMs
        let timeoutMs = DEFAULT_VERIFY_TIMEOUT_MS
        if (raw !== undefined) {
          if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
            problems.push(`${where}: profile.verify."${folder}".timeoutMs must be a positive number of milliseconds`)
          } else {
            timeoutMs = Math.min(raw, MAX_VERIFY_TIMEOUT_MS)
          }
        }
        verify[folder] = { command: command.trim(), timeoutMs, source: `${where} (profile)` }
      }
    }
  }

  return { ...(mode !== undefined ? { mode } : {}), verify, problems }
}

export const WORKSPACE_FILE = 'workspace.json'

/** Anything that is not one of these becomes `-`, so a name can never be read as a path. */
const UNSAFE_IN_NAME = /[^A-Za-z0-9._-]+/g

export function workspaceFilePath(primaryRoot: string): string {
  return join(primaryRoot, PRIVATE_DIR, WORKSPACE_FILE)
}

/**
 * A short, path-safe name for a folder. `.` and `..` are refused outright rather than
 * sanitised: a mount called `..` would make every path through it read as an escape attempt.
 */
function sanitizeName(raw: string): string {
  const cleaned = raw.replace(UNSAFE_IN_NAME, '-').replace(/^-+|-+$/g, '')
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return ''
  return cleaned
}

/**
 * The name a folder gets when nobody chose one: its own basename, made path-safe and made
 * unique. A drive root has no basename, so it becomes its drive letter.
 *
 * Uniqueness is case-insensitive because the target filesystem is: `API` and `api` naming two
 * different folders would resolve to whichever one the comparison happened to reach first.
 */
export function mountName(root: string, taken: ReadonlySet<string>): string {
  const abs = resolve(root)
  let base = sanitizeName(basename(abs))
  if (base === '') base = sanitizeName(abs.replace(/[:\\/]/g, '')) || 'folder'
  return uniqueName(base, taken)
}

/** `name`, or `name-2`, `name-3`, … when it is spoken for. */
export function uniqueName(base: string, taken: ReadonlySet<string>): string {
  const lower = new Set([...taken].map((t) => t.toLowerCase()))
  if (!lower.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!lower.has(candidate.toLowerCase())) return candidate
  }
}

/** Whether `child` is `parent` or sits underneath it. */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export interface LoadedWorkspace {
  mounts: Mount[]
  /** The workspace's display name. */
  name: string
  /** The parsed file, or null when this is a plain single-folder workspace. */
  file: WorkspaceFile | null
  problems: string[]
}

function readWorkspaceFile(primaryRoot: string, problems: string[]): WorkspaceFile | null {
  const path = workspaceFilePath(primaryRoot)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      problems.push(`Could not read ${path}: ${(e as Error).message}`)
    }
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    problems.push(`${path} is not valid JSON (${(e as Error).message}); opening the folder on its own`)
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    problems.push(`${path} must be a JSON object; opening the folder on its own`)
    return null
  }

  const obj = parsed as Partial<WorkspaceFile>
  const folders: FolderSpec[] = []
  if (obj.folders !== undefined) {
    if (!Array.isArray(obj.folders)) {
      problems.push(`${path}: "folders" must be an array; ignoring it`)
    } else {
      for (const entry of obj.folders) {
        if (typeof entry !== 'object' || entry === null) {
          problems.push(`${path}: a folder entry is not an object; skipped`)
          continue
        }
        const spec = entry as Partial<FolderSpec>
        if (typeof spec.path !== 'string' || spec.path.trim() === '') {
          problems.push(`${path}: a folder entry has no "path"; skipped`)
          continue
        }
        const access: MountAccess | undefined = spec.access === 'read'
          ? 'read'
          : spec.access === 'write' || spec.access === undefined
            ? 'write'
            : undefined
        if (access === undefined) {
          problems.push(`${path}: folder "${spec.path}" has access "${String(spec.access)}"; must be "write" or "read". Treated as read.`)
        }
        folders.push({
          path: spec.path,
          ...(typeof spec.name === 'string' && spec.name.trim() !== '' ? { name: spec.name } : {}),
          access: access ?? 'read',
        })
      }
    }
  }

  return {
    version: 1,
    ...(typeof obj.name === 'string' && obj.name.trim() !== '' ? { name: obj.name.trim() } : {}),
    folders,
    ...(obj.profile !== undefined ? { profile: obj.profile } : {}),
  }
}

/**
 * The mounts a session runs on, primary first.
 *
 * Degrades rather than refuses, on every axis: a missing file, unparseable JSON, a folder that
 * has been moved or deleted, a name collision or an overlapping folder each produce a problem
 * and leave the rest of the workspace working. Refusing to open a workspace because one of
 * five folders was renamed would be the worse failure.
 */
export function loadMounts(primaryRoot: string): LoadedWorkspace {
  const problems: string[] = []
  const root = resolve(primaryRoot)
  const primary: Mount = {
    name: mountName(root, new Set()),
    root,
    access: 'write',
    primary: true,
  }

  const file = readWorkspaceFile(root, problems)
  if (file === null || file.folders.length === 0) {
    return { mounts: [primary], name: file?.name ?? primary.name, file, problems }
  }

  const mounts: Mount[] = [primary]
  const taken = new Set([primary.name])
  for (const spec of file.folders) {
    const abs = isAbsolute(spec.path) ? resolve(spec.path) : resolve(root, spec.path)

    let stats
    try {
      stats = statSync(abs)
    } catch {
      problems.push(`Folder "${spec.name ?? basename(abs)}" is no longer at ${abs}; it is not part of this workspace until you point it somewhere else.`)
      continue
    }
    if (!stats.isDirectory()) {
      problems.push(`${abs} is a file, not a folder; skipped`)
      continue
    }

    // Overlapping mounts would give one file two names: two entries in the map, two
    // checkpoint units covering the same bytes, and an edit whose path depends on which name
    // the model happened to pick.
    const overlap = mounts.find((m) => isInside(abs, m.root) || isInside(m.root, abs))
    if (overlap) {
      problems.push(`Folder ${abs} overlaps "${overlap.name}" (${overlap.root}); one of the two has to go, so it was skipped.`)
      continue
    }

    // The name a person chose, or the folder's own. Deduped afterwards either way, and the
    // rename is always reported: `api` and `api-2` in the file tree is only readable if you
    // were told which of the two got renamed.
    const chosen = spec.name === undefined ? '' : sanitizeName(spec.name)
    if (spec.name !== undefined && chosen === '') {
      problems.push(`Folder ${abs} is named "${spec.name}", which cannot be used as a path; naming it after the folder instead.`)
    }
    const base = chosen === '' ? mountName(abs, new Set()) : chosen
    const name = uniqueName(base, taken)
    if (name !== base) {
      problems.push(`Two folders are called "${base}"; the second one is "${name}".`)
    }

    taken.add(name)
    mounts.push({ name, root: abs, access: spec.access ?? 'write', primary: false })
  }

  return { mounts, name: file.name ?? primary.name, file, problems }
}

/**
 * Stores a folder's path relative to the primary when they share a drive, so moving a whole
 * tree keeps the workspace intact. Across drives `relative()` hands back the absolute target,
 * which is exactly what should be stored then.
 */
export function storedPath(primaryRoot: string, folderRoot: string): string {
  const rel = relative(resolve(primaryRoot), resolve(folderRoot))
  if (rel === '' || isAbsolute(rel)) return resolve(folderRoot)
  return rel
}

/**
 * Writes the definition. Called by the window, never by the model — `.privatecode/` is denied
 * to every model-issued write, which is what keeps a workspace from attaching folders to
 * itself mid-turn.
 */
export function saveWorkspaceFile(primaryRoot: string, file: WorkspaceFile): void {
  ensurePrivateDir(primaryRoot)
  writeFileSync(workspaceFilePath(primaryRoot), `${JSON.stringify(file, null, 2)}\n`, 'utf8')
}

/** Whether this folder has a workspace definition at all. */
export function hasWorkspaceFile(primaryRoot: string): boolean {
  return existsSync(workspaceFilePath(primaryRoot))
}
