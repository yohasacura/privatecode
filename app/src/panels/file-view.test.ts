import { describe, expect, it } from 'vitest'
import type { GitFileChange, GitRepoView } from '@core/host/protocol'
import { loadedFrom, noteFor, wantsUntrackedDiff } from './file-view'
import type { ChangeEntry } from './changes-tab'

/**
 * The three decisions the file tab makes about what it is looking at, pulled out of the
 * components so they can be pinned down without a DOM: which git diff a path actually
 * wants, what an `fs.read` answer becomes, and whether a finished Put back still describes
 * the change on screen.
 */

/** Built the way `parsePorcelain` builds it, so the test cannot quietly disagree with the
 * host about what a status pair means. */
function file(path: string, code: string): GitFileChange {
  return { path, code, staged: code[0] !== ' ' && code[0] !== '?', untracked: code === '??' }
}

function repo(root: string, files: GitFileChange[]): GitRepoView {
  return { root, label: root, branch: 'main', relation: 'folder', files, suggestion: '' }
}

describe('wantsUntrackedDiff', () => {
  it('a clean tracked file is not new — its empty HEAD diff means nothing uncommitted', () => {
    // git status does not list it at all. Retrying as untracked here is what rendered every
    // line of an unchanged file as an addition, under a control titled "show what is
    // uncommitted in this file".
    const repos = [repo('C:/ws', [file('src/other.ts', ' M')])]
    expect(wantsUntrackedDiff(repos, 'src/app.ts')).toBe(false)
  })

  it('an untracked file is new, and gets the /dev/null diff', () => {
    const repos = [repo('C:/ws', [file('src/fresh.ts', '??')])]
    expect(wantsUntrackedDiff(repos, 'src/fresh.ts')).toBe(true)
  })

  it('a staged add whose repository has no commits yet is new too — there is no HEAD to diff', () => {
    const repos = [repo('C:/ws', [file('src/first.ts', 'A ')])]
    expect(wantsUntrackedDiff(repos, 'src/first.ts')).toBe(true)
  })

  it('a modified file is never treated as new, even when HEAD answered with nothing', () => {
    // Line-ending normalisation can leave git status calling a file modified while the HEAD
    // diff comes back empty; that file is tracked, and painting all of it green is the bug.
    const repos = [repo('C:/ws', [file('src/app.ts', ' M')])]
    expect(wantsUntrackedDiff(repos, 'src/app.ts')).toBe(false)
  })

  it('finds the path in whichever repository of the workspace holds it', () => {
    const repos = [
      repo('C:/ws/api', [file('api/server.ts', ' M')]),
      repo('C:/ws/web', [file('web/index.tsx', '??')]),
    ]
    expect(wantsUntrackedDiff(repos, 'web/index.tsx')).toBe(true)
  })

  it('matches a tab opened under a different spelling of the same Windows path', () => {
    // git reports the name as it sits on disk; a tab opened from a tool card carries what
    // the model typed, and on Windows the two are the same file.
    const repos = [repo('C:/ws', [file('src/App.tsx', '??')])]
    expect(wantsUntrackedDiff(repos, 'src/app.tsx')).toBe(true)
  })
})

describe('loadedFrom', () => {
  it('keeps the image payload — an image tab used to render an empty code block', () => {
    const loaded = loadedFrom({
      lines: [],
      truncated: false,
      image: { dataUrl: 'data:image/png;base64,AAAA', bytes: 4096 },
    })
    expect(loaded).toEqual({ kind: 'image', dataUrl: 'data:image/png;base64,AAAA', bytes: 4096 })
  })

  it('a text file is still text, truncation flag and all', () => {
    expect(loadedFrom({ lines: ['a', 'b'], truncated: true }))
      .toEqual({ kind: 'loaded', lines: ['a', 'b'], truncated: true })
  })
})

describe('noteFor', () => {
  function change(id: number): ChangeEntry {
    return {
      id,
      tool: 'edit_file',
      path: 'src/a.ts',
      ok: true,
      content: '--- src/a.ts\n+++ src/a.ts\n@@ line 1 @@\n+new',
      revisions: 1,
      openPath: 'src/a.ts',
      restorePaths: ['src/a.ts'],
    }
  }

  it('shows the outcome of the revert of the change on screen', () => {
    expect(noteFor(change(7), { entryId: 7, text: 'src/a.ts restored' })).toBe('src/a.ts restored')
  })

  it('drops it once the agent writes the same path again, so Put back comes back', () => {
    // `collectChanges` replaces the path's entry with a new id and a new diff. Judging
    // "already reverted" by a bare string left that line above the NEW diff with the Put
    // back button hidden, so the newer change could not be reverted without closing the tab.
    expect(noteFor(change(9), { entryId: 7, text: 'src/a.ts restored' })).toBeNull()
  })

  it('nothing recorded is nothing shown', () => {
    expect(noteFor(change(7), null)).toBeNull()
  })
})
