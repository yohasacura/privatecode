import type { PermissionKey } from '../tools/types.js'

/**
 * A permission rule as written in settings, split into its tool name and (optional)
 * spec, plus the original text it was parsed from. Pure data: no behavior lives here,
 * `ruleMatches` interprets it against a `PermissionKey`.
 */
export interface ParsedRule {
  tool: string
  spec?: string
  raw: string
}

const TOOL_NAME_RE = /^[a-z_][a-z0-9_]*$/i

/**
 * The namespace every MCP-contributed tool is registered under: `mcp__<server>__<tool>`.
 * Declared here rather than in `engine.ts` because `toolNameMatches` below needs it and
 * the dependency only runs one way (engine.ts imports rules.ts, never the reverse);
 * `engine.ts` re-exports it so callers have one place to import from.
 */
export const MCP_TOOL_PREFIX = 'mcp__'

/**
 * Does `ruleTool` cover `keyTool`? Normally exact equality — a rule names one tool.
 *
 * The one exception is an MCP server rule: `mcp__github` covers every tool that server
 * contributes (`mcp__github__create_issue`, ...), which is the granularity people actually
 * want to grant and the one the approval dialog offers as its second suggestion.
 *
 * The boundary is the `__` separator, checked explicitly: `mcp__git` does NOT cover
 * `mcp__github__create_issue`, because `mcp__git__` is not a prefix of it. A bare
 * `startsWith(ruleTool)` would let a shorter server name silently authorize a longer one's
 * tools, which is the whole class of bug this function exists to close.
 *
 * Scoped to rules that themselves begin with `mcp__`, so no built-in tool name can acquire
 * prefix semantics by accident.
 */
function toolNameMatches(ruleTool: string, keyTool: string): boolean {
  if (ruleTool === keyTool) return true
  if (!ruleTool.startsWith(MCP_TOOL_PREFIX)) return false
  return keyTool.startsWith(`${ruleTool}__`)
}

// Collapses runs of adjacent `**` segments -- however many, whether directly touching
// (`a/****b`) or `/`-joined (`a/**/**/b`) -- into a single `**`, since they're
// equivalent to it. Applied before matching (so `a/**/**/b` behaves like `a/**/b`,
// which the token-wise DP matcher below relies on: without this collapse, two
// `/`-separated globstar tokens would each demand their own literal `/` character in
// the path, which a single intervening `/` can't satisfy) and before glob-to-RegExp
// translation for the same reason.
function collapseDoubleStarRuns(glob: string): string {
  let prev: string
  let next = glob
  do {
    prev = next
    next = prev.replace(/\*\*\/?\*\*/g, '**')
  } while (next !== prev)
  return next
}

// A drive prefix (`c:`, `C:`, ...) can never appear in a canonicalized, workspace-
// relative path (see `canonicalizePath`), so a spec bearing one could never match a
// path-keyed rule -- see `specHasNonCanonicalSyntax`, which uses this pattern, and
// `pathMatches`, which fails closed on it. Case-insensitive because the spec itself
// isn't lowercased until match time.
const SPEC_DRIVE_PREFIX_RE = /^[a-z]:/i

// True if `spec`, split on `/`, contains a segment that is exactly `.` or `..`, an
// empty segment (from a leading `/`, a trailing `/`, or an internal `//`), or starts
// with a drive prefix. Incoming paths are canonicalized before matching -- `.`/`..`
// segments collapsed, absolute/drive-prefixed paths refused outright -- so a spec
// written in any of these non-canonical forms (`./src/**`, `src/./**`, `src/../**`,
// `src//**`, `/src/**`, `c:/src/**`) could never match a canonicalized path. Segments
// are checked for EXACT equality: a `.`-bearing filename like `a.ts` or a `..`-prefixed
// one like `..foo` is an ordinary segment and is left alone.
//
// NOT called from `parseRule`: a rule spec is shared syntax between command rules and
// path rules, and a command spec legitimately contains `//` -- `run_command(git clone
// https://github.com/x/y:*)` has an empty segment between the two `/` of `https://`,
// which this check would flag even though it's an ordinary, matchable command rule.
// Applying a check that's only meaningful for one of the two shared kinds uniformly at
// parse time would make that command rule unrepresentable. Instead:
// - `pathMatches` (below) consults this directly and fails closed on it -- silently, no
//   rule is "wrong," it just can never match a canonicalized path.
// - The Task-7 settings-loading engine calls this exported function against rules bound
//   to path-keyed tools specifically, to report a LOUD settings problem to the user (a
//   rule that can never match is almost certainly a typo, worth surfacing even though
//   `parseRule` itself accepts it).
export function specHasNonCanonicalSyntax(spec: string): boolean {
  if (SPEC_DRIVE_PREFIX_RE.test(spec)) return true
  return spec.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
}

// A spec this long has almost certainly been corrupted or pasted in by mistake -- no
// legitimate hand- or tool-authored rule spec is anywhere near this size. The DP matcher
// (`globMatch`) is linear time, not exponential, but linear in a ~50 KB spec is still
// real cost: a spec that size was measured at ~1.1s per match, which is worth refusing
// outright at parse time rather than silently accepting a rule that makes every matching
// call against it slow.
const MAX_SPEC_LENGTH = 1024

/**
 * Parses one settings-file rule line. Accepts `tool_name` (matches every invocation)
 * and `tool_name(spec)` (matches per `ruleMatches`, see below). The spec is everything
 * between the first `(` and the LAST `)` in the (trimmed) string -- so a spec may itself
 * contain parentheses -- and nothing may follow that closing paren. Anything that does
 * not fit this shape returns `null` rather than a best-effort partial parse: a typo'd
 * rule must be loud (Task 7 reports nulls as settings problems), not silently inert.
 * This includes an empty string, an unbalanced `(`, an empty or whitespace-only spec
 * (`tool()`, `tool(   )` -- almost certainly a typo, not a deliberate "match nothing"),
 * a spec containing a raw NUL character (JSON settings can smuggle one in, and it would
 * otherwise silently behave like `**` in `globToRegExp`'s display form), and a spec
 * longer than `MAX_SPEC_LENGTH` characters (see that constant's comment).
 *
 * Deliberately NOT rejected here: syntactically non-canonical path-shaped syntax (see
 * `specHasNonCanonicalSyntax`). That check only makes sense for path rules, and a rule's
 * kind (command vs. path) isn't known until `ruleMatches` sees what the `PermissionKey`
 * carries -- applying it uniformly at parse time would also misfire on command specs
 * that legitimately contain `//` (a URL). `pathMatches` applies it itself instead.
 */
export function parseRule(raw: string): ParsedRule | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null

  const firstParen = trimmed.indexOf('(')
  if (firstParen === -1) {
    if (!TOOL_NAME_RE.test(trimmed)) return null
    return { tool: trimmed, raw }
  }

  const name = trimmed.slice(0, firstParen)
  if (!TOOL_NAME_RE.test(name)) return null

  const lastParen = trimmed.lastIndexOf(')')
  // The closing paren must exist, come after the opening one, and be the final
  // character -- otherwise the rule is unbalanced or has trailing garbage.
  if (lastParen === -1 || lastParen <= firstParen || lastParen !== trimmed.length - 1) {
    return null
  }

  const spec = trimmed.slice(firstParen + 1, lastParen)
  if (spec.trim() === '') return null
  if (spec.includes('\u0000')) return null
  if (spec.length > MAX_SPEC_LENGTH) return null

  return { tool: name, spec, raw }
}

// Normalizes a command line for prefix/exact comparison: trims outer whitespace,
// collapses internal whitespace runs to a single space, and lowercases.
function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ').toLowerCase()
}

// A spec ending in the literal two characters `:*` is read as a prefix rule below. That
// `endsWith(':*')` test is unconditional -- it can't tell a deliberate prefix marker
// from a command whose real, literal suffix happens to be those two characters -- so a
// command ending in `:*` can never be pinned down with an exact-match rule; the parser
// always reads a trailing `:*` as "this is a prefix rule," no matter what produced it.
function commandMatches(spec: string, command: string): boolean {
  const normCmd = normalizeCommand(command)
  // Trim the spec (not just normalize the command) before the `:*` test, so a stray
  // trailing space inside the rule's parens -- `run_command(git status:* )` -- still
  // reads as the prefix rule it obviously means to be, instead of falling through to an
  // exact-match comparison that can never succeed.
  const trimmedSpec = spec.trim()
  if (trimmedSpec.endsWith(':*')) {
    const prefix = normalizeCommand(trimmedSpec.slice(0, -2))
    // Prefix boundary: exact equality, or followed by a space -- "git st:*" must not
    // match "git status" (no boundary between "st" and "atus").
    return normCmd === prefix || normCmd.startsWith(prefix + ' ')
  }
  return normCmd === normalizeCommand(spec)
}

// Trim + lowercase, and nothing else. Deliberately NOT `normalizeCommand`: that collapses
// internal whitespace runs, which is right for a command line and meaningless for a URL
// (a real space in a URL is %20). Lowercasing matches the rest of this rule language and
// is correct for the part that decides the boundary -- scheme and host are
// case-insensitive by spec. It does mean a path rule is case-insensitive too, so
// `browser(https://x.dev/admin)` also covers `/ADMIN`; that is the same server the user
// already approved, and the alternative -- a rule that silently fails to match because the
// model spelled a path differently -- costs a re-approval every time.
function normalizeTarget(target: string): string {
  return target.trim().toLowerCase()
}

// Characters that may follow a `:*` prefix. The prefix must land on a component boundary,
// so `browser(https://example.dev:*)` covers `https://example.dev/app` and NOT
// `https://example.dev.evil.com` -- a different host that merely starts the same way, which
// is the one over-grant that would actually matter.
//
// `:` is in the set, which has a consequence worth stating: `https://example.dev:*` also
// covers `https://example.dev:8443/x`, a different port and therefore a different origin.
// That is deliberate. The `:*` marker consumes a colon (`http://localhost:*` has the prefix
// `http://localhost`), so excluding `:` here would make "any port on localhost" -- the single
// most useful rule a person developing locally can write -- unspellable. What the rule buys
// in exchange is bounded: a different port on a host the user just approved, on their own
// machine or one they named. A different HOST is still refused, which is the boundary that
// carries the security weight.
const TARGET_BOUNDARY = new Set(['/', '?', '#', ':'])

/**
 * Matches a rule spec against a `PermissionKey.target` (a URL). Same `:*` prefix marker the
 * command rules use, with a boundary that understands URLs instead of argv -- `commandMatches`
 * breaks on a space, and a URL has none.
 *
 * A prefix that already ends in a separator (`:` or `/`) matches anything after it, so
 * `browser(http://localhost:5173/admin/:*)` covers everything below that path.
 */
function targetMatches(spec: string, target: string): boolean {
  const trimmedSpec = spec.trim()
  const t = normalizeTarget(target)
  if (!trimmedSpec.endsWith(':*')) return t === normalizeTarget(trimmedSpec)

  const prefix = normalizeTarget(trimmedSpec.slice(0, -2))
  if (prefix === '') return false // `browser(:*)` would otherwise authorize every URL
  if (t === prefix) return true
  if (!t.startsWith(prefix)) return false
  if (prefix.endsWith(':') || prefix.endsWith('/')) return true
  return TARGET_BOUNDARY.has(t[prefix.length]!)
}

// Placeholder used to protect `**` while the surrounding text goes through the
// single-`*` replacement below. NUL (`\u0000`) is used because it can never appear in a
// glob spec anyone would actually type or generate, so stashing it there and expanding
// it back out afterward is safe. A literal space is NOT safe for this: it's an
// ordinary, typeable glob character (e.g. a path with a space in a directory name), and
// using it as the placeholder would make that literal space behave like `**` once it
// hits the split/join below -- which is exactly the bug this constant now avoids.
const DOUBLE_STAR_PLACEHOLDER = '\u0000'

/**
 * Translates a glob (as used in path-rule specs) into an anchored, case-insensitive
 * RegExp. `*` matches within one path segment, `?` matches exactly one character (also
 * confined to a segment), and `**` matches across segments including zero segments --
 * except that the `/` flanking a `**` token in the source glob stays a literal `/` in
 * the output pattern, so `**` still needs an actual intermediate segment to match
 * anything: a glob of `src` + `/**` + `/*.ts` does NOT match `src/a.ts` (there's no
 * second `/` for the `**` to span). This is a deliberate deviation from minimatch,
 * where a trailing-slash `**` can also match zero segments. Adjacent `**` runs are
 * collapsed first (see `collapseDoubleStarRuns`).
 *
 * NOT THE MATCHER: actual path matching goes through `tokenizeGlob`/`globMatch` below
 * (a token-wise DP walk, immune to backtracking) via `pathMatches`. This function
 * builds a backtracking regex and is kept only for display/verification purposes --
 * e.g. showing a user what a spec "means" -- where its NUL-placeholder trick (see
 * `DOUBLE_STAR_PLACEHOLDER`) is fine because the caller isn't feeding it adversarial
 * input to test against. Exported only so tests can exercise the translation directly.
 */
export function globToRegExp(glob: string): RegExp {
  const collapsed = collapseDoubleStarRuns(glob)
  // Escape every regex metacharacter except * and ?, which the glob syntax repurposes.
  const escaped = collapsed.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const doubleStarred = escaped.replace(/\*\*/g, DOUBLE_STAR_PLACEHOLDER)
  const starred = doubleStarred.replace(/\*/g, '[^/]*')
  const questioned = starred.replace(/\?/g, '[^/]')
  const pattern = questioned.split(DOUBLE_STAR_PLACEHOLDER).join('.*')
  return new RegExp(`^${pattern}$`, 'i')
}

type GlobToken = { kind: 'globstar' } | { kind: 'star' } | { kind: 'question' } | { kind: 'char'; ch: string }

// Splits an (already `collapseDoubleStarRuns`-collapsed) glob into a token sequence for
// `globMatch`. A run of two or more consecutive `*` characters (already reduced to
// exactly `**` by the caller in the common case, but this loop also tolerates a raw
// longer run like `***` reaching here directly) becomes one `globstar` token.
function tokenizeGlob(spec: string): GlobToken[] {
  const tokens: GlobToken[] = []
  for (let i = 0; i < spec.length; i++) {
    if (spec[i] === '*') {
      if (spec[i + 1] === '*') {
        // collapse the whole run of consecutive stars (>= 2) into one globstar
        while (spec[i + 1] === '*') i++
        tokens.push({ kind: 'globstar' })
      } else {
        tokens.push({ kind: 'star' })
      }
    } else if (spec[i] === '?') {
      tokens.push({ kind: 'question' })
    } else {
      tokens.push({ kind: 'char', ch: spec[i]! })
    }
  }
  return tokens
}

/**
 * O(tokens*path) DP: no backtracking regex, no pathological input. Case-insensitively
 * lowercased by the caller. globstar crosses '/', star and question do not.
 *
 * `prev[j]` / `next[j]` mean "the tokens consumed so far can match `path`'s first `j`
 * characters." Each token widens the reachable-prefix-lengths set from `prev` to
 * `next`; the final answer is whether the full path length is reachable after the last
 * token. Runtime is O(tokens x pathLength) with no branching on path content, so there
 * is no input that makes it slow -- this is what lets `parseRule` accept an unbounded
 * number of `**` tokens instead of capping them against exponential regex backtracking.
 */
function globMatch(tokens: GlobToken[], path: string): boolean {
  const n = path.length
  let prev = new Array<boolean>(n + 1).fill(false)
  prev[0] = true
  for (const t of tokens) {
    const next = new Array<boolean>(n + 1).fill(false)
    if (t.kind === 'globstar') {
      next[0] = prev[0]!
      for (let j = 1; j <= n; j++) next[j] = prev[j]! || next[j - 1]!
    } else if (t.kind === 'star') {
      next[0] = prev[0]!
      for (let j = 1; j <= n; j++) {
        next[j] = prev[j]! || (next[j - 1]! && path[j - 1] !== '/')
      }
    } else if (t.kind === 'question') {
      for (let j = 1; j <= n; j++) next[j] = prev[j - 1]! && path[j - 1] !== '/'
    } else {
      for (let j = 1; j <= n; j++) next[j] = prev[j - 1]! && path[j - 1] === t.ch
    }
    prev = next
  }
  return prev[n]!
}

// Normalizes a rule spec's glob text for matching: backslashes to forward slashes (in
// case a spec was ever authored Windows-style) and lowercased for case-insensitive
// matching. This is for the SPEC side only. Incoming paths go through
// `canonicalizePath` below instead, which additionally guards against `..` traversal
// and absolute paths -- a spec is trusted, developer-authored rule text, an incoming
// path is not.
function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase()
}

/**
 * Lexically canonicalizes an incoming (workspace-relative) path before it's matched
 * against a spec: backslashes to `/`, lowercased, then `.`/`..` segments collapsed via
 * a standard stack walk. Returns `null` -- meaning "matches no spec'd rule, ever" --
 * for anything that isn't safely workspace-relative after that: an absolute path
 * (leading `/`, or a `C:`-style drive prefix) or a path whose collapsed form still
 * starts with `..` (net traversal above the workspace root). This is a fail-closed
 * check: a path that can't be resolved to a clean relative form is refused rather than
 * guessed at, so `edit_file(src/**)` can't be fooled by `src/../.env`, and
 * `edit_file(**)` can't be fooled by `/etc/shadow` or `C:/x`.
 *
 * Also mirrors two more Win32-open-time aliasing tricks -- the same class of bug as
 * `TRAILING_DOTS_AND_SPACES` in workspace.ts, applied here so a PATH-keyed deny rule
 * spec'd against the canonical spelling can't be bypassed by a spelling Windows treats
 * as identical. Measured: deny `edit_file(src/generated/**)` plus a call spelled
 * `src/generated./x.ts` (trailing dot) reached `allow`, even though Windows opens that
 * path as `src/generated/x.ts`.
 * - Each ordinary (non `.`/`..`) segment has trailing dots and spaces stripped, same
 *   pattern and reason as `TRAILING_DOTS_AND_SPACES`: Windows strips them when it opens
 *   a file, so `generated.` and `generated ` both open `generated`, and the canonical
 *   form used for matching must reflect that, not the caller's literal spelling.
 * - A segment whose basename (the part before any extension) has 8.3 short-name shape
 *   (`genera~1`) canonicalizes the whole path to `null`: an 8.3 alias names some real
 *   long filename, but resolving it requires a filesystem stat, which this lexical
 *   function does not do. Rather than pass the short name through as if it were an
 *   ordinary segment (silently never matching the long-name spec it actually opens),
 *   this refuses to guess -- and the DENY tier (`denyMatchesUncanonicalizablePath` in
 *   engine.ts) already treats `canonicalizePath() === null` as fail-closed for a spec'd
 *   deny rule, so an unresolvable 8.3 alias against a deny spec denies rather than
 *   falling through as "no match, keep looking."
 *
 * Exported so `engine.ts`'s DENY tier can ask, for a spec'd deny rule, whether an incoming
 * path canonicalizes at all -- `null` (or `''`, the workspace-root-itself case) is the
 * signal it uses to fail closed (treat an uncanonicalizable path as denied rather than as
 * "no match, keep looking") instead of duplicating this logic.
 */
export function canonicalizePath(path: string): string | null {
  const normalized = path.replace(/\\/g, '/').toLowerCase()
  if (normalized.startsWith('/') || /^[a-z]:/.test(normalized)) return null

  const stack: string[] = []
  for (const rawSegment of normalized.split('/')) {
    if (rawSegment === '' || rawSegment === '.') continue
    if (rawSegment === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') {
        stack.pop()
      } else {
        // Stack is empty, or already holds a leading run of unresolved `..` -- this
        // segment can't be resolved against anything we've pushed, so it becomes (or
        // extends) that leading `..` run itself.
        stack.push('..')
      }
      continue
    }
    // Windows strips trailing dots and spaces when it opens a file (see
    // TRAILING_DOTS_AND_SPACES in workspace.ts) -- strip the same way here, on this
    // ordinary segment only ('.'/'..' above are navigation tokens, not filenames, and
    // are handled before reaching this point), so the canonical form matches the
    // spelling Windows actually opens.
    const segment = rawSegment.replace(/[. ]+$/, '')
    if (segment === '') continue // stripped down to nothing: treat like an empty segment
    // 8.3 short-name shape in the basename (before any extension) -- see the doc comment
    // above. Can't be resolved lexically, so the whole path is uncanonicalizable.
    const basename = segment.includes('.') ? segment.slice(0, segment.indexOf('.')) : segment
    if (/~\d+/.test(basename)) return null
    stack.push(segment)
  }

  const collapsed = stack.join('/')
  if (collapsed === '..' || collapsed.startsWith('../')) return null
  return collapsed
}

function pathMatches(spec: string, path: string): boolean {
  // A spec that is syntactically non-canonical (`./src/**`, `src/../**`, a leading `/`,
  // a drive prefix, ...) could never match a canonicalized incoming path -- fail closed
  // here, silently. `parseRule` no longer rejects these at parse time (the same spec
  // syntax is shared with command rules, where e.g. `//` legitimately appears in a
  // URL), so this is where the "never matches" consequence for a PATH-keyed rule
  // actually has to be enforced. Loudly reporting this as a likely settings typo is the
  // Task-7 engine's job (via the exported `specHasNonCanonicalSyntax`), not this
  // function's -- this function only needs the match/no-match answer.
  if (specHasNonCanonicalSyntax(spec)) return false
  const canonical = canonicalizePath(path)
  // `null` means "not safely workspace-relative" (see `canonicalizePath`). An empty
  // string means the path collapsed all the way to the workspace root itself (`.`,
  // `./`, `src/..`, or `""`) -- that's a valid canonical form, but it isn't a *file*
  // any glob spec (including a bare `**`) is meant to authorize, so it's treated the
  // same as a failed canonicalization here: no spec'd rule matches it.
  if (canonical === null || canonical === '') return false
  const tokens = tokenizeGlob(collapseDoubleStarRuns(normalizePath(spec)))
  return globMatch(tokens, canonical)
}

/**
 * Does `rule` authorize the call described by `key`? A bare rule (no spec) matches
 * every invocation of the same tool -- or, for an MCP server rule, of every tool that
 * server contributes (see `toolNameMatches`). A spec'd rule matches only when the key
 * carries the kind of data the spec describes: a `command` key is matched by prefix/exact
 * command comparison, a `target` key (a URL, for tools that reach outside the machine) by
 * the same comparison, a `paths` key only if it has at least one path AND every path in it
 * matches the glob (so a move needs both its source and destination covered, and an empty
 * `paths` array fails closed rather than vacuously matching), and a key with none of the
 * three can never satisfy a spec'd rule. When a key carries more than one, the priority is
 * `command`, then `target`, then `paths`, and the first one present wins by design -- the
 * later fields are never consulted in that case.
 */
export function ruleMatches(rule: ParsedRule, key: PermissionKey): boolean {
  if (!toolNameMatches(rule.tool, key.tool)) return false

  const spec = rule.spec
  if (spec === undefined) return true

  if (key.command !== undefined) {
    return commandMatches(spec, key.command)
  }
  if (key.target !== undefined) {
    return targetMatches(spec, key.target)
  }
  if (key.paths !== undefined) {
    return key.paths.length > 0 && key.paths.every((p) => pathMatches(spec, p))
  }
  return false
}

function commandSuggestions(tool: string, command: string): string[] {
  const normalized = normalizeCommand(command)
  const tokens = normalized.split(' ').filter((t) => t.length > 0)
  const suggestions = [`${tool}(${normalized})`]
  if (tokens.length >= 2) {
    // Guarded by the length check above: tokens[0] and tokens[1] are real tokens.
    suggestions.push(`${tool}(${tokens[0]!} ${tokens[1]!}:*)`)
  }
  if (tokens.length >= 1) {
    suggestions.push(`${tool}(${tokens[0]!}:*)`)
  }
  return suggestions
}

/**
 * Most specific first: this exact URL, then everything on this origin.
 *
 * The origin is the suggestion that matters -- it is the decision a person can actually
 * make ("may this agent drive my dev server at localhost:5173") as opposed to one URL at a
 * time, which would train them to approve reflexively. A target that does not parse as a
 * URL yields only the exact rule: guessing at an origin we could not extract would offer a
 * rule that grants more than it appears to.
 */
function targetSuggestions(tool: string, target: string): string[] {
  const suggestions = [`${tool}(${target})`]
  try {
    const origin = new URL(target).origin
    // `origin` is the string "null" for opaque origins (data:, blob:, and — the case that
    // matters here — about:blank), which is not a prefix of anything.
    if (origin !== 'null' && origin !== target) suggestions.push(`${tool}(${origin}:*)`)
  } catch { /* not a URL: the exact rule is the only honest offer */ }
  return suggestions
}

/**
 * `mcp__github__create_issue` -> [that tool, `mcp__github`]. The server rule is what most
 * people want after the first approval, and `toolNameMatches` makes it mean exactly "every
 * tool this server contributes". A name with no second separator is malformed (nothing
 * registers one) and gets only the exact rule rather than a guess.
 */
function mcpSuggestions(tool: string): string[] {
  const cut = tool.indexOf('__', MCP_TOOL_PREFIX.length)
  return cut === -1 ? [tool] : [tool, tool.slice(0, cut)]
}

function singlePathSuggestions(tool: string, path: string): string[] {
  const suggestions = [`${tool}(${path})`]
  const lastSlash = path.lastIndexOf('/')
  if (lastSlash !== -1) {
    const dir = path.slice(0, lastSlash)
    suggestions.push(`${tool}(${dir}/**)`)
  }
  return suggestions
}

// Fallback for a single-path key whose canonical path contains a glob metacharacter
// (`*`/`?`) somewhere. The rule language has no escape syntax for `*`/`?`, so there is
// no way to spell a rule spec that matches that literal path without ALSO matching
// other paths as a glob -- offering the literal-looking `tool(path)` string would be
// actively misleading (it wouldn't mean what it looks like it means). If the metachar
// is confined to the basename and the directory part is itself metachar-free, a
// directory-scoped rule (`tool(dir/**)`) is still a safe, honest suggestion -- it
// authorizes the containing directory, not a widened version of the literal path.
// Otherwise (metachar in the directory part too, or no directory part at all) there is
// no safe shortcut to offer: return `[]` so the approval host falls back to
// allow-once, rather than reaching for the bare `tool` rule (which would authorize
// every path, not just ones near this one) as the old behavior did.
function metacharPathSuggestions(tool: string, path: string): string[] {
  const lastSlash = path.lastIndexOf('/')
  const dir = lastSlash === -1 ? '' : path.slice(0, lastSlash)
  const basename = lastSlash === -1 ? path : path.slice(lastSlash + 1)
  if (/[*?]/.test(basename) && dir !== '' && !/[*?]/.test(dir)) {
    return [`${tool}(${dir}/**)`]
  }
  return []
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)]
}

/**
 * Suggests settings-file rule strings that would authorize `key`, most specific first,
 * deduplicated. Used by the approval UI to offer "always allow" style shortcuts. Every
 * string this function emits is guaranteed to round-trip: `parseRule` accepts it AND
 * `ruleMatches` matches the original `key` against it. That guarantee is what forces the
 * canonicalization step below -- a suggestion built from a raw, non-canonical path would
 * otherwise describe a rule that can never fire (see `specHasNonCanonicalSyntax` and
 * `pathMatches`), silently useless the moment the user accepted it.
 * - command key: exact-normalized, first-two-tokens prefix (only when there are >= 2
 *   tokens), first-token prefix.
 * - single-path key: the path is run through `canonicalizePath` FIRST -- the same
 *   normalization `pathMatches` applies to incoming paths (backslashes to `/`,
 *   lowercased, `.`/`..` segments collapsed). `null` (an absolute path, a drive-prefixed
 *   path, or a net `..` traversal above the workspace root) or `''` (collapses to the
 *   workspace root itself, not a real file) both suggest `[]` -- there is nothing safe
 *   to offer. Otherwise, suggestions are built from the canonical form: `tool(path)`,
 *   plus `tool(dir/**)` when it has a directory part.
 * - single-path key whose canonical path contains a glob metacharacter (`*` or `?`) in
 *   its basename: `tool(dir/**)` if the directory part is non-empty and itself
 *   metachar-free, otherwise `[]` (no shortcut at all -- NOT the bare tool name; see
 *   `metacharPathSuggestions`). A model-proposed path is untrusted input reaching this
 *   function at approval time, so widening to "allow every invocation of this tool" as
 *   a fallback is not acceptable here.
 * - multi-path key (e.g. move) or keyless: just the bare tool name -- a spec covering
 *   every path precisely enough to be useful is not worth guessing at.
 */
export function suggestRules(key: PermissionKey): string[] {
  if (key.command !== undefined) {
    return dedupe(commandSuggestions(key.tool, key.command))
  }
  if (key.target !== undefined) {
    return dedupe(targetSuggestions(key.tool, key.target))
  }
  if (key.tool.startsWith(MCP_TOOL_PREFIX)) {
    return dedupe(mcpSuggestions(key.tool))
  }
  if (key.paths !== undefined && key.paths.length === 1) {
    const canonical = canonicalizePath(key.paths[0]!)
    if (canonical === null || canonical === '') return []
    if (/[*?]/.test(canonical)) return metacharPathSuggestions(key.tool, canonical)
    return dedupe(singlePathSuggestions(key.tool, canonical))
  }
  return [key.tool]
}
