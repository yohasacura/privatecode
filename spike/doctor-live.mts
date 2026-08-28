/**
 * What `doctor` actually says about a real history on this machine.
 *
 * Run against whatever workspace is given, so the report can be read by eye before anybody
 * is told it is safe to send. The leak tests prove no path exists; this proves what it looks
 * like when it is true.
 *
 *   npx tsx spike/doctor-live.mts [workspaceRoot]
 */
import { diagnose, renderDiagnosis } from '../core/src/doctor/diagnose.js'
import { SessionStore } from '../core/src/session/store.js'

const root = process.argv[2] ?? 'D:\\Projects\\LocalAgent\\pc-livetest'
const metas = new SessionStore(root).list()

console.log(`workspace: ${root}`)
console.log(`sessions listed: ${metas.length}\n`)
if (metas.length === 0) {
  console.log('nothing to diagnose here')
  process.exit(0)
}
console.log(renderDiagnosis(diagnose(root, metas)))
