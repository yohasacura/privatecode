import type { ChatMessage } from '../llama/types.js'

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
 */
export class Transcript {
  private readonly items: ChatMessage[] = []

  append(m: ChatMessage): void {
    this.items.push(Object.freeze({ ...m }))
  }

  messages(): readonly ChatMessage[] {
    return Object.freeze(this.items.slice())
  }

  /** Rough fill gauge for the status line; ~4 characters per token. */
  approxTokens(): number {
    let chars = 0
    for (const m of this.items) {
      chars += (m.content?.length ?? 0) + (m.reasoning_content?.length ?? 0)
      for (const c of m.tool_calls ?? []) chars += c.function.arguments.length + 20
    }
    return Math.ceil(chars / 4)
  }

  toJSONL(): string {
    return this.items.map((m) => JSON.stringify(m)).join('\n')
  }

  static fromJSONL(text: string): Transcript {
    const t = new Transcript()
    for (const line of text.split('\n')) {
      if (line.trim()) t.append(JSON.parse(line) as ChatMessage)
    }
    return t
  }
}
