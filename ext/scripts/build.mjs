// Bundles the extension (and the agent core it imports) into one CommonJS file the
// extension host loads. `vscode` is external -- it is injected by the host, never bundled.
import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const extRoot = join(here, '..')

await build({
  entryPoints: [join(extRoot, 'src', 'extension.ts')],
  outfile: join(extRoot, 'dist', 'extension.js'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['vscode'],
  sourcemap: true,
  minify: false,
  logLevel: 'info',
})
console.log('extension bundled -> dist/extension.js')
