import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { LlamaClient } from '../src/llama/client.js'
import { Session } from '../src/session/session.js'
import { createToolset } from '../src/tools/default-set.js'
import { startFakeServer } from './fake-server.js'

let stop: (() => Promise<void>) | undefined
const roots: string[] = []

afterEach(async () => {
  await stop?.()
  stop = undefined
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function writeStep(path: string, content: string): unknown {
  return {
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: `c-${path}`,
          type: 'function',
          function: { name: 'write_file', arguments: JSON.stringify({ path, content }) },
        }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  }
}

function textStep(text: string): unknown {
  return {
    choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 5 },
  }
}

test('AUDIT: a long turn followed by a verify round reports the FIXER step count', async () => {
  let call = 0
  const LONG = 12
  const fake = await startFakeServer((_body, req) => {
    if (req.url === '/props') return { default_generation_settings: { n_ctx: 8000 } }
    if (req.url === '/health') return { status: 'ok' }
    call++
    if (call <= LONG) return writeStep(`file${call}.txt`, `contents ${call}`)
    if (call === LONG + 1) return textStep('done with the long part')
    // verify fails once, the fixer answers in one step, verify then passes
    return textStep('fixed it')
  })
  stop = fake.close
  const root = mkdtempSync(join(tmpdir(), 'pc-audit2-'))
  roots.push(root)

  // A verify command that fails the first time and passes the second.
  const marker = join(root, 'verify-ran.txt')
  const cmd = process.platform === 'win32'
    ? `node -e "const fs=require('fs');const p=${JSON.stringify(marker).replace(/"/g, "'")};if(fs.existsSync(p)){process.exit(0)}else{fs.writeFileSync(p,'x');process.exit(1)}"`
    : `node -e "const fs=require('fs');const p=${JSON.stringify(marker).replace(/"/g, "'")};if(fs.existsSync(p)){process.exit(0)}else{fs.writeFileSync(p,'x');process.exit(1)}"`

  const session = new Session({
    client: new LlamaClient({ baseUrl: fake.url, model: 'm' }),
    toolset: createToolset({}),
    workspaceRoot: root,
    mode: 'autopilot',
    longRun: true,
    verify: { command: cmd, timeoutMs: 30_000, source: 'test' },
  })

  const result = await session.send('do twelve things')
  // eslint-disable-next-line no-console
  console.log('TurnResult.steps reported to the host/UI =', result.steps,
    '(the turn actually ran', LONG + 1, 'steps)')

  const log = readFileSync(join(root, '.privatecode', 'worklog.md'), 'utf8')
  // eslint-disable-next-line no-console
  console.log('---- worklog.md ----\n' + log)
  expect(result.steps).toBeLessThan(LONG)
})
