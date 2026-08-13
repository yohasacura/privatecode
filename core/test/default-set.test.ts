import { expect, test } from 'vitest'
import { buildRegistry } from '../src/tools/default-set.js'

/**
 * Pins the readOnly set of the eight REAL tools, not synthetic stand-ins.
 *
 * registry.test.ts proves ToolRegistry.readOnlyNames() reflects whatever a tool declares
 * about itself — but that only guarantees the mechanism is honest, not that the actual
 * tools wired into the CLI declare the right thing. readOnly is now the sole basis Agent
 * uses to build plan mode's tool list (agent/loop.ts, mode === 'plan'), so a wrong flag on
 * one of the real tools is a silent safety hole that no other test catches: flip
 * edit-file.ts's readOnly to true and every other test in the suite still passes while
 * plan mode quietly offers and executes edit_file. This test is what turns that into a
 * failing test instead of a shipped defect.
 */
test('buildRegistry() marks exactly the read-only tools as readOnly', () => {
  expect(buildRegistry().readOnlyNames().sort()).toEqual(
    ['ask_user', 'find_files', 'git_status', 'list_dir', 'read_file', 'search_code',
     'symbol_outline', 'todo_write',
     // Reads a file the user wrote and returns its text; it runs nothing. Read-only is
     // what makes it available in PLAN mode, which is where reading a procedure before
     // proposing a plan is most of the point.
     'use_skill'],
  )
})
