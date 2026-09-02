import type { ChatMessage } from '../llama/types.js'

/**
 * Every character of a message that the chat template renders into the prompt.
 *
 * Exported because four places need this number and each used to compute it inline — and
 * three of them agreed while the fourth quietly did not. `tool_calls[].function.arguments`
 * is the part that gets forgotten: a `Write` message carries `content: null` and the
 * whole file in its arguments, so a counter that reads only `content` scores the largest
 * append a step can make as zero. Ground truth from the server: 956 prompt tokens for a
 * 3,832-char argument, which is the usual chars/4 — those bytes are prefilled like any
 * other.
 *
 * The `+ 20` per call is the id, name and JSON scaffolding the template wraps around each
 * one. It is an estimate; the arguments are not.
 */
export function messageChars(m: ChatMessage): number {
  let chars = (m.content?.length ?? 0) + (m.reasoning_content?.length ?? 0)
  for (const c of m.tool_calls ?? []) chars += c.function.arguments.length + 20
  return chars
}

/** `messageChars` over a run of messages. */
export function transcriptChars(messages: readonly ChatMessage[]): number {
  let chars = 0
  for (const m of messages) chars += messageChars(m)
  return chars
}

/**
 * Deep-freezes an object graph in place. Recurses into every own enumerable
 * property (arrays included, since array indices are own enumerable
 * properties too), so nothing reachable from `value` stays mutable.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value
}

/**
 * The conversation, append-only by construction.
 *
 * Qwen3.6 has 30 recurrent Gated DeltaNet blocks out of 41, so llama.cpp can only reuse
 * a longest common prefix — a recurrent state cannot be rewound. Editing anything but
 * the tail forces a full re-prefill of everything after the edit. Measured on a
 * ~14.9k-token history: appending 0.5 s, changing one early word 27.7 s (56.5x).
 *
 * Therefore: no splice, no shift, no in-place edit. Context is saved by being frugal at
 * append time, never by cleaning up later.
 *
 * append() severs shared references with the caller's object (via structuredClone) and
 * deep-freezes the stored entry, so nothing reachable from stored history — however
 * deeply nested — can be mutated by the caller's own object or by a reader of messages().
 */
export class Transcript {
  private readonly items: ChatMessage[] = []

  append(m: ChatMessage): void {
    // structuredClone severs every shared reference with the caller's object
    // (arrays, nested tool_calls, etc.); deepFreeze then locks the clone down
    // all the way to its leaves so no one — caller or reader — can mutate it.
    this.items.push(deepFreeze(structuredClone(m)))
  }

  messages(): readonly ChatMessage[] {
    // Elements are already deep-frozen at append time, so a shallow copy of
    // the array (also frozen) is sufficient for full, all-the-way-down immutability.
    return Object.freeze(this.items.slice())
  }

  /** Rough fill gauge for the status line; ~4 characters per token. */
  approxTokens(): number {
    return Math.ceil(transcriptChars(this.items) / 4)
  }

  toJSONL(): string {
    return this.items.map((m) => JSON.stringify(m)).join('\n')
  }

  /**
   * Parses one message per line. A line that fails to parse throws immediately, naming
   * its 1-based line number, rather than silently dropping a corrupt entry or letting a
   * raw SyntaxError (with no indication of *where*) escape to the caller.
   *
   * `lineOffset` (default 0) is for a caller -- `SessionStore.load`, after slicing off
   * everything up to the last compaction marker -- whose `text` is not the whole file:
   * without it, a corrupt line would be reported by its position within the SLICE, which
   * silently disagrees with the line a human opening the actual `.jsonl` file would count
   * to. When non-zero, the message gains a `(file line N)` suffix naming the true file
   * line (`lineOffset` + the slice-local 1-based line number); the slice-local number
   * alone stays first so existing callers/output shape are unchanged when `lineOffset`
   * is its default 0.
   */
  static fromJSONL(text: string, lineOffset = 0): Transcript {
    const t = new Transcript()
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (!line.trim()) continue
      try {
        t.append(JSON.parse(line) as ChatMessage)
      } catch (e) {
        const localLine = i + 1
        const fileNote = lineOffset > 0 ? ` (file line ${localLine + lineOffset})` : ''
        throw new Error(
          `corrupt transcript at line ${localLine}${fileNote}: ` +
          `${e instanceof Error ? e.message : String(e)}`,
        )
      }
    }
    return t
  }

  /** Number of messages currently stored; the persistence layer's cursor into what has
   * already been written to disk is a slice starting at this count. */
  count(): number {
    return this.items.length
  }
}
