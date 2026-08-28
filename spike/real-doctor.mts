/**
 * The doctor pointed at a REAL workspace's stored sessions, without the app.
 *
 * `doctor-stories.mts` builds a transcript with known failures in it, so the report's shape
 * can be judged. This is the other half: it reads history somebody actually made, which is
 * the only way to find out what the diagnosis says when nothing is wrong — and "nothing is
 * wrong" is the answer it will give most of the time on a healthy machine, so it has to be
 * readable too rather than a wall of zeroes.
 *
 * It exists apart from the tool because the tool runs inside a session and this does not:
 * pointing it at a workspace is one command, needs no model, no server and no window, and
 * touches nothing — `diagnose` only reads.
 *
 *   npx tsx spike/real-doctor.mts "D:/path/to/a/workspace"
 */
import { diagnose, renderDiagnosis } from '../core/src/doctor/diagnose.js'
import { SessionStore } from '../core/src/session/store.js'

const root = process.argv[2] ?? process.cwd()
const metas = new SessionStore(root).list()
// Said before the report rather than inside it: a workspace with no sessions renders a
// perfectly healthy diagnosis of nothing at all, and the count is what tells the two apart.
console.log(`# ${metas.length} session${metas.length === 1 ? '' : 's'} listed in ${root}\n`)
console.log(renderDiagnosis(diagnose(root, metas)))
