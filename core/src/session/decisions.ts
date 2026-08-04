import { randomUUID } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ApprovalDecision, ApprovalRequest, InteractionPort, RememberLayer, UserQuestion,
} from '../interaction.js'
import { ensurePrivateDir, PRIVATE_DIR } from '../private-dir.js'

/**
 * What happens to a question nobody is awake to answer.
 *
 * In normal mode an `ask` verdict blocks the turn until someone replies. Overnight nobody
 * does, so the run stops on its first approval — six minutes in, with the model idle and the
 * machine awake for the next eight hours. The existing escape is autopilot, which answers
 * the question by never asking it. This is the third option: the request is **parked**, the
 * agent is told to do something else, and the user answers a night's worth of them at once
 * in the morning.
 *
 * It is queued, **never auto-approved**. Auto-approving is exactly what autopilot is for,
 * and a mode that quietly granted what it could not ask about would be the worst of both —
 * the permissiveness of autopilot with the appearance of asking.
 */

const DECISIONS_FILE = 'decisions.jsonl'

/** How long a request waits for a person before it is parked. Two minutes: long enough
 * that someone who wandered off for coffee still answers it live, short enough that it does
 * not eat a meaningful share of an eight-hour budget. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000

export interface QueuedApproval {
  kind: 'approval'
  id: string
  at: string
  sessionId: string
  tool: string
  summary: string
  detail: string
  suggestedRules: string[]
}

export interface QueuedQuestion {
  kind: 'question'
  id: string
  at: string
  sessionId: string
  question: string
  options: string[]
}

export type QueuedDecision = QueuedApproval | QueuedQuestion

/** Appended when the user answers, never edited in place — the same append-only discipline
 * the transcript and the session store use, for the same reason: a file that is only ever
 * added to cannot be corrupted by a crash halfway through a rewrite. */
export interface DecisionResolution {
  kind: 'resolution'
  id: string
  at: string
  /** For an approval: whether it would have been allowed, and any rule to remember. */
  verdict?: 'allow' | 'deny'
  rule?: { rule: string; layer: RememberLayer }
  /** For a question: what the user would have said. */
  answer?: string
}

type Line = QueuedDecision | DecisionResolution

export class DecisionQueue {
  readonly problems: string[] = []
  private readonly root: string
  private readonly path: string

  constructor(workspaceRoot: string) {
    this.root = workspaceRoot
    this.path = join(workspaceRoot, PRIVATE_DIR, DECISIONS_FILE)
  }

  /** Everything parked and not yet answered, oldest first. */
  pending(): QueuedDecision[] {
    const lines = this.read()
    const resolved = new Set(
      lines.filter((l): l is DecisionResolution => l.kind === 'resolution').map((l) => l.id),
    )
    return lines.filter((l): l is QueuedDecision => l.kind !== 'resolution' && !resolved.has(l.id))
  }

  /** Every entry, answered or not, for a full review. */
  all(): Line[] {
    return this.read()
  }

  add(entry: QueuedDecision): void {
    this.write(entry)
  }

  resolve(resolution: Omit<DecisionResolution, 'kind' | 'at'>): void {
    this.write({ ...resolution, kind: 'resolution', at: new Date().toISOString() })
  }

  private read(): Line[] {
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.note(`the decision queue could not be read (${(e as Error).message})`)
      }
      return []
    }
    const out: Line[] = []
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try {
        out.push(JSON.parse(line) as Line)
      } catch {
        // One corrupt line loses one decision, not the queue. Silent by design: a
        // half-written line is what a crash mid-append looks like, and it is already
        // described by the entry that follows it.
      }
    }
    return out
  }

  private write(line: Line): void {
    try {
      ensurePrivateDir(this.root)
      appendFileSync(this.path, `${JSON.stringify(line)}\n`, 'utf8')
    } catch (e) {
      this.note(`a decision could not be queued (${(e as Error).message})`)
    }
  }

  /** One problem per kind, however many turns hit it: eight hours of failures must not
   * produce eight hours of the same string. */
  private note(text: string): void {
    if (!this.problems.includes(text)) this.problems.push(text)
  }
}

export interface UnattendedOptions {
  queue: DecisionQueue
  sessionId: string
  approvalTimeoutMs?: number
}

/**
 * Wraps an `InteractionPort` so an unanswered request parks instead of blocking forever.
 *
 * A decorator rather than a branch inside the agent loop, because the loop already has
 * exactly one place where a human is consulted and adding "unless nobody is home" to it
 * would put the policy in the wrong layer. Here, the port either answers or it does not,
 * and the loop is unchanged.
 *
 * With no wrapper — the default — behaviour is byte-for-byte what it always was.
 */
export function queueingPort(inner: InteractionPort | undefined, opts: UnattendedOptions): InteractionPort {
  const timeoutMs = opts.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS

  return {
    async requestApproval(req: ApprovalRequest): Promise<ApprovalDecision> {
      const id = randomUUID()
      const parked: ApprovalDecision = {
        verdict: 'defer',
        reason:
          'nobody is available to approve this, so it has been queued for the user to answer ' +
          'later. Do something else that does not depend on it, and do not retry this call.',
      }
      if (!inner) {
        opts.queue.add({ ...toQueuedApproval(id, opts.sessionId, req) })
        return parked
      }
      const answered = await withTimeout(inner.requestApproval(req), timeoutMs)
      if (answered !== TIMED_OUT) return answered
      opts.queue.add({ ...toQueuedApproval(id, opts.sessionId, req) })
      return parked
    },

    async askUser(q: UserQuestion): Promise<string> {
      const id = randomUUID()
      // `ask_user` exists so the model does not guess, so being told to guess is a real
      // trade and is stated as one rather than hidden: the assumption it proceeds on lands
      // in the work log, which is where the morning review looks.
      const parkedAnswer =
        'Nobody is available to answer right now; your question has been recorded for the ' +
        'user. Continue with the most reasonable assumption, and say plainly in your reply ' +
        'which assumption you made.'
      if (!inner) {
        opts.queue.add({ kind: 'question', id, at: new Date().toISOString(), sessionId: opts.sessionId, question: q.question, options: [...q.options] })
        return parkedAnswer
      }
      const answered = await withTimeout(inner.askUser(q), timeoutMs)
      if (answered !== TIMED_OUT) return answered
      opts.queue.add({ kind: 'question', id, at: new Date().toISOString(), sessionId: opts.sessionId, question: q.question, options: [...q.options] })
      return parkedAnswer
    },

    ...(inner?.todosChanged ? { todosChanged: inner.todosChanged.bind(inner) } : {}),
  }
}

function toQueuedApproval(id: string, sessionId: string, req: ApprovalRequest): QueuedApproval {
  return {
    kind: 'approval',
    id,
    at: new Date().toISOString(),
    sessionId,
    tool: req.tool,
    summary: req.summary,
    detail: req.detail,
    suggestedRules: [...req.suggestedRules],
  }
}

const TIMED_OUT = Symbol('timed out')

/**
 * Resolves with the promise's value, or with `TIMED_OUT`.
 *
 * The inner promise is deliberately NOT cancelled: the UI's pending request stays open, so a
 * user who wanders back and clicks Allow ten minutes later still resolves it — the host's own
 * `denyAllPending` is what eventually cleans it up. Cancelling here would leave a card on
 * screen that can never be answered, which is worse than a card that answers a call already
 * moved on from.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      () => { clearTimeout(timer); resolve(TIMED_OUT) },
    )
  })
}
