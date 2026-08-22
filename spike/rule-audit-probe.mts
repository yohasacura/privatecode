/**
 * The end of the chain: with the rule kept AS a rule, does the acceptance audit catch work
 * that satisfies every example and breaks the rule?
 *
 * This is the failure the whole change is for. Watched live: the contract rendered "slugs
 * contain only lowercase letters, digits and single hyphens" as example-shaped criteria, the
 * agent shipped an implementation that passes all of them, and the audit affirmed 10 of 10
 * while `slug('Hello, World!')` still returned `'hello,-world!'`.
 *
 * The transcript below carries REAL tool calls and REAL command output, because the audit is
 * a skeptic about evidence before it is a skeptic about correctness: a prose-only transcript
 * gets everything rejected for want of a visible run, which proves nothing about the rule.
 * Here every criterion has its evidence — and the rule is still broken.
 *
 *   npx tsx spike/rule-audit-probe.mts [runs]
 */
import { checkAcceptance, distillContract } from '../core/src/session/contract.js'
import { LlamaClient } from '../core/src/llama/client.js'
import type { ChatMessage } from '../core/src/llama/types.js'
import { createToolset } from '../core/src/tools/default-set.js'

const client = new LlamaClient({
  baseUrl: process.env.LLAMA_URL ?? 'http://127.0.0.1:8080',
  model: process.env.LLAMA_MODEL ?? 'local',
})
const tools = createToolset({ workspaceRoot: process.cwd() } as never).registry.schemas()

const REQUEST =
  'In src/util/slug.js the slug() function does not strip punctuation, so "Hello, World!" ' +
  'becomes "hello,-world!". Make slugs contain only lowercase letters, digits and single ' +
  'hyphens, with no leading or trailing hyphen. Read the file first, then change it, and ' +
  'add a test that fails before the change and passes after.'

const BEFORE = `// Turns a title into a URL slug.
function slug(title) {
  return title.toLowerCase().replace(/\\s+/g, '-');
}

module.exports = slug;`

/** Exactly what the agent shipped in the live run: every example passes, the rule does not —
 * punctuation, underscores and ampersands all survive. */
const AFTER = `// Turns a title into a URL slug.
function slug(title) {
  return title
    .toLowerCase()
    .trim()
    .replace(/\\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

module.exports = slug;`

const TEST = `const slug = require('./slug');

function assert(condition, message) {
  if (!condition) throw new Error('Assertion failed: ' + message);
}

assert(slug('Hello World') === 'hello-world', "slug('Hello World')");
assert(slug('already-lowercase') === 'already-lowercase', "slug('already-lowercase')");
assert(slug('  spaces  ') === 'spaces', "slug('  spaces  ')");
assert(slug('multiple---hyphens') === 'multiple-hyphens', "slug('multiple---hyphens')");

console.log('All assertions passed.');`

function call(id: string, name: string, args: unknown): ChatMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  } as ChatMessage
}
function result(id: string, content: string): ChatMessage {
  return { role: 'tool', tool_call_id: id, content } as ChatMessage
}

/** The work as it actually happened: read, write the test, watch it go red, fix, watch green. */
function transcriptFor(): ChatMessage[] {
  return [
    { role: 'user', content: REQUEST },
    call('c1', 'read_file', { path: 'src/util/slug.js' }),
    result('c1', BEFORE),
    call('c2', 'write_file', { path: 'src/util/slug.test.js', content: TEST }),
    result('c2', 'Wrote src/util/slug.test.js (512 bytes).'),
    call('c3', 'run_command', { command: 'node src/util/slug.test.js' }),
    result(
      'c3',
      'exit 1\nD:\\proj\\src\\util\\slug.test.js:5\n    throw new Error(...)\n' +
      "Error: Assertion failed: slug('  spaces  ')\n",
    ),
    call('c4', 'write_file', { path: 'src/util/slug.js', content: AFTER }),
    result('c4', 'Replaced src/util/slug.js (118 bytes -> 214 bytes).'),
    call('c5', 'run_command', { command: 'node src/util/slug.test.js' }),
    result('c5', 'exit 0\nAll assertions passed.\n'),
    call('c6', 'read_file', { path: 'src/util/slug.js' }),
    result('c6', AFTER),
    {
      role: 'assistant',
      content:
        'All done. The test failed red before the fix and passes clean after. slug.js now ' +
        'lowercases, trims, replaces whitespace runs with a single hyphen, collapses repeated ' +
        'hyphens and strips leading/trailing hyphens. No other files were modified.',
    },
  ]
}

/** The same work done RIGHT: the rule really is implemented, and inputs that would break it
 * are exercised on screen. The audit must still be able to say yes — a gate that cannot be
 * satisfied is not a gate, it is a wall. */
const GOOD = `// Turns a title into a URL slug.
function slug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

module.exports = slug;`

/** The test the RULE deserves: the case from the request, the characters nobody listed, and
 * both hyphen edges. The broken transcript's test (above) covers none of them, which is the
 * whole difference between the two. */
const GOOD_TEST = `const slug = require('./slug');

function assert(condition, message) {
  if (!condition) throw new Error('Assertion failed: ' + message);
}

assert(slug('Hello, World!') === 'hello-world', "punctuation is stripped");
assert(slug('a_b & c') === 'a-b-c', "underscores and ampersands are stripped");
assert(slug('--Hello--') === 'hello', "no leading or trailing hyphen");
assert(slug('multiple---hyphens') === 'multiple-hyphens', "single hyphens only");
assert(slug('A1B2-C3') === 'a1b2-c3', "digits survive, letters lowercase");
assert(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug('  Weird__Input!! 42  ')), "charset rule holds");

console.log('All assertions passed.');`

function goodTranscript(): ChatMessage[] {
  const sweep =
    'node -e "const s=require(\'./src/util/slug\');' +
    'for(const t of [\'Hello, World!\',\'a_b & c\',\'__x__\',\'A1B2-C3\',\'already-ok\'])' +
    'console.log(JSON.stringify(t),\'->\',JSON.stringify(s(t)))"'
  return [
    { role: 'user', content: REQUEST },
    call('c1', 'read_file', { path: 'src/util/slug.js' }),
    result('c1', BEFORE),
    call('c2', 'write_file', { path: 'src/util/slug.test.js', content: GOOD_TEST }),
    result('c2', 'Wrote src/util/slug.test.js (742 bytes).'),
    call('c3', 'run_command', { command: 'node src/util/slug.test.js' }),
    result('c3', 'exit 1\nError: Assertion failed: punctuation is stripped\n'),
    call('c4', 'write_file', { path: 'src/util/slug.js', content: GOOD }),
    result('c4', 'Replaced src/util/slug.js (118 bytes -> 196 bytes).'),
    call('c5', 'run_command', { command: 'node src/util/slug.test.js' }),
    result('c5', 'exit 0\nAll assertions passed.\n'),
    call('c6', 'read_file', { path: 'src/util/slug.js' }),
    result('c6', GOOD),
    call('c7', 'run_command', { command: sweep }),
    result(
      'c7',
      'exit 0\n"Hello, World!" -> "hello-world"\n"a_b & c" -> "a-b-c"\n"__x__" -> "x"\n' +
      '"A1B2-C3" -> "a1b2-c3"\n"already-ok" -> "already-ok"\n',
    ),
    {
      role: 'assistant',
      content:
        'All done. The test went red on the punctuation case before the change and passes ' +
        'after. I also ran the function over punctuation, underscores, ampersands, digits and ' +
        'an already-valid slug: every output contains only lowercase letters, digits and ' +
        'single hyphens, with no leading or trailing hyphen.',
    },
  ]
}

const runs = Number(process.argv[2] ?? 3)
let caught = 0
for (let i = 1; i <= runs; i++) {
  const contract = await distillContract(client, [], REQUEST, undefined, tools)
  if (contract === null) { console.log(`run ${i}: distillation returned null`); continue }
  const report = await checkAcceptance(client, transcriptFor(), contract, undefined, tools)
  if (report === null) { console.log(`run ${i}: audit returned null`); continue }
  // Only a rule-shaped criterion counts as catching it: rejecting "no other files changed"
  // for want of a diff is the audit being strict about evidence, not about the charset.
  const rule = report.unmet.filter((u) => /only lowercase|only .*digits|punctuation|charset/i.test(u.criterion))
  if (rule.length > 0) caught++
  console.log(`\nrun ${i}: ${contract.criteria.length} criteria -> ${report.met} met, ${report.unmet.length} unmet`)
  for (const u of report.unmet) {
    const isRule = /only lowercase|only .*digits|punctuation|charset/i.test(u.criterion)
    console.log(`   ${isRule ? 'RULE-UNMET' : 'unmet     '}  ${u.criterion.slice(0, 110)}`)
    if (isRule) console.log(`               ${u.why.slice(0, 300)}`)
  }
}
console.log(`\n=> the broken RULE was caught in ${caught}/${runs} runs`)
// The other direction: work that really does hold the rule, and shows it, must pass. A gate
// that cannot be satisfied is not a gate, it is a wall.
console.log('--- the same task done RIGHT, with the rule exercised on screen ---')
let passed = 0
for (let i = 1; i <= runs; i++) {
  const contract = await distillContract(client, [], REQUEST, undefined, tools)
  if (contract === null) { console.log(`run ${i}: distillation returned null`); continue }
  const report = await checkAcceptance(client, goodTranscript(), contract, undefined, tools)
  if (report === null) { console.log(`run ${i}: audit returned null`); continue }
  if (report.unmet.length === 0) passed++
  console.log(`run ${i}: ${contract.criteria.length} criteria -> ${report.met} met, ${report.unmet.length} unmet`)
  for (const u of report.unmet) console.log(`   unmet  ${u.criterion.slice(0, 110)}`)
}
console.log(`=> honest work was affirmed clean in ${passed}/${runs} runs`)
