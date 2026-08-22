/**
 * Does contract distillation keep a general RULE as a rule, or split it into instances?
 *
 * Watched live: "slugs contain only lowercase letters, digits and single hyphens" came back
 * as ten example-shaped criteria — `slug('Hello World') returns 'hello-world'`,
 * `slug('multiple---hyphens') returns 'multiple-hyphens'` — and not one of them stated the
 * rule. The shipped code then passed all ten while `slug('Hello, World!')` still returned
 * `'hello,-world!'`. The audit was right; the contract was not.
 *
 * Runs the SHIPPED `distillContract` against the real server, several requests that each
 * carry a general rule, and prints what came back.
 *
 *   npx tsx spike/distill-rule-probe.mts [runsPerRequest]
 */
import { distillContract } from '../core/src/session/contract.js'
import { LlamaClient } from '../core/src/llama/client.js'
import { createToolset } from '../core/src/tools/default-set.js'

const client = new LlamaClient({
  baseUrl: process.env.LLAMA_URL ?? 'http://127.0.0.1:8080',
  model: process.env.LLAMA_MODEL ?? 'local',
})
const tools = createToolset({ workspaceRoot: process.cwd() } as never).registry.schemas()

/** Each request states a rule over ALL inputs, plus enough prose to clear `looksLikeTask`. */
const REQUESTS: { name: string; text: string; rule: RegExp }[] = [
  {
    name: 'slug charset',
    rule: /only|any input|every input|all inputs/i,
    text:
      'In src/util/slug.js the slug() function does not strip punctuation, so "Hello, World!" ' +
      'becomes "hello,-world!". Make slugs contain only lowercase letters, digits and single ' +
      'hyphens, with no leading or trailing hyphen. Read the file first, then change it, and ' +
      'add a test that fails before the change and passes after.',
  },
  {
    name: 'money rounding',
    rule: /every|all |any |never|only/i,
    text:
      'Our invoice totals are inconsistent. In src/billing/total.ts every monetary amount ' +
      'must be rounded half-up to two decimals before it is summed, not after — right now ' +
      'some paths round at the end. Go through the file, fix each place, and add a test ' +
      'covering the rounding rule.',
  },
  {
    name: 'header casing',
    rule: /every|all |any |never|only/i,
    text:
      'The HTTP client in src/net/client.ts sends header names in whatever case the caller ' +
      'used. Normalise every outgoing header name to lower-case before the request is sent, ' +
      'whatever the caller passed. Look at how headers are assembled first, then change it, ' +
      'and add a test that would have failed before.',
  },
]

const runs = Number(process.argv[2] ?? 2)
for (const req of REQUESTS) {
  console.log(`\n=== ${req.name} ===`)
  for (let i = 1; i <= runs; i++) {
    const contract = await distillContract(client, [], req.text, undefined, tools)
    if (contract === null) { console.log(`  run ${i}: (distillation returned null)`); continue }
    const stated = contract.criteria.filter((c) => req.rule.test(c))
    console.log(`  run ${i}: ${contract.criteria.length} criteria, ${stated.length} state the RULE`)
    for (const c of contract.criteria) {
      console.log(`     ${req.rule.test(c) ? 'RULE ' : 'inst '} ${c}`)
    }
  }
}
