/**
 * Does the git panel survive a workspace path spelled differently from what git reports?
 *
 * `toplevelOf` returns `resolve(git rev-parse --show-toplevel)` — git's spelling — and it is
 * then compared, as a STRING, with the path the caller gave. Windows opens many spellings of
 * one directory: a different case, a trailing separator, an 8.3 alias. Node's `path.relative`
 * treats them as different places.
 *
 * Sixty tests failed this way on a GitHub runner while passing here, because the runner's
 * `%TEMP%` is `C:\Users\RUNNER~1\...` and git answers `C:\Users\runneradmin\...`. This asks
 * the question directly.
 *
 *   npx tsx spike/git-path-spelling-probe.mts
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverRepos } from '../core/src/host/repos.js'
import { Workspace } from '../core/src/workspace.js'

const root = mkdtempSync(join(tmpdir(), 'pc-spelling-'))
execFileSync('git', ['init', '--quiet'], { cwd: root })
writeFileSync(join(root, 'one.txt'), '1\n')

async function filesFor(path: string): Promise<string[]> {
  const repos = (await discoverRepos(new Workspace(path))).repos
  return (repos[0]?.files ?? []).map((f) => f.path)
}

const spellings: [string, string][] = [
  ['as git spells it', root],
  ['upper-cased', root.toUpperCase()],
  ['trailing separator', `${root}\\`],
  ['forward slashes', root.split('\\').join('/')],
]

for (const [name, path] of spellings) {
  try {
    const files = await filesFor(path)
    console.log(`  ${name.padEnd(20)} ${files.length === 1 ? 'ok  ' : 'LOST'} ${JSON.stringify(files)}`)
  } catch (e) {
    console.log(`  ${name.padEnd(20)} THREW ${(e as Error).message.slice(0, 60)}`)
  }
}

rmSync(root, { recursive: true, force: true })
