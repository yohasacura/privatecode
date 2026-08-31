import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { diagnose, renderDiagnosis } from './diagnose.js'
import { PRIVATE_DIR } from '../private-dir.js'
import { SessionStore } from '../session/store.js'

/**
 * Running the doctor, for a PERSON who asked for it.
 *
 * It used to be a tool, and the owner's reason for taking it away is the right one: the
 * model was reaching for it on its own, and there is nothing it can do with the answer. The
 * report is not a fact about the workspace that helps the next edit — it is a description of
 * the agent's own behaviour, addressed to whoever maintains the agent. A model that reads it
 * mid-task can only do one of two things, and both are wrong: act on it, which is a
 * self-modification nobody asked for, or narrate it, which spends a turn saying what the
 * file already says.
 *
 * Taking it out of the registry is what makes that true rather than discouraged. A tool that
 * is not in the array cannot be called, and this project has measured what the alternative —
 * telling the model not to — is worth: 0 of 703.
 *
 * The window calls this directly, so a diagnosis costs no generation at all: it is a walk
 * over files that took 1.4 ms on a real history, against the twenty-odd seconds a model turn
 * costs. The person gets the report in the transcript and the artifact on disk, and nothing
 * is spent asking the model what it thinks about its own report card.
 */

export interface DoctorReport {
  /** The whole report, exactly as the file has it. */
  report: string
  /** Where it was written, workspace-relative, or null when the write failed — in which
   * case the report above is still complete and still safe. */
  savedTo: string | null
  /** Sessions the diagnosis actually read. Zero is a real answer and needs saying. */
  sessions: number
}

/**
 * Diagnoses this workspace and writes the artifact.
 *
 * `since` narrows to sessions last touched on or after that date, as YYYY-MM-DD; the caller
 * validates it. Nothing here reads a transcript except through `diagnose`, whose one rule is
 * that no text from one can reach the output.
 */
export function runDoctor(workspaceRoot: string, since: string | undefined): DoctorReport {
  const all = new SessionStore(workspaceRoot).list()
  const metas = since === undefined
    ? all
    : all.filter((m) => m.updatedAt >= `${since}T00:00:00.000Z`)

  const d = diagnose(workspaceRoot, metas)
  if (d.sessions === 0) {
    return {
      // Said plainly rather than rendered as a page of zeroes, which reads as "this agent
      // has done nothing wrong" and is the one conclusion an empty scan cannot support.
      report: metas.length === 0
        ? (since === undefined
          ? 'There are no stored conversations in this workspace to diagnose.'
          : `No conversations in this workspace were touched on or after ${since}.`)
        : `${metas.length} conversations are listed but none has a transcript on disk, so ` +
          'there is nothing to measure.',
      savedTo: null,
      sessions: 0,
    }
  }

  const report = renderDiagnosis(d)
  // Written to a FILE as well as returned, and the file is the point: what travels off a
  // confidential machine has to be the artifact, not somebody's retelling of it.
  let savedTo: string | null = join(PRIVATE_DIR, 'diagnosis.md')
  try {
    writeFileSync(join(workspaceRoot, savedTo), `${report}\n`, 'utf8')
  } catch {
    // Not fatal and not silent. The report is still complete and still safe to send; only
    // the convenience of having it as a file is lost.
    savedTo = null
  }
  return { report, savedTo, sessions: d.sessions }
}
