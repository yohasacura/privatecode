import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { Session } from '../src/session/session.js'
import { LlamaClient } from '../src/llama/client.js'
import { createToolset } from '../src/tools/default-set.js'

/**
 * When the memory of what the model has been shown must be thrown away.
 *
 * The cheap-repeat-read answer — "unchanged since you read it earlier in this session, the
 * text you already have is current" — is only true while that text really is still in the
 * context. Every way it stops being true has to clear this, and one of them was missed.
 */

const roots: string[] = []
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true })
})

const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'pc-reads-'))
  roots.push(root)
  return root
}

describe('a new session starts with no memory of what was read', () => {
  test('the toolset outlives the session, and the read memory must not', () => {
    // The defect this pins: the toolset — and with it ReadMemory — is built once per
    // WORKSPACE (`host.ts` init) and reused for every `sessions.new` and `sessions.resume`,
    // while the only `reads.clear()` in the codebase lived in `applyCompactionSwap`. So a
    // fresh session inherited the previous one's reads and could answer its FIRST read of a
    // file with "unchanged since you read it earlier in this session", about text appearing
    // in no transcript that session can see. A claim the model cannot check and has no
    // reason to doubt. Replayed over one recorded app run of three sessions sharing a
    // toolset, it would have answered that way 11 times and been right none of them.
    const toolset = createToolset({})
    toolset.reads.record('src/App.cs', 'class App {}')
    expect(toolset.reads.get('src/App.cs')).not.toBeNull()

    // Building a session over that same toolset is what must forget it. No request is sent,
    // so the unreachable server URL is never dialled.
    new Session({
      client: new LlamaClient({ baseUrl: 'http://127.0.0.1:1', model: 'm' }),
      toolset,
      workspaceRoot: tempRoot(),
    })

    expect(toolset.reads.get('src/App.cs')).toBeNull()
    expect(toolset.reads.size()).toBe(0)
  })

  test('two sessions in a row over one toolset do not leak into each other', () => {
    const toolset = createToolset({})
    const client = new LlamaClient({ baseUrl: 'http://127.0.0.1:1', model: 'm' })

    new Session({ client, toolset, workspaceRoot: tempRoot() })
    toolset.reads.record('a.ts', 'first session read this')

    new Session({ client, toolset, workspaceRoot: tempRoot() })
    expect(toolset.reads.get('a.ts')).toBeNull()
  })
})
