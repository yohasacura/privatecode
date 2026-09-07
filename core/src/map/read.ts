import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MapNoteResult, MapTreeResult } from '../host/map-protocol.js'
import { noteName, type MapIndex } from './notes.js'

/**
 * What the Map tab reads: one note with the links it carries, and the tree of modules and
 * files with their note state. Both come from `index.json` and the rendered markdown, so
 * the tab shows exactly what Obsidian would.
 */

function normalise(path: string): string {
  const p = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  return p === '.' ? '' : p
}

function markdownOf(dir: string, kind: 'file' | 'module' | 'project', path = ''): string | null {
  try {
    return readFileSync(join(dir, `${noteName(kind, path)}.md`), 'utf8')
  } catch {
    return null
  }
}

const label = (path: string): string => (path === '' ? 'root' : (path.split('/').pop() ?? path))

export function readMapNote(dir: string, index: MapIndex, rawPath: string): MapNoteResult {
  const path = normalise(rawPath)
  if (rawPath === 'Project' || rawPath === 'project') {
    const note = index.notes.project
    const markdown = markdownOf(dir, 'project')
    if (note === undefined || markdown === null) return { kind: 'missing', markdown: 'No project note yet.', links: [] }
    const root = index.skeleton.modules.find((m) => m.path === '')
    // Only links that land: a path the model wrote that is on no note is left out here as
    // it is in the markdown (a folder without source files, a symbol taken for a file).
    const isModule = (p: string): boolean => index.skeleton.modules.some((m) => m.path === p)
    const isFile = (p: string): boolean => index.skeleton.files.some((f) => f.path === p)
    const links: MapNoteResult['links'] = [
      ...note.subsystems.map((s) => normalise(s.path)).filter(isModule).map((p) => ({ kind: 'module' as const, path: p, label: label(p) })),
      ...note.startHere.map((s) => normalise(s.path)).filter((p) => isFile(p) || isModule(p)).map((p) => ({ kind: isFile(p) ? 'file' as const : 'module' as const, path: p, label: label(p) })),
      ...(root?.children ?? []).map((c) => ({ kind: 'module' as const, path: c, label: label(c) })),
    ]
    return { kind: 'project', markdown, links: dedupe(links), note }
  }
  const fileNote = index.notes.files[path]
  const fileNode = index.skeleton.files.find((f) => f.path === path)
  if (fileNode !== undefined) {
    const markdown = fileNote !== undefined ? markdownOf(dir, 'file', path) : null
    const parent = path.split('/').slice(0, -1).join('/')
    const links: MapNoteResult['links'] = [
      { kind: 'module', path: parent, label: label(parent) },
      ...fileNode.uses.map((p) => ({ kind: 'file' as const, path: p, label: label(p) })),
      ...fileNode.usedBy.map((p) => ({ kind: 'file' as const, path: p, label: label(p) })),
      ...fileNode.tests.map((p) => ({ kind: 'file' as const, path: p, label: label(p) })),
      ...fileNode.coChanges.map((c) => ({ kind: 'file' as const, path: c.path, label: label(c.path) })),
    ]
    if (markdown === null) return { kind: 'missing', markdown: `${path} is on the map but has no note yet.`, links: dedupe(links) }
    return { kind: 'file', markdown, links: dedupe(links), note: fileNote }
  }
  const moduleNode = index.skeleton.modules.find((m) => m.path === path)
  if (moduleNode !== undefined) {
    const note = index.notes.modules[path]
    const markdown = note !== undefined ? markdownOf(dir, 'module', path) : null
    const parent = path === '' ? null : path.split('/').slice(0, -1).join('/')
    const links: MapNoteResult['links'] = [
      ...(parent === null ? [{ kind: 'project' as const, path: '', label: 'Project' }] : [{ kind: 'module' as const, path: parent, label: label(parent) }]),
      ...moduleNode.children.map((c) => ({ kind: 'module' as const, path: c, label: label(c) })),
      ...moduleNode.files.map((p) => ({ kind: 'file' as const, path: p, label: label(p) })),
      ...(note?.entryPoints ?? []).map((e) => normalise(e.path)).filter((p) => moduleNode.files.includes(p)).map((p) => ({ kind: 'file' as const, path: p, label: label(p) })),
    ]
    if (markdown === null) return { kind: 'missing', markdown: `${path === '' ? 'The root module' : path} has no note yet.`, links: dedupe(links) }
    return { kind: 'module', markdown, links: dedupe(links), note }
  }
  return { kind: 'missing', markdown: `${rawPath} is not on the map.`, links: [] }
}

function dedupe(links: MapNoteResult['links']): MapNoteResult['links'] {
  const seen = new Set<string>()
  return links.filter((l) => {
    const key = `${l.kind}:${l.path}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function mapTree(index: MapIndex): MapTreeResult {
  return {
    modules: index.skeleton.modules.map((m) => ({
      path: m.path,
      noted: index.notes.modules[m.path] !== undefined,
      children: m.children,
      files: m.files.map((p) => {
        const node = index.skeleton.files.find((f) => f.path === p)
        const note = index.notes.files[p]
        const fresh = note !== undefined && node !== undefined && note.hash === node.hash
        return {
          path: p,
          noted: fresh,
          ...(note !== undefined && !fresh ? { stale: true as const } : {}),
          fidelity: fresh && note.fidelity !== undefined ? note.fidelity : null,
        }
      }),
    })),
  }
}
