import { afterEach, expect, test } from 'vitest'
import { buildSystemPrompt } from '../src/agent/prompt.js'
import { checkAcceptance, expandDraft, decomposeTodos, improveDraft } from '../src/session/contract.js'
import { statePremises } from '../src/session/premises.js'
import { buildCompactionRequest } from '../src/session/compaction.js'
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
    // Where the SHAPE is declared. Note this is deliberately NOT where a language pin may
    // live: a `response_format` schema is compiled to a grammar and never rendered, so a
    // `description` on it reaches the model as exactly zero tokens (measured: an 868-char
    // description leaves the prompt at 275 tokens either way). Anything that has to route
    // behaviour must be in `sent`, which is why the understanding test below reads `sent`.
    tools: JSON.stringify(body?.response_format ?? body?.tools ?? []),
  }
}

test('the system prompt pins English rather than mirroring the user', () => {
  const text = buildSystemPrompt({ workspaceRoot: 'D:\\proj', mode: 'normal', external: { browser: false, mcpServers: [] } })
  expect(text).toContain('Always reply in English')
  // The mirror that was there, in the exact words it used.
  expect(text).not.toContain('Reply in the same language the user writes in')
})

test('the expander behind Ctrl+E asks for English, in the PROMPT', async () => {
  // In the prompt, and only there. This used to assert it in the schema too, on the theory
  // that the schema is what routes behaviour -- true while the shape was forced by a
  // RENDERED `tools` array, false now: a `response_format` schema is compiled to a grammar
  // and reaches the model as zero tokens. A pin left there would be declared, tested, and
  // invisible, which is exactly the regression this file exists to catch.
  const { sent } = await capture((c) => expandDraft(c, [], 'сделай кнопку красной'))
  expect(sent).toContain('WRITTEN IN ENGLISH')
  expect(sent).not.toContain('LANGUAGE OF THE DRAFT')
})

test('the plan decomposition asks for English steps', async () => {
  const contract = { goal: 'сделать нумерацию сплошной', criteria: ['номера не пропускаются'], constraints: [] }
  // In the PROMPT. The plan gate forces its shape with `response_format` now, and a schema
  // is compiled to a grammar and never rendered — so a pin left in a `description` reaches
  // the model as exactly zero tokens.
  const { sent } = await capture((c) => decomposeTodos(c, [], contract))
  expect(sent).toContain('IN ENGLISH')
})

test('the understanding check asks for English lines, since they are shown as they are', async () => {
  // In the PROMPT, not in the schema. This assertion used to read the schema and passed for
  // the wrong reason: the pin was moved into a `response_format` description when the gate
  // was converted, and a schema description is never rendered -- so for one commit the pin
  // was declared, tested, and invisible to the model.
  const { sent } = await capture((c) => readThroughLenses(c, [], 'сделай чтобы номера не имели пропусков'))
  expect(sent).toContain('IN ENGLISH')
})

test('the draft improver inherits the pin from message 0 rather than restating it', async () => {
  // It carries no language clause of its own and never did; what keeps it English is the
  // system message, which `distillContext` puts at the head of every one of these requests.
  const system = { role: 'system' as const, content: buildSystemPrompt({ workspaceRoot: 'D:\\p', mode: 'normal', external: { browser: false, mcpServers: [] } }) }
  const { sent } = await capture((c) => improveDraft(c, [system], 'сделай кнопку красной'))
  expect(sent).toContain('Always reply in English')
})

/**
 * The three gates whose text reaches a PERSON and carried no pin at all.
 *
 * Found by asking the shipped `checkAcceptance` about a Russian transcript with Russian
 * criteria: it answered in Russian, and that answer is not internal — it goes into
 * `contract.checkedState`, which `renderContract` promotes into message 0 at every compaction
 * swap, and `acceptanceFailureMessage` puts it on screen as a note row. The diff reviewer,
 * over the same conversation, answered in English, because its brief is English. The pin is
 * the whole difference.
 */
test('the acceptance audit asks for English, since its evidence reaches message 0 and the screen', async () => {
  const contract = { goal: 'сделать нумерацию сплошной', criteria: ['номера не пропускаются'], constraints: [] }
  const { sent } = await capture((c) => checkAcceptance(c, [], contract))
  expect(sent).toContain('IN ENGLISH')
})

test('the premise check asks for English, since its `why` reaches the person', async () => {
  const { sent } = await capture((c) => statePremises(c, [{ role: 'user', content: 'сделай нумерацию сплошной' }]))
  expect(sent).toContain('IN ENGLISH')
})

test('the compaction briefing asks for English, since it becomes message 0', () => {
  const request = buildCompactionRequest({
    messages: [{ role: 'user', content: 'сделай нумерацию сплошной' }],
    budgetTokens: 1000,
    tools: [],
    workspaceRoot: 'D:\proj',
  })
  expect(JSON.stringify(request.messages)).toContain('IN ENGLISH')
})
