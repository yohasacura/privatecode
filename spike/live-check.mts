/**
 * The six fixes, exercised against a real workspace on disk rather than a fixture.
 *
 * Everything here that CAN be checked without the window is checked here: the tools and the
 * host methods run in the same process the sidecar runs them in, against a workspace with
 * real build output, a real git repository and two real branches. What is left for the
 * window itself is the drag-and-drop and the status line.
 *
 *   npx tsx spike/live-check.mts
 */
import { execFileSync } from 'node:child_process'
import { findFilesTool } from '../core/src/tools/find-files.js'
import { searchCodeTool } from '../core/src/tools/search-code.js'
import { attachFiles } from '../core/src/host/attachments.js'
import { Workspace } from '../core/src/workspace.js'
import { discoverRepos } from '../core/src/host/repos.js'
import type { ToolContext } from '../core/src/tools/types.js'

const WS = 'D:\\Projects\\LocalAgent\\pc-livetest'
const workspace = new Workspace(WS)
const ctx = { workspace } as ToolContext
const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: WS, encoding: 'utf8' }).trim()

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}`)
}

console.log('=== 6. find_files: build output is not walked and not returned ===')
{
  const t = Date.now()
  const r = await findFilesTool.execute({ glob: '**/*.cs' }, ctx)
  const ms = Date.now() - t
  const lines = r.content.split('\n').filter((l) => l.trim() !== '')
  check(
    'a broad pattern returns source only',
    !r.content.includes('bin/') && !r.content.includes('obj/') && r.content.includes('src/Thing1.cs'),
    `${ms} ms, ${lines.length} results: ${lines.join(', ')}`,
  )

  const named = await findFilesTool.execute({ glob: 'bin/**/*.cs' }, ctx)
  check(
    'naming the directory opts back into it',
    named.content.includes('bin/Debug/Generated.cs'),
    named.content.replace(/\n/g, ' | '),
  )

  const empty = await findFilesTool.execute({ glob: '**/*.fsharp' }, ctx)
  check('an empty result explains the prune', empty.content.includes('bin/**'), empty.content)
}

console.log('\n=== 6. search_code still works, and stays inside the workspace ===')
{
  const t = Date.now()
  const r = await searchCodeTool.execute({ pattern: 'class Thing' }, ctx)
  check(
    'finds the class in src',
    r.ok && r.content.includes('Thing1.cs'),
    `${Date.now() - t} ms — ${r.content.split('\n')[0]}`,
  )
}

console.log('\n=== 3. attaching a FOLDER ===')
{
  const r = await attachFiles(workspace, ['src'], 'what is in there?')
  check(
    'a folder attaches as a listing, not as EISDIR',
    r.text.includes('src/Thing1.cs') && !r.notes.join(' ').includes('EISDIR'),
    r.notes.join(' | ') || '(no notes)',
  )
  check(
    'the listing does not smuggle file contents',
    !r.text.includes('public class Thing1'),
    'bodies stay on disk until read_file asks',
  )
  const both = await attachFiles(workspace, ['README.md', 'docs'], 'both')
  check(
    'a file and a folder attach together',
    both.text.includes('# readme') && both.text.includes('docs/notes.md'),
    both.notes.join(' | ') || '(no notes)',
  )
}

console.log('\n=== 1. attach.resolve: an absolute dropped path becomes a workspace path ===')
{
  // The exact mapping `attach.resolve` performs, exercised through the same Workspace call.
  const dropped = `${WS}\\src\\Thing2.cs`
  check('an inside path maps to a relative one', workspace.display(dropped) === 'src/Thing2.cs',
    `${dropped} -> ${workspace.display(dropped)}`)
  // `mountFor`, not `display`. This live run is what found the difference: `display` returns
  // an outside path UNCHANGED rather than refusing it, so the first version of
  // `attach.resolve` accepted a file dropped from Downloads and handed the composer an
  // absolute path to write into the message box.
  const outside = 'C:\\Windows\\System32\\drivers\\etc\\hosts'
  check('an outside path is refused rather than mapped',
    workspace.mountFor(outside) === undefined,
    `mountFor -> undefined, so it is rejected; display would have returned "${workspace.display(outside)}"`)
}

console.log('\n=== 5. git: the panel data changes when the branch changes ===')
{
  const before = await discoverRepos(workspace)
  const branchBefore = git('branch', '--show-current')
  // Whichever branch we are NOT on. The first version hard-coded `feature` and passed only
  // while the workspace happened to be on `main` — a check that quietly stops checking as
  // soon as somebody leaves the repository somewhere else.
  const other = branchBefore === 'feature' ? 'main' : 'feature'
  git('checkout', '-q', other)
  const after = await discoverRepos(workspace)
  const branchAfter = git('branch', '--show-current')
  git('checkout', '-q', branchBefore)

  const named = (r: Awaited<ReturnType<typeof discoverRepos>>): string =>
    JSON.stringify(r.repos.map((x) => x.branch))
  check(
    'discoverRepos re-reads the branch every call (no cache to invalidate)',
    named(before) !== named(after),
    `${branchBefore} -> ${named(before)} then ${branchAfter} -> ${named(after)}`,
  )
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
