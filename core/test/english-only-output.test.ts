import { afterEach, expect, test } from 'vitest'
import { buildSystemPrompt } from '../src/agent/prompt.js'
import { expandDraft, decomposeTodos, improveDraft } from '../src/session/contract.js'
import { readThroughLenses } from '../src/session/understanding.js'
import { LlamaClient } from '../src/llama/client.js'
import { startFakeServer } from './fake-server.js'

/**
 * Everything the model writes for a person to read comes out in English.
 *
 * This is the owner's standing rule for the whole tool, and for a while the prompts said the
 * opposite: several of them told the model to answer in the language of the draft, the task
 * or the request. Reported on Ctrl+E, which "always comes back in Russian" — mirroring is how
 * one stray Russian word anywhere in the context (a pasted comment, a commit message, an old
 * note) flips a whole answer, and the context of a real session is never purely one language.
 *
 * The pins live in the prompts, so these tests read the prompts. Cheap, and they fail the
 * moment somebody reintroduces a mirror.
 */

let stop: (() => Promise<void>) | undefined
afterEach(async () => { await stop?.(); stop = undefined })

/** Captures the prompt a forced generation sends, then answers with something harmless. */
async function capture(run: (client: LlamaClient) => Promise<unknown>): Promise<{ sent: string; tools: string }> {
  let body: any
  const fake = await startFakeServer((b) => {
    body = b
    return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'no' } }] }
  })
  stop = fake.close
  await run(new LlamaClient({ baseUrl: fake.url, model: 'test' }))
  return {
    sent: JSON.stringify(body?.messages ?? []),
    tools: JSON.stringify(body?.tools ?? []),
  }
}

test('the system prompt pins English rather than mirroring the user', () => {
  const text = buildSystemPrompt({ workspaceRoot: 'D:\\proj', mode: 'normal', external: { browser: false, mcpServers: [] } })
  expect(text).toContain('Always reply in English')
  // The mirror that was there, in the exact words it used.
  expect(text).not.toContain('Reply in the same language the user writes in')
})

test('the expander behind Ctrl+E asks for English, in the prompt AND in the schema', async () => {
  // Both, because they are read at different moments and the schema is the one this project
  // has measured as actually routing behaviour.
  const { sent, tools } = await capture((c) => expandDraft(c, [], 'сделай кнопку красной'))
  expect(sent).toContain('IN ENGLISH')
  expect(tools).toContain('WRITTEN IN ENGLISH')
  expect(tools).not.toContain('LANGUAGE OF THE DRAFT')
})

test('the plan decomposition asks for English steps', async () => {
  const contract = { goal: 'сделать нумерацию сплошной', criteria: ['номера не пропускаются'], constraints: [] }
  const { sent, tools } = await capture((c) => decomposeTodos(c, [], contract))
  expect(sent).toContain('IN ENGLISH')
  expect(tools).toContain('IN ENGLISH')
})

test('the understanding check asks for English lines, since they are shown as they are', async () => {
  const { tools } = await capture((c) => readThroughLenses(c, [], 'сделай чтобы номера не имели пропусков'))
  expect(tools).toContain('IN ENGLISH')
})

test('the draft improver inherits the pin from message 0 rather than restating it', async () => {
  // It carries no language clause of its own and never did; what keeps it English is the
  // system message, which `distillContext` puts at the head of every one of these requests.
  const system = { role: 'system' as const, content: buildSystemPrompt({ workspaceRoot: 'D:\\p', mode: 'normal', external: { browser: false, mcpServers: [] } }) }
  const { sent } = await capture((c) => improveDraft(c, [system], 'сделай кнопку красной'))
  expect(sent).toContain('Always reply in English')
})
