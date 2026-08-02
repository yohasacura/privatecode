import { ToolRegistry } from './registry.js'
import { readFileTool } from './read-file.js'
import { listDirTool } from './list-dir.js'
import { findFilesTool } from './find-files.js'
import { searchCodeTool } from './search-code.js'
import { editFileTool } from './edit-file.js'
import { writeFileTool } from './write-file.js'
import { runCommandTool } from './run-command.js'

/**
 * It must not live in cli.ts: importing that file would run its main() as a side effect,
 * which would break the integration test and anything else that just wants the same
 * tool set without launching a CLI session.
 *
 * The tools this plan delivers. Later plans add the remaining eight.
 */
export function buildRegistry(): ToolRegistry {
  const r = new ToolRegistry()
  for (const t of [readFileTool, listDirTool, findFilesTool, searchCodeTool,
                   editFileTool, writeFileTool, runCommandTool]) {
    r.register(t)
  }
  return r
}

/**
 * Names plan mode may offer, for anything that wants to name the list (the CLI's banner,
 * tests). This is NOT what makes plan mode safe — `Agent` no longer trusts a caller-passed
 * list at all in `mode: 'plan'`; it derives its own restriction from each registered
 * tool's `readOnly` flag via `ToolRegistry.readOnlyNames()`. This export is simply that
 * same computation run once against the default registry, so a caller who wants to
 * display or reason about the list does not hand-maintain a second copy of it.
 */
export const READ_ONLY_TOOLS: string[] = buildRegistry().readOnlyNames()
