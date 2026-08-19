import { appendFileSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { ensureStateDir, statePath } from '../private-dir.js'
import { type Checkpoint, CheckpointStore } from './store.js'
import type { SnapshotUnit } from './units.js'

/**
 * The undo history of a workspace that is more than one snapshot unit.
 *
 * A checkpoint used to be a commit. Once there are several units — folders from different
 * drives, a nested repository inside one of them — a checkpoint is a SET of commits, one per
 * unit, and something has to record which commits belong together. That is this file's
 * manifest: one append-only line per checkpoint, mapping a set id to each unit's sha.
 *
 * With a single unit and nothing nested, every call here delegates straight to the one store
 * and no manifest is written at all. That is deliberate: the overwhelmingly common workspace
 * must behave exactly as it did, byte for byte, including its existing history.
 */

/** One checkpoint across every unit. */
interface CheckpointSetRecord {
  id: string
  at: string
  sessionId?: string
  turn?: number
  /** Which step of that turn, for a snapshot taken while the turn was still running. The
   * single-store path carries this in the commit subject; a set has no commit of its own, so
   * it has to be written down here or a long turn contributes rows that all read "after turn
   * N" and cannot be told apart. */
  step?: number
  summary: string
  /** unit id -> commit sha. A unit with no history yet is simply absent. */
  units: Record<string, string>
}

const MANIFEST_DIR = 'checkpoints'
const MANIFEST_FILE = 'sets.jsonl'

export class CheckpointSet {
  readonly problems: string[] = []

  private readonly stores: CheckpointStore[]
  private readonly units: readonly SnapshotUnit[]
  private readonly primaryRoot: string
  private readonly manifestPath: string
  private readonly single: CheckpointStore | null

  constructor(units: readonly SnapshotUnit[], primaryRoot: string) {
    this.units = units
    this.stores = units.map((u) => new CheckpointStore(u))
    this.primaryRoot = primaryRoot
    this.manifestPath = statePath(primaryRoot, MANIFEST_DIR, MANIFEST_FILE)
    // One unit and nothing nested inside it: the old world, untouched.
    this.single = units.length === 1 ? this.stores[0]! : null
  }

  /** Each store's own problems, prefixed with which folder they came from when there are
   * several — "checkpoints are unavailable" is not actionable without knowing where. */
  private collectProblems(): void {
    for (const [i, store] of this.stores.entries()) {
      for (const problem of store.problems.splice(0)) {
        this.problems.push(this.single ? problem : `${this.units[i]!.label}: ${problem}`)
      }
    }
  }

  async available(): Promise<boolean> {
    const results = await Promise.all(this.stores.map((s) => s.available()))
    this.collectProblems()
    return results.some(Boolean)
  }

  /**
   * Snapshots every unit, and records which commits that produced.
   *
   * `null` means nothing changed anywhere, which is the ordinary result of a read-only turn.
   * A turn that touched one folder still produces a whole set: the units that did not change
   * contribute their existing head, so the set describes the state of the WORKSPACE and a
   * rewind to it puts every folder back where it was.
   */
  async take(label: { sessionId?: string; turn?: number; step?: number } = {}): Promise<Checkpoint | null> {
    if (this.single) {
      const only = await this.single.take(label)
      // The single-unit path skipped this, and it is the path almost every workspace takes.
      // `CheckpointStore` reports its failures by pushing onto `problems` and returning null
      // -- it does not throw -- so without collecting them here every one of them was
      // stranded on an object nothing reads. The loudest case is not a mid-run disk failure
      // but the first launch on a machine with no git on PATH: every checkpoint quietly does
      // nothing, History says "No checkpoints yet" forever, and the reason is written down
      // in a place no code path can reach.
      this.collectProblems()
      return only
    }

    const taken = await Promise.all(this.stores.map((s) => s.take(label)))
    this.collectProblems()
    if (taken.every((t) => t === null)) return null

    const units: Record<string, string> = {}
    const parts: string[] = []
    for (const [i, store] of this.stores.entries()) {
      const unit = this.units[i]!
      const head = taken[i] ?? await store.headCheckpoint()
      if (head === null) continue
      units[unit.id] = head.id
      if (taken[i]) parts.push(`${unit.label} ${head.summary}`)
    }
    if (Object.keys(units).length === 0) return null

    const record: CheckpointSetRecord = {
      id: `cp-${String(this.count() + 1).padStart(4, '0')}`,
      at: new Date().toISOString(),
      ...(label.sessionId !== undefined ? { sessionId: label.sessionId } : {}),
      ...(label.turn !== undefined ? { turn: label.turn } : {}),
      ...(label.step !== undefined ? { step: label.step } : {}),
      summary: parts.join(' · ') || 'baseline',
      units,
    }
    this.append(record)
    return this.toCheckpoint(record)
  }

  async list(limit = 50): Promise<Checkpoint[]> {
    if (this.single) return this.single.list(limit)
    const records = this.records()
    // Newest first, matching what a single store's `git log` returns.
    return records.slice(-limit).reverse().map((r) => this.toCheckpoint(r))
  }

  /** `git diff --stat` per unit that moved between the two sets, labelled by folder. */
  async diffStat(from: string, to?: string): Promise<string> {
    if (this.single) return this.single.diffStat(from, to)
    const a = this.record(from)
    const b = to === undefined ? null : this.record(to)
    if (a === null) return ''

    const blocks: string[] = []
    for (const [i, store] of this.stores.entries()) {
      const unit = this.units[i]!
      const fromSha = a.units[unit.id]
      if (fromSha === undefined) continue
      const toSha = b === null ? undefined : b.units[unit.id]
      if (b !== null && toSha === undefined) continue
      if (fromSha === toSha) continue
      const stat = (await store.diffStat(fromSha, toSha)).trim()
      if (stat !== '') blocks.push(this.units.length === 1 ? stat : `${unit.label}:\n${stat}`)
    }
    return blocks.join('\n')
  }

  /**
   * Puts every unit back to where the named set says it was.
   *
   * A unit that is not in that set — a folder attached after the checkpoint was taken — is
   * left exactly as it is and named in the result, because silently not rewinding part of a
   * workspace is the failure this whole file exists to remove.
   */
  async rewind(id: string): Promise<{ restored: Checkpoint; undo: Checkpoint }> {
    if (this.single) return this.single.rewind(id)
    const record = this.record(id)
    if (record === null) throw new Error(`no checkpoint "${id}"`)

    const undo = (await this.take({})) ?? (await this.latest())
    if (undo === null) throw new Error('the checkpoint store has no history to return to')

    const skipped: string[] = []
    for (const [i, store] of this.stores.entries()) {
      const unit = this.units[i]!
      const sha = record.units[unit.id]
      if (sha === undefined) {
        skipped.push(unit.label)
        continue
      }
      await store.resetTo(sha)
    }
    this.collectProblems()

    const note = skipped.length > 0
      ? ` (${skipped.join(', ')} came later than this checkpoint and ${skipped.length === 1 ? 'was' : 'were'} left alone)`
      : ''
    return {
      restored: { id, at: new Date().toISOString(), summary: `${record.summary}${note}` },
      undo,
    }
  }

  /**
   * One file, in whichever unit holds it.
   *
   * Takes an ABSOLUTE path: which unit a file belongs to is a fact about where it is on disk,
   * and a workspace-relative path cannot answer it once there are several folders.
   */
  async restoreFile(id: string, absolutePath: string): Promise<{ removed: boolean }> {
    const abs = resolve(absolutePath)
    if (this.single) {
      // The one-unit path needs the containment test just as much as the many-unit one: a
      // read-only mount produces no unit at all, so a workspace with one writable folder and
      // an attached reference folder lands HERE with a path that is outside the only root.
      // `relative` then answered `../other/a.ts`, which the store happily turned into
      // `rmSync(join(root, '../other/a.ts'), { force: true })` -- deleting a real file in a
      // folder this store never snapshotted, and reporting it as a successful revert.
      const rel = this.inside(this.single.root, abs)
      if (rel === null) throw new Error(`${absolutePath} is not inside any folder this workspace snapshots`)
      return this.single.restoreFile(id, rel)
    }
    const record = this.record(id)
    if (record === null) throw new Error(`no checkpoint "${id}"`)

    // Deepest first: a file inside a nested repository belongs to that repository's unit, not
    // to the folder above it, and only the deepest match says so.
    const ordered = [...this.units].sort((a, b) => b.root.length - a.root.length)
    for (const unit of ordered) {
      const rel = this.inside(unit.root, abs)
      if (rel === null) continue
      const sha = record.units[unit.id]
      if (sha === undefined) {
        throw new Error(`${absolutePath} is in "${unit.label}", which is not part of checkpoint ${id}`)
      }
      const store = this.stores[this.units.indexOf(unit)]!
      return store.restoreFile(sha, rel)
    }
    throw new Error(`${absolutePath} is not inside any folder this workspace snapshots`)
  }

  // ---------------------------------------------------------------------------------------

  /**
   * Where `abs` sits inside `unitRoot` as a git-style path, or `null` when it is not in there
   * at all.
   *
   * The `..` test alone is not enough, and on Windows the gap is a data-loss one: asked about
   * two paths on DIFFERENT DRIVES, `path.win32.relative` cannot express the answer as a
   * relative path and returns an ABSOLUTE one instead — `relative('C:\\proj', 'D:\\lib\\a.ts')`
   * is `D:\lib\a.ts`, which starts with neither `..` nor nothing. So a `..`-only guard handed
   * a D: file to the C: unit; its shadow repository then looked up `<sha>:D:/lib/a.ts`, missed,
   * took the "new since the checkpoint" branch, and told the caller `{ removed: true }` — on
   * which `Session.restoreFile` writes into the transcript that the file did not exist at the
   * baseline and is now deleted, while on disk nothing was restored and nothing was removed.
   * `Workspace.mountFor` and `isInside` have always carried the `isAbsolute` half of the test;
   * this file did not.
   *
   * `rel === ''` — the unit root itself — is not a file and belongs to no restore.
   */
  private inside(unitRoot: string, abs: string): string | null {
    const rel = relative(unitRoot, abs)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
    return rel.split('\\').join('/')
  }

  private toCheckpoint(record: CheckpointSetRecord): Checkpoint {
    return {
      id: record.id,
      at: record.at,
      ...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
      ...(record.turn !== undefined ? { turn: record.turn } : {}),
      ...(record.step !== undefined ? { step: record.step } : {}),
      summary: record.summary,
    }
  }

  private async latest(): Promise<Checkpoint | null> {
    const records = this.records()
    const last = records.at(-1)
    return last === undefined ? null : this.toCheckpoint(last)
  }

  private records(): CheckpointSetRecord[] {
    let raw: string
    try {
      raw = readFileSync(this.manifestPath, 'utf8')
    } catch {
      return []
    }
    const out: CheckpointSetRecord[] = []
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try {
        const parsed = JSON.parse(line) as CheckpointSetRecord
        if (typeof parsed.id === 'string' && typeof parsed.units === 'object') out.push(parsed)
      } catch {
        // One unreadable line must not hide every checkpoint before and after it.
      }
    }
    return out
  }

  private record(id: string): CheckpointSetRecord | null {
    return this.records().find((r) => r.id === id) ?? null
  }

  private count(): number {
    return this.records().length
  }

  private append(record: CheckpointSetRecord): void {
    ensureStateDir(this.primaryRoot, MANIFEST_DIR)
    appendFileSync(this.manifestPath, `${JSON.stringify(record)}\n`, 'utf8')
  }
}
