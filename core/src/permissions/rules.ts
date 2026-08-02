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

// Hard cap on `**` occurrences a glob spec may contain (after collapsing adjacent runs,
// see `collapseDoubleStarRuns`). Each `**` compiles (in `globToRegExp` below) to a `.*`
// separated from its neighbors by literal segments; a chain of alternating
// `.*<literal>` groups is the classic catastrophic-backtracking shape -- there are
// exponentially many ways to distribute a non-matching input across the groups, so
// matching cost is exponential in the group count. 8 keeps the worst case (2^8 = 256
// backtracking states) effectively instant; a rule that legitimately needs more `**`
// than that is vanishingly unlikely, so it's rejected at parse time instead, before any
// dangerous regex is ever built.
const MAX_DOUBLE_STAR = 8

// Collapses runs of adjacent `**` segments -- however many, whether directly touching
// (`a/****b`) or `/`-joined (`a/**/**/b`) -- into a single `**`, since they're
// equivalent to it. Applied both before glob translation (so `a/**/**/b` behaves like
// `a/**/b`) and before the `MAX_DOUBLE_STAR` count below (so a redundant run of
// double-stars can't be used to dodge that check by inflating a raw `**` count that
// collapsing would otherwise reduce).
function collapseDoubleStarRuns(glob: string): string {
  let prev: string
  let next = glob
  do {
    prev = next
    next = prev.replace(/\*\*\/?\*\*/g, '**')
  } while (next !== prev)
  return next
}

// Counts `**` occurrences after collapsing adjacent runs -- the number of `.*`-vs-
// literal alternations `globToRegExp` will produce for this glob, and so the quantity
// `MAX_DOUBLE_STAR` bounds.
function countDoubleStars(glob: string): number {
  const collapsed = collapseDoubleStarRuns(glob)
  return collapsed.match(/\*\*/g)?.length ?? 0
}

/**
 * Parses one settings-file rule line. Accepts `tool_name` (matches every invocation)
 * and `tool_name(spec)` (matches per `ruleMatches`, see below). The spec is everything
 * between the first `(` and the LAST `)` in the (trimmed) string -- so a spec may itself
 * contain parentheses -- and nothing may follow that closing paren. Anything that does
 * not fit this shape returns `null` rather than a best-effort partial parse: a typo'd
 * rule must be loud (Task 7 reports nulls as settings problems), not silently inert.
 * This includes an empty string, an unbalanced `(`, an empty spec (`tool()` -- almost
 * certainly a typo, not a deliberate "match nothing"), and a spec with more than
 * `MAX_DOUBLE_STAR` `**` occurrences (the ReDoS bound above).
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
  if (spec === '') return null
  if (countDoubleStars(spec) > MAX_DOUBLE_STAR) return null

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
 * Exported only so tests can exercise the translation directly; callers needing path
 * matching should go through `ruleMatches`.
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
 */
function canonicalizePath(path: string): string | null {
  const normalized = path.replace(/\\/g, '/').toLowerCase()
  if (normalized.startsWith('/') || /^[a-z]:/.test(normalized)) return null

  const stack: string[] = []
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') {
        stack.pop()
      } else {
        // Stack is empty, or already holds a leading run of unresolved `..` -- this
        // segment can't be resolved against anything we've pushed, so it becomes (or
        // extends) that leading `..` run itself.
        stack.push('..')
      }
    } else {
      stack.push(segment)
    }
  }

  const collapsed = stack.join('/')
  if (collapsed === '..' || collapsed.startsWith('../')) return null
  return collapsed
}

function pathMatches(spec: string, path: string): boolean {
  const canonical = canonicalizePath(path)
  if (canonical === null) return false
  return globToRegExp(normalizePath(spec)).test(canonical)
}

/**
 * Does `rule` authorize the call described by `key`? A bare rule (no spec) matches
 * every invocation of the same tool. A spec'd rule matches only when the key carries
 * the kind of data the spec describes: a `command` key is matched by prefix/exact
 * command comparison, a `paths` key is matched only if it has at least one path AND
 * every path in it matches the glob (so a move needs both its source and destination
 * covered, and an empty `paths` array fails closed rather than vacuously matching), and
 * a key with neither `command` nor `paths` can never satisfy a spec'd rule. When a key
 * carries BOTH `command` and `paths`, `command` is checked first and wins by design --
 * `paths` is never consulted in that case.
 */
export function ruleMatches(rule: ParsedRule, key: PermissionKey): boolean {
  if (rule.tool !== key.tool) return false

  const spec = rule.spec
  if (spec === undefined) return true

  if (key.command !== undefined) {
    return commandMatches(spec, key.command)
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

function singlePathSuggestions(tool: string, path: string): string[] {
  const suggestions = [`${tool}(${path})`]
  const lastSlash = path.lastIndexOf('/')
  if (lastSlash !== -1) {
    const dir = path.slice(0, lastSlash)
    suggestions.push(`${tool}(${dir}/**)`)
  }
  return suggestions
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)]
}

/**
 * Suggests settings-file rule strings that would authorize `key`, most specific first,
 * deduplicated. Used by the approval UI to offer "always allow" style shortcuts.
 * - command key: exact-normalized, first-two-tokens prefix (only when there are >= 2
 *   tokens), first-token prefix.
 * - single-path key: `tool(path)`, plus `tool(dir/**)` when the path has a directory
 *   part. Backslashes in the path are normalized to `/` first (rule specs are always
 *   written with forward slashes).
 * - single-path key whose (normalized) path contains a glob metacharacter (`*` or `?`):
 *   just the bare tool name. The rule language has no escape syntax for `*`/`?`, so
 *   there is no way to spell a rule spec that matches that literal path without also
 *   matching other paths as a glob -- offering the literal-looking `tool(path)` string
 *   would be actively misleading.
 * - multi-path key (e.g. move) or keyless: just the bare tool name -- a spec covering
 *   every path precisely enough to be useful is not worth guessing at.
 */
export function suggestRules(key: PermissionKey): string[] {
  if (key.command !== undefined) {
    return dedupe(commandSuggestions(key.tool, key.command))
  }
  if (key.paths !== undefined && key.paths.length === 1) {
    const normalized = key.paths[0]!.replace(/\\/g, '/')
    if (/[*?]/.test(normalized)) return [key.tool]
    return dedupe(singlePathSuggestions(key.tool, normalized))
  }
  return [key.tool]
}
