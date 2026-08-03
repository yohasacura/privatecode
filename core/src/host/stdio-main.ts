import { parseArgs } from 'node:util'
import { SessionHost } from './host.js'
import { encodeLine, LineDecoder, type HostOutbound, type HostRequest } from './protocol.js'

/**
 * Type-guards a decoded ndjson value as a well-formed `HostRequest` envelope (an `id` and a
 * `method`; `params` is unchecked here -- each RPC handler inside `SessionHost` validates its
 * own params shape and reports a bad one as an ordinary error reply, never a crash). Anything
 * that doesn't even have this much shape is not a request this sidecar can answer at all --
 * there is no `id` to reply to -- so it is logged to stderr and dropped rather than handed to
 * `host.handle()`, which requires a well-formed `HostRequest`.
 */
function isHostRequest(value: unknown): value is HostRequest {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v['id'] === 'number' && typeof v['method'] === 'string'
}

async function main(): Promise<void> {
  // --workspace is accepted here purely for command-line symmetry with cli.ts, and so a
  // malformed invocation (e.g. --workspace with no value) fails fast with a usage error
  // instead of being silently ignored. It is NOT how this process actually learns its
  // workspace root: the UI always sends that as `init`'s own `workspaceRoot` field over
  // stdio, and this entry never shortcuts around that by synthesizing an `init` call of its
  // own from argv -- it has no `serverUrl` to pair with a CLI-sourced workspace anyway, and
  // guessing one would repeat exactly the mistake the asset-env-var note below warns against.
  // Either way this process ends up in the same place: waiting on stdin for the UI's own
  // `init` request.
  try {
    parseArgs({ options: { workspace: { type: 'string' } }, strict: false, allowPositionals: true })
  } catch (e) {
    process.stderr.write(`stdio-main: ${e instanceof Error ? e.message : String(e)}\n`)
    process.exitCode = 2
    return
  }

  // PRIVATECODE_RG / PRIVATECODE_TS_WASM_DIR (the vendored ripgrep binary and tree-sitter
  // wasm grammars -- see search_code and symbol_outline) are read by the tools themselves
  // wherever they already look for them. This entry point does not set, override, or guess
  // at either one: locating the vendored assets is the launching shell's job (T4), not the
  // sidecar's -- a sidecar that tried to guess a path would be exactly the kind of silent
  // assumption that breaks the moment the packaging layout changes underneath it.

  const decoder = new LineDecoder()
  const host = new SessionHost({
    transport: {
      send(msg: HostOutbound): void {
        process.stdout.write(encodeLine(msg))
      },
    },
  })

  let shuttingDown = false
  async function shutdownOnce(): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    await host.shutdown()
    // Releases stdin's hold on the event loop so the process can exit on its own once
    // shutdown's async work (abort + compaction + background tasks) has settled -- see the
    // process.exitCode discipline note below for why this never forces the issue.
    process.stdin.pause()
  }

  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    let messages: unknown[]
    try {
      messages = decoder.push(chunk)
    } catch (e) {
      // A malformed or oversized line means the connection itself is compromised (see
      // LineDecoder's own doc comment) -- nothing further on this stream can be trusted, so
      // this shuts down rather than trying to keep parsing past it.
      process.stderr.write(`stdio-main: ${e instanceof Error ? e.message : String(e)}\n`)
      process.exitCode = 1
      void shutdownOnce()
      return
    }
    for (const msg of messages) {
      if (!isHostRequest(msg)) {
        process.stderr.write(`stdio-main: ignoring a line that is not a request: ${JSON.stringify(msg)}\n`)
        continue
      }
      // Fire-and-forget: handle() ALWAYS replies exactly once and never throws (see
      // host.ts), so there is nothing here to await or catch. Multiple requests can
      // therefore be in flight concurrently -- SessionHost's own guards (send-while-
      // running refusal, single-use requestIds) are what keep that safe, not ordering here.
      void host.handle(msg)
    }
  })
  process.stdin.on('end', () => { void shutdownOnce() })
  process.on('SIGTERM', () => { void shutdownOnce() })

  process.stdin.resume()
}

// process.exitCode, never process.exit(): cli.ts's own comment on this (read before writing
// this file) records the crash the latter caused -- a step that had spawned a child process,
// followed by process.exit(), crashed Windows with a libuv assertion
// (`!(handle->flags & UV_HANDLE_CLOSING)`) even though the turn itself had already finished
// cleanly, and the precise trigger was never fully isolated. This sidecar has no natural
// "done" point at all -- it is a long-lived process, not a one-shot CLI run -- so the
// discipline here is the same in spirit but simpler: process.exit() is never called,
// anywhere, for any reason; shutdownOnce()'s teardown plus pausing stdin above is what lets
// the event loop drain and the process exit on its own.
main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`)
  process.exitCode = 1
})
