/**
 * What the `tools` array actually costs the TOKENIZER, not chars/4.
 *
 * `TOOL_SCHEMA_TOKENS` was retuned by dividing the serialised array by four. The server
 * renders that array through the chat template and tokenizes the result, and the two
 * numbers are not the same. This asks the server.
 *
 *   npx tsx spike/tool-block-tokens.mts
 */
import { createToolset } from '../core/src/tools/default-set.js'

const BASE = process.env.LLAMA_URL ?? 'http://127.0.0.1:8080'
const post = async (path: string, body: unknown): Promise<any> => {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
  return await r.json()
}

const toolset = createToolset({ workspaceRoot: process.cwd() } as never)
const tools = toolset.registry.schemas()
const chars = JSON.stringify(tools).length
console.log(`tools registered : ${tools.length}`)
console.log(`serialised       : ${chars} chars  (chars/4 = ${Math.ceil(chars / 4)})`)

const messages = [{ role: 'user', content: 'x' }]
const withT = await post('/apply-template', { messages, tools })
const noT = await post('/apply-template', { messages })
const tw = await post('/tokenize', { content: withT.prompt })
const to = await post('/tokenize', { content: noT.prompt })

console.log(`rendered with tools : ${tw.tokens.length} tokens`)
console.log(`rendered without    : ${to.tokens.length} tokens`)
console.log(`=> TOOL BLOCK       : ${tw.tokens.length - to.tokens.length} tokens`)
console.log(`   chars/4 reads      ${Math.ceil(chars / 4) - (tw.tokens.length - to.tokens.length)} LOW`)

// Second, independent route: what the chat endpoint itself charges.
const chat = async (body: unknown): Promise<number> => {
  const r: any = await post('/v1/chat/completions', body)
  return r.usage.prompt_tokens as number
}
const a = await chat({ messages, tools, max_tokens: 1, stream: false })
const b = await chat({ messages, max_tokens: 1, stream: false })
console.log(`\n/v1/chat prompt_tokens: with ${a}, without ${b} => ${a - b}`)
