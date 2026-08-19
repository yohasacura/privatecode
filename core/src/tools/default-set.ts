import { ToolRegistry } from './registry.js'
import { ReadMemory } from './read-memory.js'
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
import { webTool } from './web.js'
import { symbolOutlineTool } from './symbol-outline.js'
import { browserTool } from './browser.js'
import { useSkillTool } from './use-skill.js'
import { csharpNavTool } from './csharp-nav.js'
import { databaseTool } from './database.js'
import { sqlDeployTool } from './sql-deploy.js'
import { rememberTool } from './remember.js'
import { BrowserManager, type BrowserOptions } from '../browser/manager.js'
import { profileDir } from '../browser/launcher.js'

export interface Toolset {
  registry: ToolRegistry
  /** Owned by the host: call stopAll() on shutdown so no orphan processes survive. */
  background: BackgroundTasks
  todos: TodoStore
  /** Owned here so it lives as long as the session and can be cleared at a compaction
   * swap, which is when everything in it stops being true. */
  reads: ReadMemory
  /** Owned by the host in the same way: call close() on shutdown. Lazy — constructing it
   * starts no browser, so a session that never opens a page never pays for one. */
  browser: BrowserManager
  /** The `web` tool's headless renderer for JavaScript-shell pages. Its own instance so
   * a background read never flashes a window or steals the visible browser's page.
   * Lazy and host-closed exactly like `browser`. */
  webRenderer: BrowserManager
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
  const reads = new ReadMemory()
  const browser = new BrowserManager(opts.browser ?? {})
  // Same executable override as the visible browser, forced headless: this one exists to
  // render JavaScript-shell pages for the `web` tool, and a window would be a bug. Its
  // OWN profile directory, non-negotiably: Chromium runs one instance per profile, so on
  // the shared default the renderer and the visible browser killed each other — one web
  // read of a JS-shell page disabled the browser tool for the rest of the session.
  const webRenderer = new BrowserManager({
    ...(opts.browser?.exePath !== undefined ? { exePath: opts.browser.exePath } : {}),
    headless: true,
    userDataDir: `${profileDir()}-headless`,
  })
  // Registration order is the order the schemas reach the model, and `csharp_nav` sat 17th
  // of 18 -- past every file tool, next to the browser. Moved beside `search_code`, which is
  // what it competes with: both answer "where is this used", one by text and one by meaning.
  // Free, and unmeasured: no claim is made here that position is what routes the choice.
  // `web` sits beside the search family for the same unmeasured reason: it answers "find
  // out", and the model reaching for information should meet it before run_command.
  for (const t of [readFileTool, listDirTool, findFilesTool, searchCodeTool, webTool, csharpNavTool, databaseTool,
                   editFileTool, writeFileTool, moveFileTool, deleteFileTool, runCommandTool, sqlDeployTool,
                   backgroundTaskTool(background), gitStatusTool, todoWriteTool, askUserTool,
                   symbolOutlineTool, browserTool, useSkillTool, rememberTool]) {
    registry.register(t)
  }
  return { registry, background, todos, browser, webRenderer, reads }
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
