/**
 * Does the understanding check still ask a question the contract already answers?
 *
 * The case is the real one, copied out of session s-20260823-004429: eight criteria, and a
 * card offering three readings that were all already required. The turn stopped, a person was
 * interrupted, three boxes were ticked, and the contract came back byte-identical.
 *
 * Also checks the direction that must NOT change: a reading the contract does not carry has
 * to survive the filter and still be asked about. Suppressing a real question is the one
 * failure here that costs something.
 *
 *   npx tsx spike/contested-filter-probe.mts [rounds]
 */
import { buildQuestion, contestedBeyondContract, type Understanding } from '../core/src/session/understanding.js'
import { LlamaClient } from '../core/src/llama/client.js'

const client = new LlamaClient({
  baseUrl: process.env.LLAMA_URL ?? 'http://127.0.0.1:8080',
  model: process.env.LLAMA_MODEL ?? 'local',
})

/** Session s-20260823-004429-7e02, exactly. */
const CONTRACT = [
  'slugs contain only lowercase letters, digits and single hyphens — e.g. "Hello, World!" must become "hello-world"',
  'no leading or trailing hyphen — e.g. a slug must not start or end with "-"',
  'src/util/slug.js is read before any edits are made',
  'slug("Hello, World!") returns "hello-world"',
  'slug("a--b") returns "a-b"',
  'slug("-hello-") returns "hello"',
  'a test file exists that fails before the fix and passes after the fix',
  'A reproduction (script or test) demonstrably FAILED before the fix — its red run is in the conversation — and passes after it',
]
const OFFERED = [
  'Slugs contain only lowercase letters, digits, and single hyphens',
  'No slug starts or ends with a hyphen',
  'Punctuation is stripped before slug generation',
]

/** Same contract, but one reading it genuinely does not require. */
const GENUINELY_NEW = [
  'slugs are truncated to 60 characters',
  'the original title is kept alongside the slug',
]

async function round(n: number): Promise<void> {
  const covered: Understanding = { shared: [], contested: OFFERED }
  const a = await contestedBeyondContract(client, covered, CONTRACT)
  const askedA = buildQuestion(a.understanding) !== null

  const mixed: Understanding = { shared: [], contested: [...OFFERED.slice(0, 1), ...GENUINELY_NEW] }
  const b = await contestedBeyondContract(client, mixed, CONTRACT)
  const askedB = buildQuestion(b.understanding) !== null
  const kept = b.understanding.contested

  console.log(
    `round ${n}: all-already-required -> ${a.understanding.contested.length}/3 left, ` +
    `${askedA ? 'STILL ASKS' : 'no question'}   |   ` +
    `mixed -> kept ${kept.length}/3 ${askedB ? '(asks)' : '(silent)'}: ${JSON.stringify(kept)}`,
  )
}

const rounds = Number(process.argv[2] ?? 3)
for (let i = 1; i <= rounds; i++) await round(i)
