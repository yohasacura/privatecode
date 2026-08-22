import type { ChatItem } from './state'

/**
 * The conversation as markdown, for taking it somewhere else.
 *
 * What is included follows one rule: what a reader elsewhere could use. The user's asks,
 * the model's answers, and what each tool call DID (name and one-line summary) — not the
 * full tool output, which for a single read can be sixty thousand characters of file
 * content that means nothing outside this workspace, and not the reasoning, which the
 * model wrote to itself.
 */
export function conversationAsMarkdown(items: ChatItem[], title: string): string {
  const lines: string[] = [`# ${title || 'PrivateCode session'}`, '']
  // Structural spacing, never a regex over the finished document: the old
  // `replace(/\n{3,}/g, '\n\n')` rewrote blank runs INSIDE message content too — a Python
  // snippet with the idiomatic two blank lines between defs came out altered, which is
  // the one thing an export must never do to code. `blank()` separates BLOCKS; content is
  // pushed verbatim and stays verbatim.
  const blank = (): void => {
    if (lines[lines.length - 1] !== '') lines.push('')
  }
  for (const item of items) {
    switch (item.kind) {
      case 'user':
        blank()
        // The harness talks in this role too — plan-focus notes, the acceptance fixer's
        // list, a build log, the rewind notice — and `replay.ts` marks which is which for
        // exactly this reason. Ignoring the flag here put three `## You` headings under one
        // message the person sent: an export that says a person asked for something they
        // never asked for is worse than one that is merely incomplete.
        if (item.harness === true) {
          lines.push('*(PrivateCode note)*', '', item.text)
        } else {
          lines.push('## You', '', item.text)
        }
        break
      case 'assistant':
        blank()
        lines.push('## PrivateCode', '', item.text)
        if (item.interrupted) { blank(); lines.push('*(stopped by you)*') }
        break
      case 'tool': {
        const outcome = item.result === undefined
          ? 'still running when this was copied'
          : item.result.ok
          ? item.result.preview
          : `failed: ${item.result.preview}`
        // A list after prose needs its separating blank line; consecutive bullets do not.
        if (!(lines[lines.length - 1] ?? '').startsWith('- ')) blank()
        lines.push(`- \`${item.name}\` — ${outcome}`)
        break
      }
      case 'question-record':
        // The answer without its question reads as 'The user answered: Yes' with no
        // referent — and the answer often shapes everything the model does next, so a
        // reader elsewhere needs both halves or neither.
        lines.push(`- asked: ${JSON.stringify(item.question)} — answered: ${JSON.stringify(item.answer)}`)
        break
      case 'verify-record':
        lines.push(
          `- verify \`${item.command}\`${item.folder !== undefined ? ` in ${item.folder}` : ''} — ` +
          `${item.ok ? 'passed' : item.detail}`,
        )
        break
      case 'stopped':
        blank()
        lines.push(`*(turn stopped: ${item.reason})*`)
        break
      case 'compaction-record':
        if (item.state === 'applied') {
          blank()
          lines.push('*(earlier conversation compacted into a briefing here)*')
        }
        break
      // Reasoning, approvals bookkeeping, errors: written for this window, not for a reader
      // elsewhere.
      default:
        break
    }
  }
  return `${lines.join('\n').trimEnd()}\n`
}
