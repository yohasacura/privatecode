import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { SessionHost } from '../../src/host/host.js'
import {
  isHostEvent, type CommandsListResult, type HostEvent, type HostOutbound, type HostReply, type PluginsCommandResult,
  type SendResult,
} from '../../src/host/protocol.js'

/**
 * The whole promise of docs/PLUGINS-2026-09.md, against the real model and the real network
 * (docs/PLUGINS-2026-09.md §8, phase E): Anthropic's own example marketplace is added with
 * the line its README gives, `commit-commands` is installed with the line ITS README gives,
 * and its `/commit-commands:commit` command — a plugin written for Claude Code, unchanged —
 * makes the model commit a change in a scratch repository.
 *
 * Run with `PRIVATECODE_INTEGRATION=1 npm run test:integration -- plugins-live`. The store
 * is a temp folder: the machine's own plugins are not touched.
 */

const SERVER = process.env.PRIVATECODE_SERVER ?? 'http://127.0.0.1:8080'
const enabled = process.env.PRIVATECODE_INTEGRATION === '1'

const GIT = ['-c', 'user.name=tests', '-c', 'user.email=tests@example.com', '-c', 'commit.gpgsign=false']

interface Transport { messages: HostOutbound[]; send(msg: HostOutbound): void }

function resultOf<T>(transport: Transport, id: number): T {
  const found = transport.messages.find((m): m is HostReply => !isHostEvent(m) && m.id === id)
  if (!found) throw new Error(`no reply to request ${id}`)
  if ('error' in found) throw new Error(`request ${id} failed: ${found.error.message}`)
  return found.result as T
}

let tmp: string
let savedAppData: string | undefined
let savedClaudeDir: string | undefined

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pc-plugins-live-'))
  savedAppData = process.env['APPDATA']
  savedClaudeDir = process.env['CLAUDE_CONFIG_DIR']
  process.env['APPDATA'] = join(tmp, 'appdata')
  process.env['CLAUDE_CONFIG_DIR'] = join(tmp, 'claude')
})
afterAll(() => {
  if (savedAppData === undefined) delete process.env['APPDATA']; else process.env['APPDATA'] = savedAppData
  if (savedClaudeDir === undefined) delete process.env['CLAUDE_CONFIG_DIR']; else process.env['CLAUDE_CONFIG_DIR'] = savedClaudeDir
  try { rmSync(tmp, { recursive: true, force: true }) } catch { /* a handle still open on Windows */ }
})

describe.skipIf(!enabled)('plugins against the live model', () => {
  test("commit-commands from anthropics/claude-code, installed as its README says, commits the model's change", async () => {
    // A scratch repository with one commit and one uncommitted change.
    const workspace = join(tmp, 'repo')
    mkdirSync(join(workspace, 'src'), { recursive: true })
    writeFileSync(join(workspace, 'README.md'), '# scratch\n')
    await execa('git', [...GIT, 'init', '-q', '-b', 'main'], { cwd: workspace })
    await execa('git', [...GIT, 'config', 'user.name', 'tests'], { cwd: workspace })
    await execa('git', [...GIT, 'config', 'user.email', 'tests@example.com'], { cwd: workspace })
    await execa('git', [...GIT, 'add', '-A'], { cwd: workspace })
    await execa('git', [...GIT, 'commit', '-q', '-m', 'init'], { cwd: workspace })
    writeFileSync(join(workspace, 'src', 'greet.ts'), 'export function greet(name: string): string {\n  return `Hello, ${name}!`\n}\n')

    const transport: Transport = { messages: [], send(msg) { this.messages.push(msg) } }
    const host = new SessionHost({ transport, prewarm: false })
    let id = 0
    const call = async <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
      id++
      await host.handle({ id, method, params })
      return resultOf<T>(transport, id)
    }
    const started = Date.now()
    const log = (line: string): void => { process.stdout.write(`[plugins-live +${((Date.now() - started) / 1000).toFixed(0)}s] ${line}\n`) }

    await call('init', { workspaceRoot: workspace, serverUrl: SERVER })
    await call('setMode', { mode: 'autopilot' })

    // 1. The marketplace, with the line Anthropic's README gives.
    const added = await call<PluginsCommandResult>('plugins.command', { line: '/plugin marketplace add anthropics/claude-code' })
    log(added.text)
    expect(added.ok).toBe(true)
    expect(added.text).toContain('marketplace claude-code-plugins')

    // 2. The plugin, with the line ITS README gives.
    const installed = await call<PluginsCommandResult>('plugins.command', { line: '/plugin install commit-commands@claude-code-plugins' })
    log(installed.text)
    expect(installed.ok).toBe(true)
    expect(installed.text).toContain('Installed commit-commands@claude-code-plugins')
    const commands = await call<CommandsListResult>('commands.list')
    expect(commands.commands.map((c) => c.name)).toEqual(expect.arrayContaining(['commit-commands:commit', 'commit-commands:commit-push-pr']))

    // 3. The plugin's command, used. Every approval the run asks for is granted, and every
    //    question answered, so the model can finish on its own.
    const answered = new Set<string>()
    const sendPromise = call<SendResult>('send', { text: '/commit-commands:commit' })
    let settled = false
    void sendPromise.finally(() => { settled = true })
    while (!settled) {
      await new Promise((r) => setTimeout(r, 200))
      for (const e of transport.messages.filter(isHostEvent) as HostEvent[]) {
        const data = e.data as { requestId?: string; tool?: string; summary?: string; question?: string }
        if (data.requestId === undefined || answered.has(data.requestId)) continue
        if (e.event === 'approval.request') {
          answered.add(data.requestId)
          log(`approve ${data.tool ?? ''}: ${data.summary ?? ''}`)
          await host.handle({ id: ++id, method: 'approval.reply', params: { requestId: data.requestId, decision: { verdict: 'allow' } } })
        } else if (e.event === 'question.request') {
          answered.add(data.requestId)
          log(`question: ${data.question ?? ''} → yes`)
          await host.handle({ id: ++id, method: 'question.reply', params: { requestId: data.requestId, answer: 'yes' } })
        }
      }
    }
    const result = await sendPromise
    log(`turn: ${result.turn.stoppedBecause} after ${result.turn.steps} steps — ${result.turn.finalText.slice(0, 300)}`)
    const tools = (transport.messages.filter(isHostEvent) as HostEvent[]).filter((e) => e.event === 'tool.call').map((e) => (e.data as { name?: string }).name)
    log(`tools: ${tools.join(', ')}`)

    // 4. What the plugin promised: a commit of the change, with a message.
    const logOut = (await execa('git', ['log', '--oneline'], { cwd: workspace })).stdout.trim().split('\n')
    log(`git log: ${logOut.join(' | ')}`)
    expect(logOut.length).toBeGreaterThanOrEqual(2)
    const status = (await execa('git', ['status', '--porcelain'], { cwd: workspace })).stdout.trim()
    expect(status).toBe('')

    await host.shutdown()
  }, 900_000)
})
