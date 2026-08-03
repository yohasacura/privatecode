import * as vscode from 'vscode'
import { serverUrl, type AgentBridge } from './bridge.js'

/**
 * One chat turn: drives the agent and maps its protocol events onto the chat view.
 *
 * Mapping choices, all made against the STABLE chat API (a proposed "thinking part" would
 * force `--enable-proposed-api` and could not be installed normally):
 * - reasoning streams VISIBLY, as a blockquote, and stops the moment the answer starts.
 *   The user's first complaint about the old UI was "I cannot see what the model is
 *   thinking", and a token counter is not that.
 * - tool calls become `progress` lines, which is what that part is for: VS Code renders
 *   them as a checked-off activity list rather than chat prose.
 * - approvals are native modal dialogs; file edits get the native diff in task 3.
 */

interface TurnDeps {
  bridge: AgentBridge
  stream: vscode.ChatResponseStream
  token: vscode.CancellationToken
  workspaceRoot: string
}

/** Compact one-line description of a tool call for the activity list. */
function describeToolCall(name: string, argsJson: string): string {
  let path: string | undefined
  let command: string | undefined
  try {
    const args = JSON.parse(argsJson) as Record<string, unknown>
    if (typeof args['path'] === 'string') path = args['path']
    if (typeof args['from'] === 'string' && typeof args['to'] === 'string') {
      path = `${args['from']} → ${args['to']}`
    }
    if (typeof args['command'] === 'string') command = args['command']
    if (typeof args['pattern'] === 'string' && path === undefined) path = args['pattern']
    if (typeof args['query'] === 'string' && path === undefined) path = args['query']
  } catch { /* a malformed args string is still worth announcing by tool name alone */ }
  const detail = command ?? path
  return detail ? `${name} · ${detail}` : name
}

export async function runTurn(prompt: string, deps: TurnDeps): Promise<void> {
  const { bridge, stream, token, workspaceRoot } = deps

  // Reasoning is rendered as a blockquote; `> ` has to be re-emitted after every newline
  // for the block to stay one quote in markdown.
  let quoting = false
  let answering = false

  const cancel = token.onCancellationRequested(() => {
    void bridge.call('abort', {}).catch(() => { /* the turn result is the real signal */ })
  })

  bridge.listen((event) => {
    const data = event.data as Record<string, any>
    switch (event.event) {
      case 'thinking.delta': {
        if (answering) return
        const text = String(data['text'] ?? '')
        if (!quoting) {
          stream.markdown('\n> *thinking*\n>\n> ')
          quoting = true
        }
        stream.markdown(text.replace(/\n/g, '\n> '))
        return
      }
      case 'text.delta': {
        if (!answering) {
          answering = true
          if (quoting) { stream.markdown('\n\n'); quoting = false }
        }
        stream.markdown(String(data['text'] ?? ''))
        return
      }
      case 'assistant.text': {
        // Only fires with content when nothing streamed for this step (the loop's own
        // non-streaming fallback); appending it after deltas would duplicate the answer.
        if (answering) return
        const text = String(data['text'] ?? '')
        if (text.trim() === '') return
        if (quoting) { stream.markdown('\n\n'); quoting = false }
        stream.markdown(text)
        return
      }
      case 'tool.call': {
        if (quoting) { stream.markdown('\n\n'); quoting = false }
        // A new step's reasoning starts a fresh quote after a tool round-trip.
        answering = false
        stream.progress(describeToolCall(String(data['name']), String(data['args'] ?? '{}')))
        return
      }
      case 'tool.result': {
        if (data['ok'] === false) {
          stream.markdown(`\n\n⚠️ \`${String(data['name'])}\`: ${String(data['content']).split('\n')[0]}\n\n`)
        }
        return
      }
      case 'todos': {
        const items = (data['items'] ?? []) as { text: string; status: string }[]
        if (items.length === 0) return
        const marks: Record<string, string> = { pending: '- [ ]', in_progress: '- [ ] ▸', completed: '- [x]' }
        stream.markdown(`\n\n${items.map((t) => `${marks[t.status] ?? '- [ ]'} ${t.text}`).join('\n')}\n\n`)
        return
      }
      case 'compaction': {
        if (data['state'] === 'applied') {
          stream.progress(`context compacted (${String(data['droppedMessages'] ?? '?')} earlier messages summarised)`)
        }
        return
      }
      case 'settings.problem': {
        stream.markdown(`\n\n> ⚠️ ${String(data['text'])}\n\n`)
        return
      }
      case 'approval.request': {
        void handleApproval(bridge, data)
        return
      }
      case 'question.request': {
        void handleQuestion(bridge, data)
        return
      }
      default:
        return
    }
  })

  try {
    await bridge.ensureSession(workspaceRoot, serverUrl())
    const result = await bridge.call('send', { text: prompt })
    const turn = result?.turn as { stoppedBecause?: string; steps?: number } | undefined
    if (turn && turn.stoppedBecause !== 'done') {
      const why: Record<string, string> = {
        aborted: 'Stopped — you interrupted this turn. What arrived is kept; ask again to continue.',
        timeout: 'Stopped — a step passed its time limit.',
        truncated: 'Stopped — the model ran out of room to think twice in a row.',
        max_steps: 'Stopped — the step limit was reached before the task finished.',
      }
      stream.markdown(`\n\n_${why[turn.stoppedBecause ?? ''] ?? `Stopped: ${turn.stoppedBecause}`}_`)
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    stream.markdown(`\n\n**Could not complete the turn.** ${message}\n\n` +
      'Check that the llama.cpp server is running and that `privatecode.serverUrl` points at it.')
  } finally {
    cancel.dispose()
    bridge.listen(null)
  }
}

/**
 * Native approval. A modal keeps the decision in front of the user instead of a card they
 * can scroll past -- the turn is paused on the model side while this is open, which costs
 * nothing (the KV cache just sits there), so there is no hurry to answer.
 */
async function handleApproval(bridge: AgentBridge, data: Record<string, any>): Promise<void> {
  const requestId = String(data['requestId'])
  const tool = String(data['tool'])
  const summary = String(data['summary'])
  const detail = String(data['detail'] ?? '')
  const suggested = (data['suggestedRules'] ?? []) as string[]

  const ALLOW = 'Allow'
  const ALWAYS = 'Always allow…'
  const DENY = 'Deny…'
  const buttons = suggested.length > 0 ? [ALLOW, ALWAYS, DENY] : [ALLOW, DENY]

  const picked = await vscode.window.showWarningMessage(
    `PrivateCode wants to run ${tool}: ${summary}`,
    { modal: true, detail: detail.slice(0, 1500) },
    ...buttons,
  )

  if (picked === ALLOW) {
    await bridge.call('approval.reply', { requestId, decision: { verdict: 'allow' } })
    return
  }
  if (picked === ALWAYS) {
    const rule = await vscode.window.showQuickPick(suggested, {
      title: 'Always allow which pattern?',
      placeHolder: 'the rule is stored in your permission settings',
    })
    if (!rule) {
      await bridge.call('approval.reply', { requestId, decision: { verdict: 'allow' } })
      return
    }
    const layer = await vscode.window.showQuickPick(
      [
        { label: 'This session only', value: 'session' },
        { label: 'This project (local)', value: 'local' },
        { label: 'This project (shared)', value: 'project' },
        { label: 'All my projects', value: 'user' },
      ],
      { title: `Remember "${rule}" where?` },
    )
    await bridge.call('approval.reply', {
      requestId,
      decision: layer
        ? { verdict: 'allow', remember: { rule, layer: layer.value } }
        : { verdict: 'allow' },
    })
    return
  }

  // Deny (including dismissing the modal, which is a refusal, not consent).
  const comment = await vscode.window.showInputBox({
    title: 'Tell the model what to do instead',
    placeHolder: 'optional — e.g. "edit the existing file instead of creating a new one"',
  })
  await bridge.call('approval.reply', {
    requestId,
    decision: comment ? { verdict: 'deny', comment } : { verdict: 'deny' },
  })
}

async function handleQuestion(bridge: AgentBridge, data: Record<string, any>): Promise<void> {
  const requestId = String(data['requestId'])
  const question = String(data['question'])
  const options = (data['options'] ?? []) as string[]

  const picked = await vscode.window.showQuickPick(
    [...options.map((o) => ({ label: o })), { label: '$(edit) Type my own answer…' }],
    { title: question, ignoreFocusOut: true },
  )
  let answer = picked?.label ?? ''
  if (!picked || picked.label.startsWith('$(edit)')) {
    answer = (await vscode.window.showInputBox({ title: question, ignoreFocusOut: true })) ?? ''
  }
  await bridge.call('question.reply', { requestId, answer })
}
