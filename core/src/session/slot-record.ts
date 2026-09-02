import { createHash } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { ensureStateDir, statePath } from '../private-dir.js'

/**
 * Which session's prompt state the server's slot file for this workspace holds.
 *
 * llama.cpp can write a slot's whole KV state to disk (`--slot-save-path`) and read it back
 * in well under a second — measured 0.5 s for a 20k-token state, and a resumed conversation
 * then prefilled 22 tokens instead of 19,900 (`spike/slot-save-probe.mts`, across a server
 * restart). That is what turns "resume" from minutes of silence on a fat session into a
 * heartbeat.
 *
 * The server takes a FILE NAME, never a path, and PrivateCode does not know the directory
 * the launcher pointed the server at — so it cannot list or delete what it saved. Hence one
 * file per workspace, overwritten: the session you were last in resumes instantly, older
 * ones prefill in the background as they always did, and the disk holds one state per
 * workspace instead of one per session that ever existed (a 100k-token state is ~2.3 GB).
 * This record is the label on that one file: which session, when, how many tokens. A file
 * whose record names another session is simply not restored.
 */
export interface SlotRecord {
  sessionId: string
  savedAt: string
  tokens: number
}

const RECORD_FILE = 'slot.json'

/** The one file name this workspace's state is saved under. Plain characters only: the
 * server refuses anything that looks like a path. */
export function slotFilenameFor(workspaceRoot: string): string {
  const key = createHash('sha1').update(workspaceRoot.toLowerCase()).digest('hex').slice(0, 12)
  return `privatecode-${key}.bin`
}

export function readSlotRecord(workspaceRoot: string): SlotRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(statePath(workspaceRoot, RECORD_FILE), 'utf8')) as Partial<SlotRecord>
    if (typeof parsed.sessionId !== 'string' || typeof parsed.savedAt !== 'string') return null
    return { sessionId: parsed.sessionId, savedAt: parsed.savedAt, tokens: typeof parsed.tokens === 'number' ? parsed.tokens : 0 }
  } catch {
    return null
  }
}

export function writeSlotRecord(workspaceRoot: string, record: SlotRecord): void {
  try {
    ensureStateDir(workspaceRoot)
    writeFileSync(statePath(workspaceRoot, RECORD_FILE), JSON.stringify(record, null, 2), 'utf8')
  } catch { /* a label that could not be written means the file is not restored — the safe side */ }
}

/** Forget the record when it names `sessionId` (a swap rewrote the prefix, or the session was
 * deleted). The file on disk stays until the next save overwrites it. */
export function clearSlotRecord(workspaceRoot: string, sessionId: string): void {
  const record = readSlotRecord(workspaceRoot)
  if (record === null || record.sessionId !== sessionId) return
  try { rmSync(statePath(workspaceRoot, RECORD_FILE), { force: true }) } catch { /* same */ }
}
