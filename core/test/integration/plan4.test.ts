import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

/**
 * Plan 4 acceptance: drives the SHIPPED artifact -- core/dist/sidecar/agent.cjs, the
 * exact bundle the Tauri app launches -- over its stdio protocol, the way the Rust shell
 * does. Run `npm run bundle` before this suite; it fails loudly (not silently green) if
 * the bundle is stale or missing.
 *
 * Cases 1/2/3/5 need the live llama.cpp server (single slot -- this file runs under the
 * singleFork integration config, strictly serial). Cases 4 and 6 are model-free: the
 * jail and the approval requestId contract must hold even with no server at all, and
 * proving them against the shipped bundle is the point (the T2 unit tests prove them
 * in-process; this re-proves them across the real process boundary).
 */

const SIDECAR = resolve(__dirname, '../../dist/sidecar')
const SERVER = 'http://127.0.0.1:8080'

let serverUp = false
beforeAll(async () => {
  try {
    const res = await fetch(`${SERVER}/health`, { signal: AbortSignal.timeout(3000) })
    serverUp = (await res.json())?.status === 'ok'
  } catch {
    serverUp = false
  }
})

interface Pending { resolve: (v: any) => void; reject: (e: Error) => void }

/** A minimal protocol driver over the sidecar's stdio -- the same framing client.ts
 * implements in the app, kept independent here so the test cannot inherit an app bug. */
class Driver {
  private child: ChildProcessWithoutNullStreams
  private buf = ''
  private nextId = 1
  private pending = new Map<number, Pending>()
  readonly events: Array<{ event: string; data: any }> = []
  private eventWaiters: Array<{ name: string; resolve: (data: any) => void }> = []
  /** Auto-reply for approval.request events; null = leave pending. */
  autoApprove: ((req: any) => any) | null = null

  constructor(workspace: string) {
    this.child = spawn(
      process.execPath,
      [join(SIDECAR, 'agent.cjs')],
      {
        env: {
          ...process.env,
          PRIVATECODE_RG: join(SIDECAR, 'vendor/ripgrep/rg.exe'),
          PRIVATECODE_TS_WASM_DIR: join(SIDECAR, 'vendor/tree-sitter'),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    void workspace
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => {
      this.buf += chunk
      let i: number
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i)
        this.buf = this.buf.slice(i + 1)
        if (!line.trim()) continue
        const msg = JSON.parse(line)
        if (typeof msg.id === 'number') {
          const p = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          if (p) {
            if ('error' in msg) p.reject(new Error(msg.error.message))
            else p.resolve(msg.result)
          }
        } else if (typeof msg.event === 'string') {
          this.events.push(msg)
          for (let w = this.eventWaiters.length - 1; w >= 0; w--) {
            if (this.eventWaiters[w]!.name === msg.event) {
              const waiter = this.eventWaiters.splice(w, 1)[0]!
              waiter.resolve(msg.data)
            }
          }
          if (msg.event === 'approval.request' && this.autoApprove) {
            void this.request('approval.reply', {
              requestId: msg.data.requestId,
              decision: this.autoApprove(msg.data),
            }).catch(() => {})
          }
        }
      }
    })
  }

  request(method: string, params: unknown, timeoutMs = 180_000): Promise<any> {
    const id = this.nextId++
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(
        () => rejectPromise(new Error(`request ${method} (#${id}) timed out`)), timeoutMs)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolvePromise(v) },
        reject: (e) => { clearTimeout(timer); rejectPromise(e) },
      })
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }

  waitEvent(name: string, timeoutMs = 180_000): Promise<any> {
    const already = this.events.find((e) => e.event === name)
    if (already) return Promise.resolve(already.data)
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(
        () => rejectPromise(new Error(`event ${name} never arrived`)), timeoutMs)
      this.eventWaiters.push({ name, resolve: (d) => { clearTimeout(timer); resolvePromise(d) } })
    })
  }

  async close(): Promise<void> {
    this.child.stdin.end()
    await new Promise<void>((resolveExit) => {
      const timer = setTimeout(() => { this.child.kill(); resolveExit() }, 5000)
      this.child.on('exit', () => { clearTimeout(timer); resolveExit() })
    })
  }
}

let driver: Driver | null = null
let workspace: string | null = null
afterEach(async () => {
  if (driver) { await driver.close(); driver = null }
  if (workspace) { rmSync(workspace, { recursive: true, force: true }); workspace = null }
})

function makeWorkspace(): string {
  workspace = mkdtempSync(join(tmpdir(), 'pc-plan4-'))
  return workspace
}

describe('plan 4 acceptance -- shipped sidecar over stdio', () => {
  it('case 4 (model-free): fs endpoints enforce the jail across the process boundary', async () => {
    const ws = makeWorkspace()
    writeFileSync(join(ws, 'ok.txt'), 'fine\n')
    driver = new Driver(ws)
    await driver.request('init', { workspaceRoot: ws, serverUrl: SERVER })

    const ok = await driver.request('fs.read', { path: 'ok.txt' })
    expect(ok.lines).toEqual(['fine'])

    await expect(driver.request('fs.read', { path: '../outside.txt' }))
      .rejects.toThrow(/escapes the workspace/)
    await expect(driver.request('fs.read', { path: '.env' }))
      .rejects.toThrow(/access denied/)
    await expect(driver.request('fs.tree', { path: '..' }))
      .rejects.toThrow(/escapes the workspace/)
  }, 60_000)

  it('case 6 (model-free): a forged or replayed approval requestId authorizes nothing', async () => {
    const ws = makeWorkspace()
    driver = new Driver(ws)
    await driver.request('init', { workspaceRoot: ws, serverUrl: SERVER })

    // Forged: no approval is pending at all.
    await expect(driver.request('approval.reply', {
      requestId: 'forged-id-123', decision: { verdict: 'allow' },
    })).rejects.toThrow(/no pending|unknown|not pending/i)

    // Replay needs a real pending id, which needs a real turn -- covered in case 1 when
    // the server is up. The forged path is the load-bearing half: an attacker-chosen id
    // must never resolve anything, and that holds with zero model involvement.
  }, 60_000)

  describe.runIf(process.env.PC_SKIP_LIVE !== '1')('live-model cases', () => {
    it('case 1: init + edit turn with auto-approve; event order sane; replayed id errors', async (ctx) => {
      if (!serverUp) return ctx.skip()
      const ws = makeWorkspace()
      writeFileSync(join(ws, 'greet.txt'), 'helo world\n')
      driver = new Driver(ws)
      const usedIds: string[] = []
      driver.autoApprove = (req) => {
        usedIds.push(req.requestId)
        return { verdict: 'allow' }
      }
      await driver.request('init', { workspaceRoot: ws, serverUrl: SERVER })
      const sent = await driver.request('send', {
        text: 'Fix the typo in greet.txt: "helo" should be "hello". Use edit_file, then say done.',
      })
      expect(sent.turn.stoppedBecause).toBe('done')
      expect(readFileSync(join(ws, 'greet.txt'), 'utf8')).toContain('hello')

      const names = driver.events.map((e) => e.event)
      expect(names).toContain('step.start')
      expect(names).toContain('tool.call')
      expect(names).toContain('turn.done')
      expect(names.indexOf('step.start')).toBeLessThan(names.indexOf('turn.done'))

      // Replay: the id was consumed by the auto-approve -- replying again must error.
      expect(usedIds.length).toBeGreaterThan(0)
      await expect(driver.request('approval.reply', {
        requestId: usedIds[0], decision: { verdict: 'allow' },
      })).rejects.toThrow(/no pending|unknown|not pending/i)
    }, 240_000)

    it('case 2: deny-with-comment steers the model', async (ctx) => {
      if (!serverUp) return ctx.skip()
      const ws = makeWorkspace()
      writeFileSync(join(ws, 'notes.txt'), 'alpha\n')
      driver = new Driver(ws)
      let denied = false
      driver.autoApprove = (req) => {
        if (!denied && req.tool === 'write_file') {
          denied = true
          return { verdict: 'deny', comment: 'do not create new files; edit notes.txt instead' }
        }
        return { verdict: 'allow' }
      }
      await driver.request('init', { workspaceRoot: ws, serverUrl: SERVER })
      const sent = await driver.request('send', {
        text: 'Create a file summary.txt containing the word beta.',
      })
      // Whatever the model chose after the refusal, the turn must complete and the
      // refusal must be visible in the event stream.
      expect(['done', 'max_steps']).toContain(sent.turn.stoppedBecause)
      const toolResults = driver.events.filter((e) => e.event === 'tool.result')
      expect(toolResults.some((e) => String(e.data.content).includes('declined'))).toBe(true)
    }, 240_000)

    it('case 3: abort mid-turn preserves the partial', async (ctx) => {
      if (!serverUp) return ctx.skip()
      const ws = makeWorkspace()
      driver = new Driver(ws)
      await driver.request('init', { workspaceRoot: ws, serverUrl: SERVER })
      const sendPromise = driver.request('send', {
        text: 'Think very carefully: list 30 prime numbers with a one-line justification each, then stop.',
      })
      await driver.waitEvent('thinking.delta')
      await new Promise((r) => setTimeout(r, 2000))
      await driver.request('abort', {})
      const sent = await sendPromise
      expect(sent.turn.stoppedBecause).toBe('aborted')
      const follow = await driver.request('send', { text: 'Just reply with the word ok.' })
      expect(['done', 'max_steps']).toContain(follow.turn.stoppedBecause)
    }, 240_000)

    it('case 5: sessions.resume continuity across sidecar restarts', async (ctx) => {
      if (!serverUp) return ctx.skip()
      const ws = makeWorkspace()
      driver = new Driver(ws)
      const init = await driver.request('init', { workspaceRoot: ws, serverUrl: SERVER })
      await driver.request('send', {
        text: 'Remember this codeword: PARSNIP. Just acknowledge briefly.',
      })
      await driver.close()

      driver = new Driver(ws)
      await driver.request('init', { workspaceRoot: ws, serverUrl: SERVER, resume: init.sessionId })
      const back = await driver.request('send', {
        text: 'What was the codeword? Answer with the single word.',
      })
      expect(back.turn.finalText).toMatch(/PARSNIP/i)
    }, 240_000)
  })
})
