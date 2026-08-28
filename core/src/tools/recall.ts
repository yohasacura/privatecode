import { loadProjectNotes } from '../memory/project-notes.js'
import type { Tool } from './types.js'

/**
 * Reading back what `remember` stored — the half that was missing.
 *
 * Notes reach the model exactly one way: `loadProjectNotes` runs when the session is built
 * and its fresh block is frozen into message 0. That covers the common case and leaves two
 * holes. A note written during THIS session is not in that block, so the model cannot see
 * what it just recorded or tell whether it is about to record it twice. And there was no
 * answer at all to "how do I read my notes" — asked directly, the model went looking through
 * `.privatecode/`, found the file, and told the user the way to read notes is
 * `read_file('.privatecode/project-notes.md')`.
 *
 * That workaround is the reason this tool exists rather than a convenience. The FILE holds
 * every note ever written, including the ones whose evidence has since changed; the loader
 * is what re-hashes and drops those. Reading the file directly therefore returns exactly the
 * stale, confident sentences about code that has moved on which `project-notes.ts` says, in
 * its own opening comment, the whole design exists to prevent. The advice was one step from
 * teaching the model to feed itself folklore.
 *
 * So: same loader, same freshness rule, same answer as message 0 — and the count of what was
 * dropped, because "there are notes here that no longer hold" is worth knowing and is not
 * something a silent filter can say.
 */
export const recallTool: Tool<Record<string, never>> = {
  name: 'recall',
  readOnly: true,
  description:
    'Read the project notes stored by `remember` — the durable facts earlier sessions ' +
    'worked out about this project. The notes already in your context arrived this way ' +
    'when the session started; call this to see one you recorded since, or to check ' +
    'whether something is already recorded before recording it again. Only notes whose ' +
    'evidence files are unchanged are returned.',
  parameters: { type: 'object', properties: {}, required: [] },
  validate() {
    return { ok: true, args: {} }
  },
  async execute(_args, ctx) {
    const notes = loadProjectNotes(ctx.workspace.root, ctx.workspace)

    // Said out loud rather than folded into an empty result: "nothing is recorded" and
    // "everything recorded has gone stale" are different facts, and the second one is the
    // one that explains why the context looks emptier than the file.
    const dropped = notes.stale.length > 0
      ? `\n\n(${notes.stale.length} more ${notes.stale.length === 1 ? 'note is' : 'notes are'} ` +
        'stored but not shown: the files they were learned from have changed, so they are no ' +
        'longer evidence of anything. Do not go read the file to get at them.)'
      : ''

    if (notes.fresh.length === 0) {
      return {
        ok: true,
        content: notes.stale.length === 0
          ? 'No project notes are recorded yet.'
          : `No project notes still hold.${dropped}`,
      }
    }
    return { ok: true, content: `${notes.text}${dropped}` }
  },
}
