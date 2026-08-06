import { CdpConnection } from '../../src/browser/cdp.js'
const list = await (await fetch('http://127.0.0.1:9223/json')).json() as { title: string; url: string; webSocketDebuggerUrl: string }[]
const cdp = await CdpConnection.connect(list[0]!.webSocketDebuggerUrl)
const ev = async (expr: string) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true })
  return r.result?.value ?? r.exceptionDetails?.text
}
console.log(await ev('document.body.innerText.slice(0, 600)'))
console.log('overlay:', await ev('!!document.querySelector("vite-error-overlay")'))
process.exit(0)
