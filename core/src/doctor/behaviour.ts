/**
 * WHY something went wrong, not just that it did — and still nothing leaves but shapes.
 *
 * The counting half of this diagnosis (`diagnose.ts`) answers "what happens a lot". It
 * cannot answer the question worth asking, which the owner put like this: *the model never
 * gets the tool CALL wrong — it writes a command with a wrong path in it.* The mistake is
 * inside the argument, and the argument is the private thing. A report saying `not-found: 9`
 * names a symptom and hides its cause.
 *
 * ============================================================================
 * THE METHOD, WHICH IS NOT ABOUT PATHS
 * ============================================================================
 *
 * A path was only the first example, and building around it would have been the mistake.
 * The subject of a failure is whatever the actor got wrong: a path, a regex, an anchor that
 * matched nothing, a symbol that does not exist, an enum member that was never offered, a
 * criterion a gate would not accept. Every one of those is private, and every one of them
 * can be diagnosed without being quoted, because a diagnosis is built out of three things
 * none of which is the value:
 *
 *   SHAPE       — what KIND of thing it was and how it was built, in vocabulary we own:
 *                 our schema keys, our enum members, counts, and a whitelist of public
 *                 words. `dotnet` is public; `.\LedgerSync.exe` is a client's product.
 *
 *   RELATION    — how the SECOND attempt differed from the first. "It was a suffix of the
 *                 previous one." "It had the same parts in a different order." "It was the
 *                 same thing again." A relation is computed HERE, on the machine that
 *                 already holds both values, and only the relation travels.
 *
 *   PROVENANCE  — had the actor ever SEEN this value, or did it invent it? Answerable by
 *                 asking whether it appeared in anything returned to it earlier. A boolean,
 *                 and the most damning number in the whole report when it comes back false.
 *
 * Together those answer the owner's question in his own shape: *it tried X, it was wrong
 * like THIS, it then changed THAT, and here is whether that worked* — with X, THIS and THAT
 * all rendered as categories.
 *
 * ============================================================================
 * ACTORS, BECAUSE GATES FAIL TOO
 * ============================================================================
 *
 * A gate is an actor like the model is. Its "attempt" is a check, its "outcome" is a
 * verdict, and its "repair" is the fixer turn it forced. A gate that hands the same class of
 * thing back three times is exactly as much a finding as a tool called wrong three times,
 * and it is more expensive. The vocabulary differs; the method does not.
 */

/**
 * Every kind of thing an attempt can be ABOUT.
 *
 * Deliberately not "path". The kind decides which facts are worth extracting, and a new kind
 * is how this grows to cover a tool nobody has written yet.
 */
export type SubjectKind =
  /** Somewhere in the workspace: a file, a folder, a glob target. */
  | 'location'
  /** A pattern to match with: a regex, a glob, an anchor to find in a file. */
  | 'pattern'
  /** A line to run in a shell. */
  | 'command'
  /** A name to resolve: a symbol, a skill, a command, a role. */
  | 'name'
  /** A body of text being written: file contents, a note, a plan. */
  | 'content'
  /** A choice from a set we declared. */
  | 'choice'
  /** Something none of the above describes. Its rise is itself a finding. */
  | 'other'

/**
 * What we are willing to say about a value, in our own words.
 *
 * Every member is a count, a boolean, or a word from a list in this file. There is no member
 * that carries the value, and that is the property the whole module rests on: a `Fact` is
 * the only thing an extractor may return, so an extractor CANNOT smuggle one out.
 */
export type Fact =
  /** How many parts it has — path segments, statements in a command, alternatives in a
   * pattern. Bucketed, because an exact count of parts is a weak fingerprint and the
   * distinction that matters is one-versus-several. */
  | { fact: 'parts'; n: number }
  /** How long it is, in buckets. `tiny` is often the bug — an anchor of three characters
   * matches everywhere. */
  | { fact: 'length'; bucket: 'empty' | 'tiny' | 'short' | 'medium' | 'long' | 'huge' }
  /** It reaches outside where it started: `..`, an absolute root, a drive letter. */
  | { fact: 'escapes-upward' }
  | { fact: 'absolute' }
  /** Separators disagree with each other, or with the platform. */
  | { fact: 'mixed-separators' }
  /** A file extension we recognise as naming a language or format; never a project's own. */
  | { fact: 'extension'; ext: string }
  /** A shell operator that was used. `&&` in a shell without one is this project's most
   * watched model habit. */
  | { fact: 'operator'; op: '&&' | '||' | ';' | '|' }
  /** The command opens by changing directory — the habit whose first half fails silently. */
  | { fact: 'opens-with-cd' }
  /** A program by name, whitelisted to public tooling. */
  | { fact: 'program'; name: string }
  /** A pattern that does not compile, as opposed to one that compiles and matches nothing.
   * Different mistakes with different fixes. */
  | { fact: 'malformed' }
  /** Regex metacharacters in something used as a literal, or the reverse. */
  | { fact: 'has-metacharacters' }
  /** The value had appeared in something returned to the actor earlier in this session. */
  | { fact: 'seen-before'; seen: boolean }
  /** A key the schema declares, present in the call. Keys are ours. */
  | { fact: 'key'; name: string }
  /** A key the schema does not declare. Counted, never named — an invented key is model
   * output and could be anything. */
  | { fact: 'unknown-key' }

/** Buckets rather than lengths: the useful distinction is order-of-magnitude, and an exact
 * character count of a private string is a weak fingerprint of it. */
export function lengthBucket(n: number): Extract<Fact, { fact: 'length' }>['bucket'] {
  if (n === 0) return 'empty'
  if (n <= 8) return 'tiny'
  if (n <= 40) return 'short'
  if (n <= 200) return 'medium'
  if (n <= 2000) return 'long'
  return 'huge'
}

/** Public tool names, not anybody's software. Anything else becomes `other-program`, which
 * loses a name never worth reporting and cannot carry one that was. */
const KNOWN_PROGRAMS: ReadonlySet<string> = new Set([
  'dotnet', 'msbuild', 'nuget', 'node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno',
  'python', 'python3', 'pip', 'poetry', 'uv', 'ruby', 'gem', 'bundle',
  'cargo', 'rustc', 'go', 'java', 'javac', 'gradle', 'mvn', 'php', 'composer',
  'git', 'gh', 'docker', 'kubectl', 'terraform', 'aws', 'az', 'gcloud',
  'pwsh', 'powershell', 'cmd', 'bash', 'sh', 'wsl', 'ssh', 'curl', 'wget',
  'make', 'cmake', 'ninja', 'tsc', 'eslint', 'prettier', 'vitest', 'jest', 'pytest',
  'cd', 'ls', 'dir', 'cat', 'type', 'echo', 'rm', 'del', 'cp', 'copy', 'mv', 'move',
  'mkdir', 'test', 'where', 'which', 'get-childitem', 'get-content', 'set-location',
  'select-string', 'measure-object', 'start-sleep', 'write-output', 'foreach-object',
])

/** Extensions that name a LANGUAGE or a format rather than a project. `.cs` says something
 * useful about a workspace; `.acmeledger` says whose it is. */
const KNOWN_EXTENSIONS: ReadonlySet<string> = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'md', 'yml', 'yaml', 'toml', 'xml',
  'cs', 'csproj', 'sln', 'fs', 'vb', 'razor', 'cshtml',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'php',
  'html', 'css', 'scss', 'sql', 'sh', 'ps1', 'bat', 'cmd', 'txt', 'log', 'lock',
  'gitignore', 'env', 'dll', 'exe', 'png', 'jpg', 'svg', 'ico', 'bin',
])

/**
 * Parts of a value, for the `parts` fact and for comparing two of them. Never reported.
 *
 * Split by KIND, and that is what makes the relations general rather than path-shaped. A
 * name is separated by dots, so `Acme.Ledger.Posting` losing its namespace is the same
 * `narrowed` relation as a path losing a leading folder — which is the whole claim of this
 * module, and it was wrong until the split stopped assuming everything was a path.
 */
function partsOf(value: string, kind: SubjectKind): string[] {
  if (kind === 'command') {
    return value.split(/&&|\|\||;/).map((s) => s.trim()).filter((s) => s !== '')
  }
  if (kind === 'name') return value.split(/[.:]+/).filter((s) => s !== '')
  return value.split(/[\\/]+/).filter((s) => s !== '')
}

/**
 * Everything we are willing to say about one value.
 *
 * The return type is the guarantee. An extractor that wanted to leak would have to add a
 * member to `Fact` that carries text, which is a visible edit to a type in this file rather
 * than a slip inside a function body.
 */
export function factsAbout(value: string, kind: SubjectKind): Fact[] {
  const facts: Fact[] = [{ fact: 'length', bucket: lengthBucket(value.length) }]
  const parts = partsOf(value, kind)
  facts.push({ fact: 'parts', n: parts.length })

  if (kind === 'location' || kind === 'command' || kind === 'pattern') {
    if (parts.includes('..')) facts.push({ fact: 'escapes-upward' })
    if (/^([a-z]:|\\\\|\/)/i.test(value)) facts.push({ fact: 'absolute' })
    if (value.includes('/') && value.includes('\\')) facts.push({ fact: 'mixed-separators' })
    const last = parts[parts.length - 1] ?? ''
    const dot = last.lastIndexOf('.')
    if (dot > 0) {
      const ext = last.slice(dot + 1).toLowerCase()
      if (KNOWN_EXTENSIONS.has(ext)) facts.push({ fact: 'extension', ext })
    }
  }

  if (kind === 'command') {
    if (value.includes('&&')) facts.push({ fact: 'operator', op: '&&' })
    if (value.includes('||')) facts.push({ fact: 'operator', op: '||' })
    if (/;/.test(value)) facts.push({ fact: 'operator', op: ';' })
    if (/\|(?!\|)/.test(value)) facts.push({ fact: 'operator', op: '|' })
    if (/^\s*(cd|set-location|pushd)\b/i.test(value)) facts.push({ fact: 'opens-with-cd' })
    for (const program of new Set(parts.map(firstWord))) {
      if (program !== null) facts.push({ fact: 'program', name: program })
    }
  }

  if (kind === 'pattern') {
    if (/[.*+?^${}()|[\]\\]/.test(value)) facts.push({ fact: 'has-metacharacters' })
    try {
      new RegExp(value)
    } catch {
      facts.push({ fact: 'malformed' })
    }
  }
  return facts
}

/** The leading word of a statement, if it is one we will name. */
function firstWord(statement: string): string | null {
  const word = statement.trim().split(/[\s;|]+/)[0]
  if (word === undefined || word === '') return null
  const bare = word.replace(/^['"]|['"]$/g, '')
  // A path to an executable is not a program name — it is a product.
  if (/[\\/]/.test(bare)) return 'other-program'
  return KNOWN_PROGRAMS.has(bare.toLowerCase()) ? bare.toLowerCase() : 'other-program'
}

/**
 * How a second attempt differed from the first.
 *
 * Both values are read and neither is kept: the answer is one word. `narrowed` is where the
 * owner's own example lands — `src/Engine` becoming `Engine` is a value whose parts are a
 * suffix of the previous one's — and it is deliberately named for the RELATION rather than
 * for paths, because the same relation appears in a search pattern that dropped a
 * qualifier and in a symbol name that dropped a namespace.
 */
export type Repair =
  /** Byte for byte the same. The failure taught nothing. */
  | 'retried-identically'
  /** The new value's parts are a suffix of the old one's: something in front was dropped. */
  | 'narrowed'
  /** The reverse: something was prepended. */
  | 'broadened'
  /** Same parts, differently joined — separators, quoting, order of the same pieces. */
  | 'rejoined'
  /** The shell operators changed. */
  | 'changed-operator'
  /** The set of keys in the call changed. */
  | 'changed-keys'
  /** Same tool, a value with no structural relation to the last: a fresh guess. */
  | 'guessed-again'
  /** It went to a different tool. */
  | 'switched-tool'
  /** Nothing followed. */
  | 'gave-up'

/**
 * The relation between two attempts at the same thing.
 *
 * Order matters and is deliberate: the structural relations are tested before the
 * catch-alls, because "it dropped a leading part" is a finding and "it changed something" is
 * not.
 */
export function repairBetween(
  before: string, after: string, kind: SubjectKind,
): Repair {
  if (before === after) return 'retried-identically'

  const b = partsOf(before, kind)
  const a = partsOf(after, kind)
  const key = (parts: string[]): string => parts.join(' ')

  // Operators FIRST for a command, and the ordering IS the finding rather than a detail:
  // `cd x && build` becoming `cd x; build` has identical parts, so `rejoined` would have
  // matched and buried the one thing worth knowing — that the model changed the operator.
  // The more specific relation has to win, everywhere this grows a new one.
  if (kind === 'command') {
    const ops = (v: string): string => ['&&', '||', ';', '|'].filter((o) => v.includes(o)).join(',')
    if (ops(before) !== ops(after)) return 'changed-operator'
  }

  if (a.length < b.length && key(b.slice(b.length - a.length)) === key(a)) return 'narrowed'
  if (b.length < a.length && key(a.slice(a.length - b.length)) === key(b)) return 'broadened'
  if (a.length === b.length && key([...a].sort()) === key([...b].sort())) return 'rejoined'
  return 'guessed-again'
}

/**
 * Which argument of a call is the SUBJECT, and what kind of thing it is.
 *
 * Keyed on our own schema key names, which is what makes this safe and also what makes it
 * complete: a tool whose keys are not listed here contributes nothing rather than
 * contributing a guess. Adding a tool means adding its keys, and the test asserts every
 * shipped tool has an entry — a silent omission would make a whole tool invisible to the
 * diagnosis, which is the failure mode that produces a confidently incomplete report.
 */
export const SUBJECT_KEYS: Readonly<Record<string, SubjectKind>> = {
  // Somewhere in the workspace.
  path: 'location',
  from: 'location',
  to: 'location',
  glob: 'pattern',
  // Something to match with.
  pattern: 'pattern',
  old: 'pattern',
  anchor: 'pattern',
  query: 'pattern',
  // Something to run.
  command: 'command',
  commands: 'command',
  // Something to resolve by name.
  symbol: 'name',
  skill: 'name',
  role: 'name',
  name: 'name',
  url: 'name',
  // Something being written.
  content: 'content',
  text: 'content',
  note: 'content',
  task: 'content',
  // A choice from a set we declared.
  action: 'choice',
  mode: 'choice',
  speaker: 'choice',
  scope: 'choice',
  status: 'choice',
}

/** One value out of a call's arguments, with what kind of thing it is. Values are returned
 * so the CALLER can compare them locally; nothing here reports one. */
export function subjectsOf(argsJson: string): { key: string; kind: SubjectKind; value: string }[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(argsJson)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const obj = parsed as Record<string, unknown>
  const out: { key: string; kind: SubjectKind; value: string }[] = []
  for (const [key, raw] of Object.entries(obj)) {
    const kind = SUBJECT_KEYS[key]
    if (kind === undefined) continue
    if (typeof raw === 'string' && raw !== '') out.push({ key, kind, value: raw })
    else if (Array.isArray(raw)) {
      for (const item of raw) {
        if (typeof item === 'string' && item !== '') out.push({ key, kind, value: item })
      }
    }
  }
  return out
}

/** The keys a call actually carried, split into ones our schema knows and a count of ones it
 * does not. An invented key is model output and is counted, never named. */
export function keyFacts(argsJson: string, declared: ReadonlySet<string>): Fact[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(argsJson)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const facts: Fact[] = []
  for (const key of Object.keys(parsed as Record<string, unknown>)) {
    if (declared.has(key)) facts.push({ fact: 'key', name: key })
    else facts.push({ fact: 'unknown-key' })
  }
  return facts
}
