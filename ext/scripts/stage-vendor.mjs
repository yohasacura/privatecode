// Copies the vendored assets the agent needs at runtime into the extension's own tree so
// they ship inside the .vsix: ripgrep (search_code) and the tree-sitter wasm grammars
// (symbol_outline). The extension sets PRIVATECODE_RG / PRIVATECODE_TS_WASM_DIR to these
// copies at activation -- the tools never guess a path (see search-code.ts's resolution
// order and the vendor/*/PROVENANCE.md rules).
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const extRoot = join(here, '..')
const repoRoot = join(extRoot, '..')
const target = join(extRoot, 'vendor')

rmSync(target, { recursive: true, force: true })
mkdirSync(join(target, 'tree-sitter'), { recursive: true })
cpSync(join(repoRoot, 'vendor', 'ripgrep', 'rg.exe'), join(target, 'rg.exe'))
for (const f of readdirSync(join(repoRoot, 'vendor', 'tree-sitter'))) {
  if (f.endsWith('.wasm')) {
    cpSync(join(repoRoot, 'vendor', 'tree-sitter', f), join(target, 'tree-sitter', f))
  }
}
console.log('vendored assets staged into ext/vendor')
