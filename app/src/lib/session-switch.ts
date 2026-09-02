import type { AgentMode } from '@core/permissions/engine'
import type { TranscriptEntry } from '@core/host/protocol'

/**
 * What the window needs to know when the live session changes hands: a new one, a resumed
 * one, the replacement the host picks after a delete, or the session a freshly opened
 * workspace lands on. Every place that switches builds one of these and hands it to App's
 * `onSessionSwitched`, which feeds the reducer.
 */
export interface SessionSwitch {
  sessionId: string
  mode: AgentMode
  gateMode: 'auto' | 'manual'
  contextLength: number | null
  title: string
  problems: string[]
  items: readonly TranscriptEntry[]
  contextUsed: { promptTokens: number | null; approxTokens: number }
  compactAt?: number
}
