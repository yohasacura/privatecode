import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { OUTCOMES_SUFFIX, SESSIONS_DIR, planFileFor, statePath } from '../src/private-dir.js'
import { SessionStore } from '../src/session/store.js'

/**
 * Deleting a session, at the level where the files are.
 *
 * The failure this suite exists for is not "the delete threw". It is the delete that
 * REPORTS SUCCESS and leaves something behind: a session owns four files written by three
 * different modules, the rail is driven entirely by one of them (`*.meta.json`), and
 * removing only that one makes the session vanish from the window while its full transcript
 * stays on disk. Someone deleting a conversation is not tidying a list.
 */

let root: string

/** Everything a real session leaves on disk, written directly so no turn has to run. */
function plant(id: string, opts: { meta?: boolean; corruptMeta?: boolean } = {}): void {
  const dir = statePath(root, SESSIONS_DIR)
  mkdirSync(dir, { recursive: true })
  if (opts.corruptMeta === true) {
    writeFileSync(join(dir, `${id}.meta.json`), '{ this is not json', 'utf8')
  } else if (opts.meta !== false) {
    writeFileSync(join(dir, `${id}.meta.json`), JSON.stringify({
      id, title: `session ${id}`, createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z', workspaceRoot: root, mode: 'normal',
    }), 'utf8')
  }
  writeFileSync(join(dir, `${id}.jsonl`), '{"role":"user","content":"hello"}\n', 'utf8')
  writeFileSync(join(dir, `${id}${OUTCOMES_SUFFIX}`), '{"id":"c1","ok":true}\n', 'utf8')
  writeFileSync(statePath(root, planFileFor(id)), '[]', 'utf8')
}

function owned(id: string): string[] {
  const dir = statePath(root, SESSIONS_DIR)
  return [
    join(dir, `${id}.meta.json`),
    join(dir, `${id}.jsonl`),
    join(dir, `${id}${OUTCOMES_SUFFIX}`),
    statePath(root, planFileFor(id)),
  ]
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pc-del-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true, maxRetries: 3 }) })

describe('deleting one session', () => {
  test('takes every file it owns, not just the one the rail reads', () => {
    plant('aaa')
    const store = new SessionStore(root)

    expect(store.delete('aaa')).toEqual({ removed: 4, problems: [] })

    // Named individually rather than as a count: a regression here is one of these four
    // surviving, and a count would still be four if the set silently changed.
    for (const path of owned('aaa')) {
      expect(existsSync(path), `${path} should be gone`).toBe(false)
    }
    expect(store.list()).toEqual([])
  })

  test('leaves every other session exactly where it was', () => {
    plant('aaa')
    plant('bbb')
    const store = new SessionStore(root)

    store.delete('aaa')

    for (const path of owned('bbb')) expect(existsSync(path)).toBe(true)
    expect(store.list().map((s) => s.id)).toEqual(['bbb'])
  })

  test('deleting what is not there is not a failure', () => {
    // The ordinary case, not an edge one: three of the four files are optional — a session
    // that never ran has no transcript, one from before outcomes existed has no `.ui.jsonl`.
    // If "missing" were an error, every delete would report problems.
    const store = new SessionStore(root)
    expect(store.delete('never-existed')).toEqual({ removed: 0, problems: [] })
  })

  test('an id that tries to walk out of the sessions directory cannot', () => {
    // Ids are generated filename-safe. This is about the one that is not: a hand-edited
    // meta file, or a future id scheme.
    //
    // The escape has to be aimed to mean anything, and the first version of this test was
    // not — it planted `<root>/settings.json` and passed an id of `../../settings`, which
    // from `<root>/.privatecode/state/sessions/` lands on `<root>/.privatecode/` and touches
    // nothing. It passed with the sanitiser removed, which is the only reason it was caught.
    //
    // Three levels up is the workspace root, and the name has to end in one of the suffixes
    // the delete appends, since that is all a traversal here could ever reach.
    const target = join(root, 'escaped.meta.json')
    writeFileSync(target, 'a file that is not ours', 'utf8')
    expect(existsSync(target)).toBe(true)

    new SessionStore(root).delete('../../../escaped')

    expect(existsSync(target), 'a delete must not reach outside sessions/').toBe(true)
  })
})

describe('deleting every session', () => {
  test('clears them all and says which', () => {
    plant('aaa')
    plant('bbb')
    plant('ccc')
    const store = new SessionStore(root)

    const result = store.deleteAll()

    expect(result.problems).toEqual([])
    expect(result.ids.sort()).toEqual(['aaa', 'bbb', 'ccc'])
    expect(store.list()).toEqual([])
    for (const id of ['aaa', 'bbb', 'ccc']) {
      for (const path of owned(id)) expect(existsSync(path)).toBe(false)
    }
  })

  test('including one too damaged to be listed', () => {
    // Driven off the directory rather than off `list()` for exactly this: `list()` skips a
    // session whose meta will not parse, and that is the one someone is most likely to be
    // trying to get rid of. Off `list()` it would survive "delete all" and reappear as a
    // problem string the next time the rail loaded.
    plant('good')
    plant('broken', { corruptMeta: true })
    const store = new SessionStore(root)

    expect(store.list().map((s) => s.id)).toEqual(['good'])
    expect(store.problems.length).toBe(1)

    const result = store.deleteAll()

    expect(result.ids.sort()).toEqual(['broken', 'good'])
    for (const path of owned('broken')) expect(existsSync(path)).toBe(false)
    expect(store.list()).toEqual([])
    expect(store.problems).toEqual([])
  })

  test('on a workspace that never had a session, it is a no-op', () => {
    expect(new SessionStore(root).deleteAll()).toEqual({ ids: [], problems: [] })
  })
})
