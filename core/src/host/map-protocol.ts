import type { MapBuildOptions, MapBuildResult, MapProgress, MapStatus } from '../map/builder.js'

/**
 * The wire for the project map (docs/MAP.md): its status, a build the window starts and
 * follows, one note at a time for the Map tab, and a search over the notes.
 */

export type { MapBuildOptions, MapBuildResult, MapProgress, MapStatus }

export interface MapNoteParams {
  /** `''` or `'.'` for the root module; a file or directory path otherwise; `'Project'` for the project note. */
  path: string
}
export interface MapNoteResult {
  kind: 'file' | 'module' | 'project' | 'missing'
  markdown: string
  /** Links the note carries, for the tab to navigate by without parsing markdown. */
  links: { kind: 'file' | 'module' | 'project'; path: string; label: string }[]
  /** The note's structured fields, for the tab. */
  note?: unknown
}
export interface MapSearchParams { query: string }
export interface MapSearchResult { hits: { kind: 'file' | 'module'; path: string; score: number; what: string }[] }
export interface MapBuildParams extends Omit<MapBuildOptions, 'signal'> {}
export interface MapBuildStarted { started: boolean; reason?: string }
export interface MapTreeResult {
  /** Every module with its files and which have a fresh note. */
  /** A file is `noted` when its note matches its hash; `stale` (only ever true) when a note
   * exists for an older version of it — told apart from a file that never had one. */
  modules: { path: string; files: { path: string; noted: boolean; stale?: true; fidelity: number | null }[]; children: string[]; noted: boolean }[]
}

export interface MapMethodMap {
  'map.status': { params: Record<string, never>; result: MapStatus }
  'map.build': { params: MapBuildParams; result: MapBuildStarted }
  'map.stop': { params: Record<string, never>; result: { stopped: boolean } }
  'map.note': { params: MapNoteParams; result: MapNoteResult }
  'map.search': { params: MapSearchParams; result: MapSearchResult }
  'map.tree': { params: Record<string, never>; result: MapTreeResult }
}

export interface MapProgressEvent extends MapProgress {}

export function isMapMethod(method: string): method is keyof MapMethodMap {
  return method.startsWith('map.')
}
