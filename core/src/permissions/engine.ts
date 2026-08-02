import type { RememberLayer } from '../interaction.js'
import type { PermissionKey } from '../tools/types.js'
import { type ParsedRule, parseRule, ruleMatches, specHasNonCanonicalSyntax } from './rules.js'
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
}

/** Tools whose grantable act is writing to the workspace. */
export const FILE_WRITE_TOOLS: ReadonlySet<string> = new Set(['edit_file', 'write_file', 'move_file', 'delete_file'])

/** Tools whose grantable act is running something outside the workspace jail. */
export const EXEC_TOOLS: ReadonlySet<string> = new Set(['run_command', 'background_task'])

/**
 * Matched against the normalized command of any `command` key. NOT overridable by any
 * layer, any mode, or any user approval -- these exist because "the model asked and the
 * user clicked allow" is not a sufficient safeguard against a single irreversible action,
 * and the decision reason says so explicitly so the model (and the user, reading the
 * transcript) understands this isn't a rule that can be worked around by rephrasing.
 *
 * Deliberately pattern-based, not parse-based: `/\bgit\s+push\b/i` matches `git push`
 * wherever it appears in the command line, including inside `echo git push` -- a false
 * positive on a harmless command. That overreach is accepted on purpose. A hard deny that
 * tried to be precise (e.g. only matching `git push` as the whole command, or only when
 * it's the first word) would also have to correctly parse shell quoting, `&&` chains, and
 * subshells to stay safe, and a parser subtle enough to have a gap is worse than a blunt
 * substring match that never has one: the failure direction that matters here is "denied
 * something safe" (mildly annoying, ask the user to run it), not "allowed something
 * destructive" (unrecoverable).
 */
const HARD_DENY: { pattern: RegExp; why: string }[] = [
  { pattern: /\brm\s+(-\w*r\w*f|-\w*f\w*r)\b/i, why: 'recursive force delete' },
  { pattern: /\bgit\s+push\b/i, why: "pushing is the user's own action" },
  { pattern: /\bgit\s+reset\s+--hard\b/i, why: 'destroys uncommitted work' },
  { pattern: /\b(rmdir|rd)\s+\/s\b/i, why: 'recursive directory delete' },
  { pattern: /\bremove-item\b(?=[\s\S]*-recurse)[\s\S]*-force\b/i, why: 'recursive force delete' },
  { pattern: /\bformat-volume\b|\bformat\s+[a-z]:/i, why: 'formats a volume' },
]

// Trim + collapse internal whitespace runs to a single space -- the same shape of
// normalization `rules.ts` applies before command comparison, kept as a private copy here
// rather than importing `rules.ts`'s (unexported) helper. Case is left alone: every
// `HARD_DENY` pattern already carries the `i` flag.
function normalizeForHardDeny(command: string): string {
  return command.trim().replace(/\s+/g, ' ')
}

function scopeLabel(scope: SettingsLayer['scope']): string {
  return `${scope} settings`
}

interface ParsedLayer {
  scope: SettingsLayer['scope']
  allow: ParsedRule[]
  ask: ParsedRule[]
  deny: ParsedRule[]
}

export class PermissionEngine {
  mode: AgentMode
  readonly problems: string[] = []

  private readonly workspaceRoot: string
  private readonly layers: ParsedLayer[]
  private readonly sessionAllow: ParsedRule[] = []

  constructor(opts: { layers: SettingsLayer[]; mode: AgentMode; workspaceRoot: string }) {
    this.mode = opts.mode
    this.workspaceRoot = opts.workspaceRoot
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
  private parseRuleList(rules: string[], scope: SettingsLayer['scope']): ParsedRule[] {
    const result: ParsedRule[] = []
    for (const raw of rules) {
      const parsed = parseRule(raw)
      if (parsed === null) {
        this.problems.push(`ignored malformed rule "${raw}" in ${scopeLabel(scope)}`)
        continue
      }
      if (!EXEC_TOOLS.has(parsed.tool) && parsed.spec !== undefined && specHasNonCanonicalSyntax(parsed.spec)) {
        this.problems.push(
          `rule "${parsed.raw}" in ${scopeLabel(scope)} can never match a workspace path (non-canonical syntax); rewrite it without ./ .. // or an absolute prefix`,
        )
      }
      result.push(parsed)
    }
    return result
  }

  decide(key: PermissionKey): Decision {
    if (key.command !== undefined) {
      const command = key.command
      const hard = HARD_DENY.find((h) => h.pattern.test(normalizeForHardDeny(command)))
      if (hard) {
        return {
          verdict: 'deny',
          reason: `Blocked by built-in protection (${hard.why}). This cannot be allowed by any rule; ask the user to run it themselves.`,
        }
      }
    }

    for (const layer of this.layers) {
      const rule = layer.deny.find((r) => ruleMatches(r, key))
      if (rule) {
        return { verdict: 'deny', reason: `Denied by rule "${rule.raw}" (${scopeLabel(layer.scope)}).` }
      }
    }

    for (const layer of this.layers) {
      const rule = layer.ask.find((r) => ruleMatches(r, key))
      if (rule) {
        return { verdict: 'ask', reason: `Ask required by rule "${rule.raw}" (${scopeLabel(layer.scope)}).` }
      }
    }

    const sessionRule = this.sessionAllow.find((r) => ruleMatches(r, key))
    if (sessionRule) {
      return { verdict: 'allow', reason: `Allowed by rule "${sessionRule.raw}" (session).` }
    }
    for (const layer of this.layers) {
      const rule = layer.allow.find((r) => ruleMatches(r, key))
      if (rule) {
        return { verdict: 'allow', reason: `Allowed by rule "${rule.raw}" (${scopeLabel(layer.scope)}).` }
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
      return { verdict: 'allow', reason: 'control operation' }
    }

    switch (this.mode) {
      case 'plan':
        // Agent already restricts the offered tools to read-only in plan mode; the engine
        // never sees a write tool here, and if it somehow does, the loop's allowedTools
        // refusal fires first.
        return { verdict: 'allow', reason: 'plan mode' }
      case 'autopilot':
        return { verdict: 'allow', reason: 'autopilot mode' }
      case 'auto-edit':
        if (FILE_WRITE_TOOLS.has(key.tool)) return { verdict: 'allow', reason: 'auto-edit mode' }
        if (EXEC_TOOLS.has(key.tool)) return { verdict: 'ask', reason: 'auto-edit mode' }
        return { verdict: 'allow', reason: 'auto-edit mode' }
      case 'normal':
        if (FILE_WRITE_TOOLS.has(key.tool) || EXEC_TOOLS.has(key.tool)) {
          return { verdict: 'ask', reason: 'normal mode' }
        }
        return { verdict: 'allow', reason: 'normal mode' }
    }
  }

  /** "always allow" for this session only -- never persisted, gone when the process exits. */
  addSessionRule(rule: string): void {
    const parsed = parseRule(rule)
    if (parsed === null) {
      this.problems.push(`ignored malformed rule "${rule}" in session settings`)
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
      this.problems.push(`ignored malformed rule "${rule}" in ${scopeLabel(layer)}`)
      return
    }

    const path = this.pathForLayer(layer)
    try {
      addRuleToSettings(path, 'allow', rule)
      this.addParsedRuleToLayer(layer, parsed)
    } catch {
      this.sessionAllow.push(parsed)
    }
  }
}
