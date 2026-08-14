import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PRIVATE_DIR, ensurePrivateDir, migratePrivateDir, statePath } from '../src/private-dir.js'

/**
 * Splitting `.privatecode/` into what the user writes and what the tool writes.
 *
 * The migration is the risky half — it renames directories holding somebody's real session
 * history — so what is pinned here is that it cannot destroy anything: it moves only when
 * the destination is free, it is safe to run twice, and a failure leaves the old copy where
 * it was rather than a half-move.
 */

let root: string
const roots: string[] = []
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-pdir-'))
  roots.push(root)
})
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true })
})

const priv = (...parts: string[]): string => join(root, PRIVATE_DIR, ...parts)
const legacy = (): void => {
  mkdirSync(priv('sessions'), { recursive: true })
  writeFileSync(priv('sessions', 's1.jsonl'), 'the conversation', 'utf8')
  mkdirSync(priv('checkpoints.git'), { recursive: true })
  writeFileSync(priv('checkpoints.git', 'HEAD'), 'ref: refs/heads/main', 'utf8')
  writeFileSync(priv('worklog.md'), '# what it did', 'utf8')
}

describe('the state/ split', () => {
  test('the whole folder stays out of git — none of it belongs in a history', () => {
    // Briefly narrowed to ignore only `state/`, on the reasoning that a project's own skills
    // and settings should be able to travel with the repository. The user's answer was that
    // none of this folder belongs in theirs, and that is the call: the split is about what a
    // person has to LOOK at, not about what git carries.
    ensurePrivateDir(root)
    expect(readFileSync(priv('.gitignore'), 'utf8').split('\n')).toContain('*')
  })

  test('an existing workspace has its machine state moved, contents intact', () => {
    legacy()
    expect(migratePrivateDir(root)).toEqual([])

    expect(readFileSync(statePath(root, 'sessions', 's1.jsonl'), 'utf8')).toBe('the conversation')
    expect(readFileSync(statePath(root, 'checkpoints.git', 'HEAD'), 'utf8')).toBe('ref: refs/heads/main')
    expect(readFileSync(statePath(root, 'worklog.md'), 'utf8')).toBe('# what it did')
    expect(existsSync(priv('sessions'))).toBe(false)
    expect(existsSync(priv('worklog.md'))).toBe(false)
  })

  test('running it again changes nothing — it is a startup path, not a one-shot script', () => {
    legacy()
    migratePrivateDir(root)
    expect(migratePrivateDir(root)).toEqual([])
    expect(readFileSync(statePath(root, 'sessions', 's1.jsonl'), 'utf8')).toBe('the conversation')
  })

  test('a destination that already exists is never overwritten by an older copy', () => {
    // The shape that would eat history: a leftover old folder beside a newer migrated one.
    // Skipping is the only safe answer, and the leftover is visible rather than silently
    // consumed.
    legacy()
    mkdirSync(statePath(root, 'sessions'), { recursive: true })
    writeFileSync(statePath(root, 'sessions', 's1.jsonl'), 'the NEWER conversation', 'utf8')

    migratePrivateDir(root)
    expect(readFileSync(statePath(root, 'sessions', 's1.jsonl'), 'utf8')).toBe('the NEWER conversation')
    expect(readFileSync(priv('sessions', 's1.jsonl'), 'utf8')).toBe('the conversation')
  })

  test('the ignore file is never rewritten by the migration', () => {
    // Rearranging our own directories is not a licence to edit a file the user may have
    // changed — and the body it already carries is the body it should carry.
    legacy()
    const edited = '*\n!keep-this\n'
    writeFileSync(priv('.gitignore'), edited, 'utf8')
    migratePrivateDir(root)
    expect(readFileSync(priv('.gitignore'), 'utf8')).toBe(edited)
  })

  test('a workspace that never used this tool is left completely alone', () => {
    expect(migratePrivateDir(root)).toEqual([])
    expect(existsSync(join(root, PRIVATE_DIR))).toBe(false)
  })

  test('checkpoints.exclude stays put — its path is baked into every store', () => {
    // Moving it would leave `core.excludesFile` pointing at nothing, which switches every
    // exclusion off with no symptom at all. It is also a file the user edits.
    legacy()
    writeFileSync(priv('checkpoints.exclude'), 'node_modules/\n', 'utf8')
    migratePrivateDir(root)
    expect(existsSync(priv('checkpoints.exclude'))).toBe(true)
    expect(existsSync(statePath(root, 'checkpoints.exclude'))).toBe(false)
  })
})
