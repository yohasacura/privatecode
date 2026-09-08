import { open, readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { detectEndings } from './line-endings.js'

/**
 * The line ending a NEW file should have, learned from the workspace rather than imposed.
 *
 * `Write` keeps an existing file's endings and BOM (see `line-endings.ts`); a file that did
 * not exist yet used to be left exactly as the model wrote it, which is always LF, because
 * the model only ever sees LF. In a repository that is CRLF throughout — this user's C#
 * projects, every one of them — that made every file the agent created the odd one out,
 * and the diff of the next hand edit in Visual Studio a whole-file one.
 *
 * Two sources, in order of authority: an `.editorconfig` whose section matches the file
 * (`end_of_line = crlf|lf`, nearest file wins, later sections in a file override earlier
 * ones, `root = true` stops the walk), and failing that the files already beside it — the
 * majority ending among the new file's neighbours, its own extension's first. A folder with
 * no `.editorconfig` and no neighbours expresses no preference, and the file is left as given.
 */
export interface EndingConvention {
  eol: '\n' | '\r\n'
  source: 'editorconfig' | 'siblings'
}

/** Neighbours consulted before the majority is called. */
const MAX_SIBLINGS = 8
/** A neighbour bigger than this is a generated blob, not a convention. */
const MAX_SIBLING_BYTES = 256 * 1024
const HEAD_BYTES = 64 * 1024

/** An .editorconfig glob, as the subset that occurs in practice: `*`, `*.cs`, `*.{cs,ts}`, a
 * double star for any depth, `Makefile`. (The double-star example is not spelled out here
 * because followed by a slash it would end this comment.) */
export function editorconfigGlobToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!
    if (ch === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++ } else re += '[^/]*'
    } else if (ch === '?') re += '[^/]'
    else if (ch === '{') {
      const end = glob.indexOf('}', i)
      if (end === -1) { re += '\\{'; continue }
      const alternatives = glob.slice(i + 1, end).split(',').map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      re += `(?:${alternatives.join('|')})`
      i = end
    } else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

function sectionMatches(glob: string, relPath: string): boolean {
  const name = basename(relPath)
  // A pattern without a slash matches the file's name anywhere below; one with a slash is
  // anchored at the .editorconfig's own directory, as the format specifies.
  const target = glob.includes('/') ? relPath : name
  const cleaned = glob.replace(/^\//, '')
  return editorconfigGlobToRegExp(cleaned).test(target)
}

/** `end_of_line` for `relPath` from one .editorconfig's text, and whether the file said `root = true`. */
export function endOfLineFrom(text: string, relPath: string): { eol: '\n' | '\r\n' | null; root: boolean } {
  let root = false
  let eol: '\n' | '\r\n' | null = null
  let inMatchingSection = false
  let seenSection = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    const section = /^\[(.+)\]$/.exec(line)
    if (section !== null) {
      seenSection = true
      inMatchingSection = sectionMatches(section[1]!.trim(), relPath)
      continue
    }
    const pair = /^([^=:]+?)\s*[=:]\s*(.*)$/.exec(line)
    if (pair === null) continue
    const key = pair[1]!.trim().toLowerCase()
    const value = pair[2]!.trim().toLowerCase()
    if (!seenSection && key === 'root') root = value === 'true'
    if (inMatchingSection && key === 'end_of_line') {
      if (value === 'crlf') eol = '\r\n'
      else if (value === 'lf') eol = '\n'
      // `cr` is a convention nothing here can honour; it leaves the answer where it was.
    }
  }
  return { eol, root }
}

async function fromEditorconfig(abs: string, root: string): Promise<EndingConvention | null> {
  const stop = resolve(root)
  let dir = dirname(abs)
  // Nearest first: the first file that names an ending for this path wins.
  for (;;) {
    let text: string | null = null
    try {
      text = await readFile(join(dir, '.editorconfig'), 'utf8')
    } catch {
      text = null
    }
    if (text !== null) {
      const rel = relative(dir, abs).split(sep).join('/')
      const found = endOfLineFrom(text, rel)
      if (found.eol !== null) return { eol: found.eol, source: 'editorconfig' }
      if (found.root) return null
    }
    if (resolve(dir) === stop) return null
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

async function headEndings(file: string): Promise<'\n' | '\r\n' | null> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(file, 'r')
  } catch {
    return null
  }
  try {
    const buffer = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0)
    const head = buffer.subarray(0, bytesRead)
    if (head.includes(0)) return null
    const e = detectEndings(head.toString('utf8'))
    return e.crlf + e.lf === 0 ? null : e.eol
  } catch {
    return null
  } finally {
    await handle.close().catch(() => {})
  }
}

async function fromSiblings(abs: string): Promise<EndingConvention | null> {
  const dir = dirname(abs)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return null
  }
  const ext = extname(abs).toLowerCase()
  const own = basename(abs)
  // The same extension first: a `.cs` beside `.csproj` and `.resx` files learns from the `.cs`.
  const ordered = names
    .filter((n) => n !== own && !n.startsWith('.'))
    .sort((a, b) => Number(extname(b).toLowerCase() === ext) - Number(extname(a).toLowerCase() === ext) || a.localeCompare(b))
  let crlf = 0
  let lf = 0
  let looked = 0
  for (const name of ordered) {
    if (looked >= MAX_SIBLINGS) break
    const file = join(dir, name)
    try {
      const info = await stat(file)
      if (!info.isFile() || info.size > MAX_SIBLING_BYTES || info.size === 0) continue
    } catch {
      continue
    }
    const eol = await headEndings(file)
    if (eol === null) continue
    looked += 1
    if (eol === '\r\n') crlf += 1
    else lf += 1
  }
  if (crlf === lf) return null
  return { eol: crlf > lf ? '\r\n' : '\n', source: 'siblings' }
}

/** The convention for a file about to be created at `abs`, or null when the workspace has none to offer. */
export async function endingConvention(abs: string, workspaceRoot: string): Promise<EndingConvention | null> {
  return (await fromEditorconfig(abs, workspaceRoot)) ?? fromSiblings(abs)
}
