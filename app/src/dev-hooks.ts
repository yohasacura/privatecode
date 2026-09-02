/**
 * Development-only listeners, imported FIRST by main.tsx so they are in place before any
 * other module evaluates. Preact flushes re-renders in a microtask, so a component that
 * throws while re-rendering surfaces as an unhandled rejection whose stack the console
 * cuts short; this prints the whole of it. Nothing here runs in a release build.
 */
if (import.meta.env.DEV) {
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason as { stack?: string } | undefined
    console.error('[dev] unhandled rejection:', reason?.stack ?? String(e.reason))
  })
  window.addEventListener('error', (e) => {
    const error = e.error as { stack?: string } | undefined
    console.error('[dev] uncaught error:', error?.stack ?? e.message)
  })
}

export {}
