import * as vscode from 'vscode'
import { AgentBridge, configuredMode } from './bridge.js'
import { runTurn } from './turn.js'

/**
 * PrivateCode as a VS Code extension: the agent (plans 1-3, unchanged) hosted inside the
 * extension host, driven from the native chat view as `@privatecode`.
 *
 * Everything the standalone build hand-rolled badly is the IDE's job here -- the file
 * tree, the diff viewer, settings UI, dialogs -- so this file is small on purpose.
 */

const MODES = ['normal', 'plan', 'auto-edit', 'autopilot'] as const

export function activate(context: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel('PrivateCode')

  // The vendored assets ride inside the .vsix (scripts/stage-vendor.mjs). Pointing the
  // tools at THESE copies is the launching host's job -- search_code and symbol_outline
  // deliberately never guess a path, so a packaging change can never silently degrade
  // them into "no matches" (the ripgrep lesson from plan 2).
  const vendor = vscode.Uri.joinPath(context.extensionUri, 'vendor')
  process.env['PRIVATECODE_RG'] = vscode.Uri.joinPath(vendor, 'rg.exe').fsPath
  process.env['PRIVATECODE_TS_WASM_DIR'] = vscode.Uri.joinPath(vendor, 'tree-sitter').fsPath
  out.appendLine(`vendored assets: ${vendor.fsPath}`)

  const bridge = new AgentBridge()
  context.subscriptions.push(out, { dispose: () => void bridge.dispose() })

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  status.command = 'privatecode.pickMode'
  const refreshStatus = (): void => {
    status.text = `$(shield) PrivateCode: ${configuredMode()}`
    status.tooltip = 'Click to change how much PrivateCode may do without asking'
    status.show()
  }
  refreshStatus()
  context.subscriptions.push(status)

  const participant = vscode.chat.createChatParticipant(
    'privatecode.agent',
    async (request, _chatContext, stream, token) => {
      const folder = vscode.workspace.workspaceFolders?.[0]
      if (!folder) {
        stream.markdown('Open a folder first — PrivateCode works inside one workspace, and ' +
          'every file it may read or change is bounded by that folder.')
        return
      }
      await runTurn(request.prompt, {
        bridge,
        stream,
        token,
        workspaceRoot: folder.uri.fsPath,
      })
    },
  )
  participant.iconPath = new vscode.ThemeIcon('shield')
  context.subscriptions.push(participant)

  context.subscriptions.push(
    vscode.commands.registerCommand('privatecode.showLog', () => out.show(true)),
    vscode.commands.registerCommand('privatecode.pickMode', async () => {
      const picked = await vscode.window.showQuickPick(
        [
          { label: 'normal', description: 'ask before edits and commands' },
          { label: 'plan', description: 'read-only — investigate and propose' },
          { label: 'auto-edit', description: 'edit freely, ask before commands' },
          { label: 'autopilot', description: 'act unattended (built-in protections still apply)' },
        ],
        { title: 'PrivateCode mode' },
      )
      if (!picked) return
      const mode = picked.label as (typeof MODES)[number]
      await vscode.workspace.getConfiguration('privatecode')
        .update('mode', mode, vscode.ConfigurationTarget.Workspace)
      try {
        await bridge.call('setMode', { mode })
      } catch (e) {
        // No session yet is fine: the mode setting is read when one is created.
        out.appendLine(`setMode deferred: ${e instanceof Error ? e.message : String(e)}`)
      }
      refreshStatus()
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('privatecode.mode')) refreshStatus()
    }),
  )

  // Test hook: when `privatecode.devSmokeQuery` is set (workspace settings only, empty by
  // default), the chat view opens with that prompt already submitted. It exists so a full
  // turn can be driven and watched end-to-end without a human typing -- the previous UI
  // shipped a first-run flow nobody had actually walked through, and this is the cheapest
  // insurance against repeating that.
  const smoke = vscode.workspace.getConfiguration('privatecode').get<string>('devSmokeQuery', '')
  if (smoke.trim() !== '') {
    setTimeout(() => {
      void vscode.commands.executeCommand('workbench.action.chat.open', {
        query: `@privatecode ${smoke}`,
      })
    }, 2500)
  }
}

export function deactivate(): void {
  // The bridge's disposable (registered above) shuts the agent down: aborts a running
  // turn and any background compaction, stops background tasks.
}
