import type { RememberLayer } from '../interaction.js'
import type { PermissionKey } from '../tools/types.js'
import {
  canonicalizePath,
  MCP_TOOL_PREFIX,
  type ParsedRule,
  parseRule,
  ruleMatches,
  specHasNonCanonicalSyntax,
} from './rules.js'
import {
  addRuleToSettings,
  localSettingsPath,
  projectSettingsPath,
  type SettingsLayer,
  userSettingsPath,
} from './settings.js'

export type AgentMode = 'normal' | 'plan' | 'auto-edit' | 'autopilot'

export interface Decision {
  verdict: 'allow' | 'ask' | 'deny'
  /** Human-and-model-readable one-liner: which rule or mode default decided. */
  reason: string
  /**
   * Which tier of the engine produced this decision: `'builtin'` (the hard-deny table),
   * `'rule'` (a layer's allow/ask/deny list), `'session'` (an `addSessionRule` /
   * `remember(rule, 'session')` grant), or `'mode'` (the mode-default fallback, including
   * the control-op shortcut and the fail-closed unknown-mode branch).
   *
   * The gate in `agent/loop.ts` reads this to keep an "always allow" offer honest: an
   * `ask` verdict whose `source` is `'rule'` came from a rule the user (or settings author)
   * wrote specifically to require asking every single time, and `decide()` consults that
   * ask tier before ever looking at `sessionAllow` -- so offering "always allow" alongside
   * such a decision would be a lie, since a session/layer allow rule can never override an
   * explicit ask rule for the same key. An `ask` verdict from `source: 'mode'` (a mode
   * default, not an explicit rule) carries no such conflict and may still offer one.
   *
   * Additive field: every existing caller of `decide()` that only reads `verdict`/`reason`
   * is unaffected.
   */
  source: 'builtin' | 'rule' | 'session' | 'mode'
}

/** Tools whose grantable act is writing to the workspace. */
export const FILE_WRITE_TOOLS: ReadonlySet<string> = new Set(['edit_file', 'write_file', 'move_file', 'delete_file'])

/** Tools whose grantable act is running something outside the workspace jail. */
export const EXEC_TOOLS: ReadonlySet<string> = new Set(['run_command', 'background_task'])

/**
 * Tools whose grantable act changes state that is neither a workspace file nor a process:
 * a live database.
 *
 * A fourth family for the same reason `isExternalTool` was a third one. `sql_deploy`
 * belongs to none of the others — its key carries an action, not a command or paths — so
 * `modeDefault` fell straight through to its allow tier and `sql_deploy({action:'publish'})`
 * applied schema changes to a live database in normal AND auto-edit mode with no approval
 * card, while the tool's own doc comment claimed it was "gated on every use in every other
 * mode". DESIGN.md §6 records this exact fall-through as the defect that motivated
 * `isExternalTool`; that fix covered MCP and the browser, and `sql_deploy` landed after it.
 *
 * Both actions are gated, `script` included: what a person can sensibly grant standing
 * permission to is a rule they wrote themselves (`sql_deploy(script)`), not a default.
 */
export const DEPLOY_TOOLS: ReadonlySet<string> = new Set(['sql_deploy'])

/** The single browser tool. Named here so the engine does not import the tool module. */
export const BROWSER_TOOL = 'browser'

/** The web search/read tool, same arrangement. Its `search` action carries this fixed
 * target; reads carry the URL. */
export const WEB_TOOL = 'web'
export const WEB_SEARCH_TARGET = 'search'

// Re-exported so every caller has one place to import the MCP namespace from; it is
// declared in rules.ts because `ruleMatches` needs it and the dependency only runs one way.
export { MCP_TOOL_PREFIX }

/**
 * Tools whose grantable act is reaching something outside this machine's filesystem: an
 * MCP server, or a web page.
 *
 * A predicate, not a `Set`, because MCP tool names are not known until a server has been
 * contacted -- a fixed set would have to be mutated at runtime by whatever registers them,
 * and a family whose membership can be edited is not a gate.
 *
 * This is also the fix for the defect `docs/DESIGN.md` §6 recorded when MCP was first cut:
 * `modeDefault` knew two families and auto-allowed everything else, so a tool contributed
 * by a third-party server -- the least trustworthy code in the process -- would have been
 * the only ungated one in it.
 */
export function isExternalTool(name: string): boolean {
  return name === BROWSER_TOOL || name === WEB_TOOL || name.startsWith(MCP_TOOL_PREFIX)
}

/**
 * Tools whose `PermissionKey` carries something a rule spec can match: a command, a target
 * URL, or paths. A spec on anything else can never fire, which is worth telling the user
 * about (see `specProblem`).
 */
function acceptsSpec(tool: string): boolean {
  // An MCP key carries none of the three: `mcp__x__y(anything)` is always a dead rule.
  if (tool.startsWith(MCP_TOOL_PREFIX)) return false
  return FILE_WRITE_TOOLS.has(tool) || EXEC_TOOLS.has(tool) || DEPLOY_TOOLS.has(tool) ||
    tool === BROWSER_TOOL || tool === WEB_TOOL
}

/**
 * Is this tool's spec a workspace path, as opposed to a command line or a URL? Only path
 * specs are subject to `specHasNonCanonicalSyntax`: `//` is a red flag in a path and
 * unremarkable in `run_command(git clone https://...)` or `browser(https://x)`.
 */
function specIsPathShaped(tool: string): boolean {
  return !EXEC_TOOLS.has(tool) && !DEPLOY_TOOLS.has(tool) && !isExternalTool(tool)
}

/**
 * The one problem a rule's spec can earn, or `null` when the spec is fine. Shared by all
 * three places that validate a rule (settings loading, `addSessionRule`, `remember`) so the
 * three can never drift apart -- they did drift once, and the cost was an "always allow"
 * the user believed had taken effect.
 */
function specProblem(parsed: ParsedRule, where: string): string | null {
  if (parsed.spec === undefined) return null
  if (!acceptsSpec(parsed.tool)) {
    return `rule "${parsed.raw}" in ${where} has a (${parsed.spec}) qualifier, but ` +
      `${parsed.tool} calls carry nothing for it to match; the rule can never fire — ` +
      'use the bare tool name'
  }
  if (specIsPathShaped(parsed.tool) && specHasNonCanonicalSyntax(parsed.spec)) {
    return `rule "${parsed.raw}" in ${where} can never match a workspace path ` +
      '(non-canonical syntax); rewrite it without ./ .. // or an absolute prefix'
  }
  return null
}

// Amended by the Task-7 review: the original rm/git patterns missed `rm -rfv`,
// `rm -r -f`, `rm --recursive --force`, `git -C . push`, and `git.exe push`.
// These are deliberately overreaching (deny-side false positives are safe):
// this table is a speed bump against the obvious catastrophes, NOT a security
// boundary — a determined command line can always evade a regex.
const HARD_DENY: { pattern: RegExp; why: string }[] = [
  { pattern: /\brm\b(?=[\s\S]*(\s-\w*r|\s--recursive\b))(?=[\s\S]*(\s-\w*f|\s--force\b))/i,
    why: 'recursive force delete' },
  { pattern: /\bgit(\.exe)?\b[^|;&]*\bpush\b/i, why: 'pushing is the user\'s own action' },
  { pattern: /\bgit(\.exe)?\b[^|;&]*\breset\b[\s\S]*--hard\b/i, why: 'destroys uncommitted work' },
  { pattern: /\b(rmdir|rd)\b[^|;&]*\s\/s\b/i, why: 'recursive directory delete' },
  { pattern: /\bremove-item\b(?=[\s\S]*-recurse)[\s\S]*-force\b|\bremove-item\b(?=[\s\S]*-force)[\s\S]*-recurse\b/i,
    why: 'recursive force delete' },
  { pattern: /\bformat-volume\b|\bformat\s+[a-z]:/i, why: 'formats a volume' },
]

// Trim + collapse internal whitespace runs to a single space -- the same shape of
// normalization `rules.ts` applies before command comparison, kept as a private copy here
// rather than importing `rules.ts`'s (unexported) helper. Does NOT lowercase: this is an
// invariant every entry in `HARD_DENY` depends on -- every pattern there MUST carry the
// `i` flag itself, or a differently-cased command (`RM -RF`, `Git.EXE Push`) would
// silently slip past it.
function normalizeForHardDeny(command: string): string {
  return command.trim().replace(/\s+/g, ' ')
}

function scopeLabel(scope: SettingsLayer['scope']): string {
  return `${scope} settings`
}

// DENY-TIER-ONLY fail-closed check. `ruleMatches` (rules.ts) already refuses to match a
// spec'd path rule against a path that can't be lexically canonicalized (absolute,
// drive-prefixed, a net `..` above the workspace root, or an empty `paths` array) --
// `pathMatches` there just returns `false`, "no match, keep looking." That is the right
// behavior for ASK and ALLOW: a rule that can't resolve a path should not grant anything.
// For DENY it is backwards: treating "can't be evaluated" the same as "doesn't match"
// would let a deny rule be dodged by handing it a path shape the canonicalizer refuses
// (or no path at all) -- exactly the shape of input someone trying to route around a deny
// rule would reach for. So, for a same-tool, spec'd DENY rule only, an empty `paths` array
// or any path that fails to canonicalize is itself treated as a match.
//
// Deliberately does NOT fire for a keyless call (`key.paths === undefined`, e.g. a spec'd
// deny rule against a `background_task` control op, or any tool call whose key carries
// neither `command` nor `paths`): there is no path here to fail to canonicalize, so this
// check stays silent and `decide()` falls through to the ask/allow tiers and mode default
// as before. That is safe to leave unchanged because the workspace jail (`Workspace`, see
// workspace.ts) is the actual backstop against a tool reaching outside the workspace root
// regardless of what this engine decides -- this check only hardens the path-bearing half
// of the deny tier, not a substitute for the jail.
/** `.privatecode/x`, `app/.privatecode/x`, `.PrivateCode\x` -- but not `privatecode.md`
 * or `src/.privatecoded/`. Case-insensitive because NTFS is.
 *
 * The same segment anywhere in a path -- which is also the case where canonicalization
 * gave up (an absolute path, say) and the only honest reading is "this mentions the
 * directory".
 *
 * Anywhere rather than only at the start, because a multi-folder workspace makes the
 * folder name mandatory: `app/.privatecode/settings.json` is the only spelling the model
 * can write there, and the start-anchored test this replaces called that one allowed. */
const ANY_PRIVATE_DIR_SEGMENT = /(^|[\\/])\.privatecode([\\/]|$)/i

/**
 * Denies a model-issued WRITE anywhere under `.privatecode/`. See `decide`'s doc comment
 * for why this is a built-in rather than a rule the user writes.
 *
 * Canonicalization failure denies too, rather than falling through: a path this engine
 * cannot reduce to a comparable form is exactly the shape an escape attempt takes, and
 * the cost of being wrong in that direction is one refused write.
 */
function builtinPrivateDirDeny(key: PermissionKey): Decision | null {
  if (!FILE_WRITE_TOOLS.has(key.tool) || key.paths === undefined) return null
  const hit = key.paths.some((p) => {
    // `canonicalizePath` returns null for an absolute path or one it cannot reduce -- it
    // does not throw. A null is not a pass: an unreducible path is exactly the shape an
    // escape attempt takes, so fall back to looking for the segment ANYWHERE in the raw
    // text. The cost of being wrong in this direction is one refused write.
    const canonical = canonicalizePath(p)
    // ANY segment, not only a leading one. `PRIVATE_DIR_PATH` is start-anchored, and in a
    // multi-folder workspace the folder name is MANDATORY -- so the only spelling the
    // model can even write is `app/.privatecode/settings.json`, which canonicalizes
    // perfectly well and then fails the anchored test. The deny simply did not exist
    // there, and nothing else covers it: `.privatecode` is in no DENIED_SEGMENTS, so the
    // jail lets it through, and the next session loads those `permissions`, `hooks` and
    // `format` rules -- hooks and format commands both run with no permission gate at all.
    if (canonical !== null) return ANY_PRIVATE_DIR_SEGMENT.test(canonical)
    return ANY_PRIVATE_DIR_SEGMENT.test(p)
  })
  if (!hit) return null
  return {
    verdict: 'deny',
    source: 'builtin',
    reason:
      'Blocked by built-in protection: .privatecode/ holds the permission settings, hooks ' +
      'and saved sessions this run is operating under, so nothing here may write to it. ' +
      'Reading is allowed. If a change there is genuinely needed, ask the user to make it.',
  }
}

function denyMatchesUncanonicalizablePath(rule: ParsedRule, key: PermissionKey): boolean {
  if (rule.tool !== key.tool || rule.spec === undefined) return false
  if (key.paths === undefined) return false
  if (key.paths.length === 0) return true
  return key.paths.some((p) => {
    const canonical = canonicalizePath(p)
    return canonical === null || canonical === ''
  })
}

interface ParsedLayer {
  scope: SettingsLayer['scope']
  allow: ParsedRule[]
  ask: ParsedRule[]
  deny: ParsedRule[]
}

export class PermissionEngine {
  mode: AgentMode
  readonly problems: string[]

  private readonly workspaceRoot: string
  private readonly layers: ParsedLayer[]
  private readonly sessionAllow: ParsedRule[] = []

  /**
   * `opts.problems`, if given, is merged in FRONT of whatever this constructor's own rule
   * parsing adds (see `parseRuleList`). Callers MUST pass `loadLayers(root).problems` here
   * (or an equivalent) -- `loadLayers` already detects and reports every way a settings
   * file's JSON can be malformed (bad JSON, wrong-shaped `permissions`, non-array lists,
   * ...), and this constructor has no other way to learn about those; omitting this field
   * silently drops those warnings on the floor even though the engine still degrades safely
   * (a bad layer loads as empty either way).
   */
  constructor(opts: { layers: SettingsLayer[]; mode: AgentMode; workspaceRoot: string; problems?: string[] }) {
    this.mode = opts.mode
    this.workspaceRoot = opts.workspaceRoot
    this.problems = [...(opts.problems ?? [])]
    this.layers = opts.layers.map((layer) => ({
      scope: layer.scope,
      allow: this.parseRuleList(layer.permissions.allow, layer.scope),
      ask: this.parseRuleList(layer.permissions.ask, layer.scope),
      deny: this.parseRuleList(layer.permissions.deny, layer.scope),
    }))
  }

  // Parses every rule string in one named list once, at construction time. A string
  // `parseRule` rejects becomes a problem naming the raw text and where it came from; the
  // rule contributes nothing further (it is simply absent from the returned list, so it
  // can never match anything). A rule that DOES parse but is bound to a path-keyed tool
  // (i.e. not one of `EXEC_TOOLS`) with a non-canonical spec (`./x`, `x/../y`, a leading
  // `/`, a drive prefix, ...) stays in the list -- `pathMatches` in rules.ts already fails
  // it closed, so it is inert, never a security hole -- but is ALSO reported as a problem,
  // because a rule that can never match is almost certainly a typo the user would want to
  // know about. Command-keyed tools are exempt from that second check: a command spec
  // legitimately contains `//` (a URL in `git clone https://...`), so the same syntax that
  // is a red flag for a path rule is unremarkable for a command rule.
  //
  // A rule with a spec bound to a tool that is neither `FILE_WRITE_TOOLS` nor `EXEC_TOOLS`
  // (`read_file(docs/**)`, `git_status(x)`, ...) is a different, stronger case: those tools'
  // `PermissionKey` never carries `command` or `paths` at all (see tools/types.ts), so
  // `ruleMatches` can never match the spec regardless of whether its syntax is canonical --
  // there is no path or command to check it against, full stop. That is reported instead
  // of (not in addition to) the non-canonical-syntax check above, which assumes the spec
  // was at least attempting to describe a path; here the whole notion of a spec is moot for
  // this tool. The rule still stays in the list (inert, matching the non-canonical case).
  private parseRuleList(rules: string[], scope: SettingsLayer['scope']): ParsedRule[] {
    const result: ParsedRule[] = []
    for (const raw of rules) {
      const parsed = parseRule(raw)
      if (parsed === null) {
        this.problems.push(`ignored malformed rule "${raw}" in ${scopeLabel(scope)}`)
        continue
      }
      const problem = specProblem(parsed, scopeLabel(scope))
      if (problem !== null) this.problems.push(problem)
      result.push(parsed)
    }
    return result
  }

  /**
   * A built-in deny tier for paths, alongside the command-only `HARD_DENY` table.
   *
   * `.privatecode/` holds the settings this very session's permission rules were loaded
   * from, plus (once they exist) its hooks and slash-command templates. A model able to
   * write there can grant itself permissions, or plant a command in a hook that runs
   * without ever being offered for approval. That is not a rule the user should have to
   * remember to write, and it is not one any rule should be able to unwrite -- so it sits
   * above the layer loops, exactly like the hard-denied commands.
   *
   * This costs nothing legitimate: the tool's own sessions and logs are written directly
   * by the engine, not through a model-issued tool call, so nothing that should work
   * passes through here. Reading stays allowed -- the model is meant to be able to read
   * back a log it was told about.
   */
  decide(key: PermissionKey): Decision {
    if (key.command !== undefined) {
      const normalized = normalizeForHardDeny(key.command)
      const hard = HARD_DENY.find((h) => h.pattern.test(normalized))
      if (hard) {
        return {
          verdict: 'deny',
          reason: `Blocked by built-in protection (${hard.why}). This cannot be allowed by any rule; ask the user to run it themselves.`,
          source: 'builtin',
        }
      }
    }

    const ownState = builtinPrivateDirDeny(key)
    if (ownState) return ownState

    for (const layer of this.layers) {
      const rule = layer.deny.find((r) => ruleMatches(r, key) || denyMatchesUncanonicalizablePath(r, key))
      if (rule) {
        if (ruleMatches(rule, key)) {
          return { verdict: 'deny', reason: `Denied by rule "${rule.raw}" (${scopeLabel(layer.scope)}).`, source: 'rule' }
        }
        return {
          verdict: 'deny',
          reason: `Denied by rule "${rule.raw}" (${scopeLabel(layer.scope)}) — path could not be resolved to a workspace-relative form, failing closed.`,
          source: 'rule',
        }
      }
    }

    for (const layer of this.layers) {
      const rule = layer.ask.find((r) => ruleMatches(r, key))
      if (rule) {
        return { verdict: 'ask', reason: `Ask required by rule "${rule.raw}" (${scopeLabel(layer.scope)}).`, source: 'rule' }
      }
    }

    const sessionRule = this.sessionAllow.find((r) => ruleMatches(r, key))
    if (sessionRule) {
      return { verdict: 'allow', reason: `Allowed by rule "${sessionRule.raw}" (session).`, source: 'session' }
    }
    for (const layer of this.layers) {
      const rule = layer.allow.find((r) => ruleMatches(r, key))
      if (rule) {
        return { verdict: 'allow', reason: `Allowed by rule "${rule.raw}" (${scopeLabel(layer.scope)}).`, source: 'rule' }
      }
    }

    return this.modeDefault(key)
  }

  private modeDefault(key: PermissionKey): Decision {
    // A keyless EXEC-tool key (background_task poll/stop) carries no command because
    // there is nothing left to gate: starting the process was the approval point. This
    // check runs before the per-mode branching below, and applies in every mode -- an
    // explicit deny/ask/allow rule bound to the bare tool name (e.g. `deny: ["background_task"]`)
    // already caught it earlier in `decide()` if the user wrote one; this is only the
    // fallback once no rule matched at all.
    if (EXEC_TOOLS.has(key.tool) && key.command === undefined) {
      return { verdict: 'allow', reason: 'control operation', source: 'mode' }
    }

    // Searching is free in every working mode — it reaches only the search engine, and
    // per-search approvals would train reflexive clicking, the weakest gate there is.
    // This is the MODE default: an explicit `deny: ["web"]` (or `web(search)`) rule
    // matched earlier in decide() and still kills it. Reads fall through to the
    // external-tool arms below and ask per origin, exactly like the browser.
    // (Plan mode never reaches here for `web` at all: the tool is not read-only, so a
    // plan-mode agent is never offered it.)
    if (key.tool === WEB_TOOL && key.target === WEB_SEARCH_TARGET && this.mode !== 'plan') {
      return { verdict: 'allow', reason: 'web search reaches only the search engine', source: 'mode' }
    }

    switch (this.mode) {
      case 'plan':
        // Fails closed here rather than trusting the Agent's construction-time narrowing.
        //
        // The old comment said "the engine never sees a write tool here, and if it somehow
        // does, the loop's allowedTools refusal fires first". Both halves hold only for an
        // Agent CONSTRUCTED in plan mode, and a mid-turn switch guarantees it was not:
        // `Agent` resolves its mode once, in the constructor (loop.ts), and only then
        // narrows `allowedTools`; `engine.mode` is a mutable field re-read on every
        // decide(). So a turn started in `normal` (allowedTools undefined, loop.ts's
        // refusal inert) that had `setMode('plan')` applied to it mid-flight met an engine
        // that auto-allowed every write and command for the rest of the turn -- clicking
        // the read-only mode made the agent strictly MORE permissive than the one it
        // replaced. That is exactly the desync the constructor's own comment describes
        // having fixed for the construction path, reintroduced at runtime.
        //
        // This arm is inert in correct plan operation: every member of both sets declares
        // `readOnly: false`, so `registry.readOnlyNames()` never offers one to a
        // plan-mode Agent and decide() is never reached for it. It fires only in the
        // desync case, which is precisely when something must.
        if (FILE_WRITE_TOOLS.has(key.tool) || EXEC_TOOLS.has(key.tool) ||
            DEPLOY_TOOLS.has(key.tool) || isExternalTool(key.tool)) {
          return { verdict: 'deny', reason: 'plan mode is read-only', source: 'mode' }
        }
        return { verdict: 'allow', reason: 'plan mode', source: 'mode' }
      case 'autopilot':
        return { verdict: 'allow', reason: 'autopilot mode', source: 'mode' }
      case 'auto-edit':
        if (FILE_WRITE_TOOLS.has(key.tool)) return { verdict: 'allow', reason: 'auto-edit mode', source: 'mode' }
        // Auto-edit auto-approves EDITS. Running a command and reaching a network service
        // are the two things it deliberately still asks about.
        if (EXEC_TOOLS.has(key.tool) || DEPLOY_TOOLS.has(key.tool) || isExternalTool(key.tool)) {
          return { verdict: 'ask', reason: 'auto-edit mode', source: 'mode' }
        }
        return { verdict: 'allow', reason: 'auto-edit mode', source: 'mode' }
      case 'normal':
        if (FILE_WRITE_TOOLS.has(key.tool) || EXEC_TOOLS.has(key.tool) ||
            DEPLOY_TOOLS.has(key.tool) || isExternalTool(key.tool)) {
          return { verdict: 'ask', reason: 'normal mode', source: 'mode' }
        }
        return { verdict: 'allow', reason: 'normal mode', source: 'mode' }
      default:
        // Fail closed on a mode value this switch doesn't recognize -- `AgentMode`'s type
        // rules this out statically, but `mode` is a mutable public field, so a bad value
        // reaching here at runtime (a bug elsewhere, a bad deserialize, ...) must not fall
        // through to `undefined` (which every caller would then have to guard against
        // separately); it asks instead of silently doing nothing or crashing.
        return { verdict: 'ask', reason: 'unknown mode', source: 'mode' }
    }
  }

  /**
   * "always allow" for this session only -- never persisted, gone when the process exits.
   *
   * Validates before storing anything, the same way `remember()` does for a persisted
   * rule: `parseRule` rejecting the string outright, or accepting it but flagging a
   * non-canonical spec on a non-EXEC tool (`specHasNonCanonicalSyntax` -- a rule that can
   * never match a workspace path), both mean this "always allow" would silently do
   * nothing forever. Storing it anyway would be worse than useless here, since the user
   * just approved something on the belief that it took effect -- so neither case is
   * added to `sessionAllow`; both are reported as a problem instead.
   */
  addSessionRule(rule: string): void {
    const parsed = parseRule(rule)
    if (parsed === null) {
      this.problems.push(`ignored malformed rule "${rule}" from an approval`)
      return
    }
    const problem = specProblem(parsed, 'an approval')
    if (problem !== null) {
      this.problems.push(problem)
      return
    }
    this.sessionAllow.push(parsed)
  }

  private pathForLayer(layer: 'user' | 'project' | 'local'): string {
    switch (layer) {
      case 'user':
        return userSettingsPath()
      case 'project':
        return projectSettingsPath(this.workspaceRoot)
      case 'local':
        return localSettingsPath(this.workspaceRoot)
    }
  }

  private addParsedRuleToLayer(scope: SettingsLayer['scope'], parsed: ParsedRule): void {
    const layer = this.layers.find((l) => l.scope === scope)
    if (layer) {
      layer.allow.push(parsed)
    } else {
      this.layers.push({ scope, allow: [parsed], ask: [], deny: [] })
    }
  }

  /**
   * Persist an allow rule to a layer file AND make it effective immediately, so a
   * `decide()` call for the same key right after this one already sees it.
   *
   * `layer === 'session'` never touches disk: it's `addSessionRule` under another name.
   * Otherwise the layer maps to a path via the three path functions plus
   * `workspaceRoot`, the file write happens through `addRuleToSettings`, and -- this is
   * the part that must never regress -- if that write throws (read-only settings
   * directory, disk full, whatever), the user's grant is not lost: it falls back to a
   * session rule instead, so the rest of this run still honors what they just approved,
   * even though it didn't make it to disk.
   */
  remember(rule: string, layer: RememberLayer): void {
    if (layer === 'session') {
      this.addSessionRule(rule)
      return
    }

    const parsed = parseRule(rule)
    if (parsed === null) {
      this.problems.push(`ignored malformed rule "${rule}" from an approval`)
      return
    }
    const problem = specProblem(parsed, 'an approval')
    if (problem !== null) {
      this.problems.push(problem)
      return
    }

    const path = this.pathForLayer(layer)
    try {
      addRuleToSettings(path, 'allow', rule)
    } catch (e) {
      this.problems.push(
        `could not persist rule "${rule}" to ${scopeLabel(layer)}: ${(e as Error).message}; kept for this session only`,
      )
      this.sessionAllow.push(parsed)
      return
    }
    this.addParsedRuleToLayer(layer, parsed)
  }

  /**
   * Make a revoked rule stop mattering NOW, not at the next session build.
   *
   * The other half of `remember`, and it was missing in the dangerous direction: a grant
   * applied to this live engine immediately (see above — "a `decide()` call for the same
   * key right after this one already sees it"), while a revocation edited only the file on
   * disk. The permissions screen then showed the rule as gone while this engine kept
   * auto-allowing on it — verified live: `decide()` answered `Allowed by rule ...` citing
   * a settings file that no longer contained the rule, and would have kept doing so for
   * the whole of an overnight run, since nothing rebuilds the session mid-run.
   *
   * Comparison is by the rule's raw text, trimmed — the same identity `addRuleToSettings`
   * and `removeRuleFromSettings` use for the file, so the screen, the file and this engine
   * agree on what "that rule" means. Removing from `deny`/`ask` lifts a restriction;
   * removing from `allow` withdraws a grant; a rule this engine never held (a file edited
   * by hand after this engine was built) is a no-op, exactly like the file-side remover.
   */
  forget(scope: SettingsLayer['scope'], list: 'allow' | 'ask' | 'deny', rule: string): void {
    const layer = this.layers.find((l) => l.scope === scope)
    if (!layer) return
    const trimmed = rule.trim()
    layer[list] = layer[list].filter((parsed) => parsed.raw.trim() !== trimmed)
  }

  /**
   * Make a rule the user just WROTE start mattering now — `remember`'s generalisation.
   *
   * `remember` covers exactly one shape: an `allow` born from an approval card. The
   * permissions screen now lets the user write a rule into any of the three lists, and a
   * deny typed there that did not bite until the next session build would be the revoke
   * hole again, pointed in the more dangerous direction — a user believes a protection is
   * in place and it is not.
   *
   * Returns the problem instead of pushing it into `this.problems`: the caller is an
   * interactive form, and "your rule is malformed" belongs in front of the person typing
   * it, not in the session's problem strip after the fact. Validation is `remember`'s own,
   * via the same helpers, so the two cannot drift.
   */
  adopt(scope: SettingsLayer['scope'], list: 'allow' | 'ask' | 'deny', rule: string): string | null {
    const parsed = parseRule(rule)
    if (parsed === null) {
      return `"${rule}" is not a valid rule — the shape is tool_name or tool_name(spec)`
    }
    const problem = specProblem(parsed, 'the permissions screen')
    if (problem !== null) return problem

    const layer = this.layers.find((l) => l.scope === scope)
    const trimmed = rule.trim()
    if (layer) {
      if (!layer[list].some((existing) => existing.raw.trim() === trimmed)) layer[list].push(parsed)
    } else {
      this.layers.push({
        scope,
        allow: list === 'allow' ? [parsed] : [],
        ask: list === 'ask' ? [parsed] : [],
        deny: list === 'deny' ? [parsed] : [],
      })
    }
    return null
  }
}
