import * as vscode from 'vscode'

/**
 * PrivateCode as a VS Code extension.
 *
 * Task 1 is deliberately narrow: prove the chat participant is REACHABLE in this VS Code
 * build before any agent wiring exists. The whole plan rests on the chat view accepting a
 * third-party participant here; if it does not, the fallback (a sidebar webview) changes
 * every later task, so this is checked by installing and looking, not assumed.
 *
 * `onStartupFinished` activation plus the self-report below exists for exactly that check:
 * a participant that fails to register must say so loudly rather than being silently
 * absent from an `@`-completion list nobody thought to open.
 */

export function activate(context: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel('PrivateCode')
  context.subscriptions.push(out)

  const hasChatApi = typeof (vscode as unknown as { chat?: { createChatParticipant?: unknown } })
    .chat?.createChatParticipant === 'function'
  out.appendLine(`PrivateCode activating. vscode.chat.createChatParticipant available: ${hasChatApi}`)

  let registered = false
  let failure = ''
  if (hasChatApi) {
    try {
      const participant = vscode.chat.createChatParticipant(
        'privatecode.agent',
        async (request, _chatContext, stream, _token) => {
          const folder = vscode.workspace.workspaceFolders?.[0]
          const serverUrl = vscode.workspace
            .getConfiguration('privatecode')
            .get<string>('serverUrl', 'http://127.0.0.1:8080')

          stream.progress('checking the environment…')
          stream.markdown([
            '**PrivateCode is wired into this chat.**',
            '',
            `- workspace: \`${folder ? folder.uri.fsPath : 'none open'}\``,
            `- model server: \`${serverUrl}\``,
            `- your prompt reached the extension: \`${request.prompt || '(empty)'}\``,
            '',
            'The agent itself lands in the next step — this build only proves the chat surface.',
          ].join('\n'))
        },
      )
      participant.iconPath = new vscode.ThemeIcon('shield')
      context.subscriptions.push(participant)
      registered = true
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e)
    }
  }

  out.appendLine(`participant registered: ${registered}${failure ? ` (${failure})` : ''}`)

  // The visible half of the check: a status-bar item is the least intrusive thing that
  // still proves activation happened at all, and it is where the mode indicator will live
  // once the agent is wired (plan task 4), so it is not throwaway scaffolding.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  status.text = registered ? '$(shield) PrivateCode' : '$(warning) PrivateCode: no chat API'
  status.tooltip = registered
    ? 'PrivateCode is registered as a chat participant — type @privatecode in Chat'
    : `Chat participant could not be registered${failure ? `: ${failure}` : ''}`
  status.command = 'privatecode.showLog'
  status.show()
  context.subscriptions.push(status)

  context.subscriptions.push(
    vscode.commands.registerCommand('privatecode.showLog', () => out.show(true)),
  )
}

export function deactivate(): void {
  // Nothing yet: no agent, no sidecar, no timers.
}
