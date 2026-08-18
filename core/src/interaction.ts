import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { ensureStateDir, statePath } from './private-dir.js'

/** The plan on disk. JSON, not markdown: the app renders it, nobody hand-edits it. */
const PLAN_FILE = 'plan.json'
/** How a change is presented to the user before approval. */
export interface ApprovalRequest {
  tool: string
  summary: string
  detail: string
  /** Rules the user can pick from for "always allow". Most specific first. */
  suggestedRules: string[]
}

export type RememberLayer = 'session' | 'local' | 'project' | 'user'

export type ApprovalDecision =
  | { verdict: 'allow'; remember?: { rule: string; layer: RememberLayer } }
  | { verdict: 'deny'; comment?: string }
  /**
   * Nobody was there to decide, so the request was parked for later.
   *
   * Distinct from `deny` because the difference matters to the model: a denial is a person
   * saying no, and the right response is to take their reasoning into account and find
   * another way. A deferral is a person being asleep, and the right response is to leave
   * this line of work alone and pick up another. Reporting one as the other would have the
   * agent apologising to nobody and reasoning about an objection that was never made.
   */
  | { verdict: 'defer'; reason: string }

export interface UserQuestion {
  question: string
  /** 2–4 options. The host always also accepts free text. */
  options: string[]
  /** True when the options are not mutually exclusive and several may be picked together.
   * The answer is still one string — selections joined with "; " — so nothing downstream
   * of `askUser` changes shape. Absent means single choice, which every question that
   * predates the flag already was. */
  multiSelect?: boolean
}

export interface TodoItem {
  text: string
  status: 'pending' | 'in_progress' | 'completed'
  /**
   * How this step will be known to be done — a command that must pass, a file that must
   * exist, an observable fact.
   *
   * Optional so nothing that predates it breaks, and asked for by the tool because on a
   * long task "done" decided by feel is how a plan drifts: a step gets marked completed
   * because the model believes it is, and three steps later nothing works and there is no
   * record of what was actually checked.
   */
  done_when?: string
}

/** The host side of every human interaction. A pending call costs zero tokens. */
export interface InteractionPort {
  requestApproval(req: ApprovalRequest): Promise<ApprovalDecision>
  askUser(q: UserQuestion): Promise<string>
  todosChanged?(todos: readonly TodoItem[]): void
}

/**
 * The plan, and it outlives the conversation carrying it.
 *
 * In memory it always survived compaction — it is not in the transcript. On disk it also
 * survives a resumed session, an app restart and a crash, which is what a multi-day task
 * actually needs. Written under `state/`: the app renders it, so the file is a durability
 * mechanism rather than something to read by hand.
 *
 * Persistence is best-effort in both directions. A plan that could not be saved is still a
 * plan for this session, and a workspace whose file is corrupt starts with an empty one —
 * refusing to run because a convenience file is malformed would be the wrong trade.
 */
export class TodoStore {
  private items: readonly TodoItem[] = []
  /** Absent for a store with no workspace — the CLI's one-shot mode and every test that
   * does not care. Then this behaves exactly as it did before it could persist at all. */
  private readonly root: string | undefined

  constructor(workspaceRoot?: string) {
    this.root = workspaceRoot
    if (workspaceRoot === undefined) return
    const path = statePath(workspaceRoot, PLAN_FILE)
    if (!existsSync(path)) return
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (Array.isArray(parsed)) this.items = Object.freeze(parsed as TodoItem[])
    } catch { /* an unreadable plan is an empty plan, not a broken session */ }
  }

  set(items: TodoItem[]): void {
    this.items = Object.freeze(items.map((i) => ({ ...i })))
    if (this.root === undefined) return
    try {
      ensureStateDir(this.root)
      writeFileSync(statePath(this.root, PLAN_FILE), JSON.stringify(this.items, null, 2), 'utf8')
    } catch { /* the in-memory plan is what this session runs on */ }
  }

  list(): readonly TodoItem[] { return this.items }
}
