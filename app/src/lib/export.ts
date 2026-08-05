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
  for (const item of items) {
    switch (item.kind) {
      case 'user':
        lines.push('## You', '', item.text, '')
        break
      case 'assistant':
        lines.push('## PrivateCode', '', item.text, '')
        if (item.interrupted) lines.push('*(stopped by you)*', '')
        break
      case 'tool': {
        const outcome = item.result === undefined
          ? 'still running when this was copied'
          : item.result.ok
          ? item.result.preview
          : `failed: ${item.result.preview}`
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
        lines.push(`- verify \`${item.command}\` — ${item.ok ? 'passed' : item.detail}`)
        break
      case 'stopped':
        lines.push('', `*(turn stopped: ${item.reason})*`, '')
        break
      case 'compaction-record':
        if (item.state === 'applied') {
          lines.push('', '*(earlier conversation compacted into a briefing here)*', '')
        }
        break
      // Reasoning, approvals bookkeeping, errors: written for this window, not for a reader
      // elsewhere.
      default:
        break
    }
  }
  // Tool bullets accumulate without a blank line; ensure the document ends cleanly.
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}
