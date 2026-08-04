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
}

export interface TodoItem {
  text: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** The host side of every human interaction. A pending call costs zero tokens. */
export interface InteractionPort {
  requestApproval(req: ApprovalRequest): Promise<ApprovalDecision>
  askUser(q: UserQuestion): Promise<string>
  todosChanged?(todos: readonly TodoItem[]): void
}

export class TodoStore {
  private items: readonly TodoItem[] = []
  set(items: TodoItem[]): void { this.items = Object.freeze(items.map((i) => ({ ...i }))) }
  list(): readonly TodoItem[] { return this.items }
}
