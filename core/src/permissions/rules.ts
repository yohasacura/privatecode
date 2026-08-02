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
 * Parses one settings-file rule line. Accepts `tool_name` (matches every invocation)
 * and `tool_name(spec)` (matches per `ruleMatches`, see below). The spec is everything
 * between the first `(` and the LAST `)` in the (trimmed) string -- so a spec may itself
 * contain parentheses -- and nothing may follow that closing paren. Anything that does
 * not fit this shape, including an empty string or an unbalanced `(`, returns `null`
 * rather than a best-effort partial parse: a typo'd rule must be loud (Task 7 reports
 * nulls as settings problems), not silently inert.
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
  return { tool: name, spec, raw }
}

// Normalizes a command line for prefix/exact comparison: trims outer whitespace,
// collapses internal whitespace runs to a single space, and lowercases. Because this
// strips whitespace and case variance, a rule cannot distinguish a command that
// literally ends in the two characters ':*' from a prefix-rule spec ending in ':*' --
// a command whose real, literal suffix is ':*' can never be pinned with an exact-match
// rule, since the parser always reads a trailing ':*' as "this is a prefix rule".
function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ').toLowerCase()
}

function commandMatches(spec: string, command: string): boolean {
  const normCmd = normalizeCommand(command)
  if (spec.endsWith(':*')) {
    const prefix = normalizeCommand(spec.slice(0, -2))
    // Prefix boundary: exact equality, or followed by a space -- "git st:*" must not
    // match "git status" (no boundary between "st" and "atus").
    return normCmd === prefix || normCmd.startsWith(prefix + ' ')
  }
  return normCmd === normalizeCommand(spec)
}

// Placeholder used to protect `**` while the surrounding text goes through the
// single-`*` replacement below. Using a literal space is deliberate and matches the
// exact glob->regex recipe this module implements: replacing `**` in two single-`*`
// passes would turn it into `[^/]*[^/]*`, which (unlike `**`) still cannot cross a `/`.
const DOUBLE_STAR_PLACEHOLDER = ' '

/**
 * Translates a glob (as used in path-rule specs) into an anchored, case-insensitive
 * RegExp. `*` matches within one path segment, `?` matches exactly one character
 * (also confined to a segment), and `**` matches across segments including zero
 * segments. Exported only so tests can exercise the translation directly; callers
 * needing path matching should go through `ruleMatches`.
 */
export function globToRegExp(glob: string): RegExp {
  // Escape every regex metacharacter except * and ?, which the glob syntax repurposes.
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const doubleStarred = escaped.replace(/\*\*/g, DOUBLE_STAR_PLACEHOLDER)
  const starred = doubleStarred.replace(/\*/g, '[^/]*')
  const questioned = starred.replace(/\?/g, '[^/]')
  const pattern = questioned.split(DOUBLE_STAR_PLACEHOLDER).join('.*')
  return new RegExp(`^${pattern}$`, 'i')
}

// Backslashes come from Windows-style paths; specs are always written with forward
// slashes, but incoming paths (e.g. from tool args) may use either.
function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase()
}

function pathMatches(spec: string, path: string): boolean {
  return globToRegExp(normalizePath(spec)).test(normalizePath(path))
}

/**
 * Does `rule` authorize the call described by `key`? A bare rule (no spec) matches
 * every invocation of the same tool. A spec'd rule matches only when the key carries
 * the kind of data the spec describes: a `command` key is matched by prefix/exact
 * command comparison, a `paths` key is matched only if EVERY path in the key matches
 * the glob (so a move needs both its source and destination covered), and a key with
 * neither `command` nor `paths` can never satisfy a spec'd rule.
 */
export function ruleMatches(rule: ParsedRule, key: PermissionKey): boolean {
  if (rule.tool !== key.tool) return false

  const spec = rule.spec
  if (spec === undefined) return true

  if (key.command !== undefined) {
    return commandMatches(spec, key.command)
  }
  if (key.paths !== undefined) {
    return key.paths.every((p) => pathMatches(spec, p))
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
 *   part.
 * - multi-path key (e.g. move) or keyless: just the bare tool name -- a spec covering
 *   every path precisely enough to be useful is not worth guessing at.
 */
export function suggestRules(key: PermissionKey): string[] {
  if (key.command !== undefined) {
    return dedupe(commandSuggestions(key.tool, key.command))
  }
  if (key.paths !== undefined && key.paths.length === 1) {
    return dedupe(singlePathSuggestions(key.tool, key.paths[0]!))
  }
  return [key.tool]
}
