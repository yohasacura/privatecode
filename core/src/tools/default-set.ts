import { ToolRegistry } from './registry.js'
import { readFileTool } from './read-file.js'
import { listDirTool } from './list-dir.js'
import { findFilesTool } from './find-files.js'
import { searchCodeTool } from './search-code.js'
import { editFileTool } from './edit-file.js'
import { writeFileTool } from './write-file.js'
import { moveFileTool } from './move-file.js'
import { deleteFileTool } from './delete-file.js'
import { runCommandTool } from './run-command.js'
import { BackgroundTasks, backgroundTaskTool } from './background-task.js'
import { gitStatusTool } from './git-tool.js'
import { TodoStore } from '../interaction.js'
import { todoWriteTool } from './todo-write.js'
import { askUserTool } from './ask-user.js'
import { symbolOutlineTool } from './symbol-outline.js'
import { browserTool } from './browser.js'
import { useSkillTool } from './use-skill.js'
import { csharpNavTool } from './csharp-nav.js'
import { rememberTool } from './remember.js'
import { BrowserManager, type BrowserOptions } from '../browser/manager.js'

export interface Toolset {
  registry: ToolRegistry
  /** Owned by the host: call stopAll() on shutdown so no orphan processes survive. */
  background: BackgroundTasks
  todos: TodoStore
  /** Owned by the host in the same way: call close() on shutdown. Lazy — constructing it
   * starts no browser, so a session that never opens a page never pays for one. */
  browser: BrowserManager
}

export interface ToolsetOptions {
  browser?: BrowserOptions
  /** Where the plan is persisted. Absent keeps the plan in memory only, which is what the
   * one-shot CLI and most tests want. */
  workspaceRoot?: string
}

export function createToolset(opts: ToolsetOptions = {}): Toolset {
  const registry = new ToolRegistry()
  const background = new BackgroundTasks()
  const todos = new TodoStore(opts.workspaceRoot)
  const browser = new BrowserManager(opts.browser ?? {})
  for (const t of [readFileTool, listDirTool, findFilesTool, searchCodeTool,
                   editFileTool, writeFileTool, moveFileTool, deleteFileTool, runCommandTool,
                   backgroundTaskTool(background), gitStatusTool, todoWriteTool, askUserTool,
                   symbolOutlineTool, browserTool, useSkillTool, csharpNavTool, rememberTool]) {
    registry.register(t)
  }
  return { registry, background, todos, browser }
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
