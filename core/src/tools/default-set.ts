import { ToolRegistry } from './registry.js'
import { readFileTool } from './read-file.js'
import { listDirTool } from './list-dir.js'
import { findFilesTool } from './find-files.js'
import { searchCodeTool } from './search-code.js'
import { editFileTool } from './edit-file.js'
import { writeFileTool } from './write-file.js'
import { runCommandTool } from './run-command.js'
import { BackgroundTasks, backgroundTaskTool } from './background-task.js'

export interface Toolset {
  registry: ToolRegistry
  /** Owned by the host: call stopAll() on shutdown so no orphan processes survive. */
  background: BackgroundTasks
}

export function createToolset(): Toolset {
  const registry = new ToolRegistry()
  const background = new BackgroundTasks()
  for (const t of [readFileTool, listDirTool, findFilesTool, searchCodeTool,
                   editFileTool, writeFileTool, runCommandTool,
                   backgroundTaskTool(background)]) {
    registry.register(t)
  }
  return { registry, background }
}

/** Back-compat for existing callers/tests that only need the registry. */
export function buildRegistry(): ToolRegistry {
  return createToolset().registry
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
