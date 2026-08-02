import { existsSync } from 'node:fs'
import { extname, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Parser from 'web-tree-sitter'

export interface OutlineEntry {
  /** 'class' | 'method' | 'function' | 'interface' | 'enum' | 'struct' | 'record' |
   *  'property' | 'namespace' | 'type' | '...' (the truncation marker; see MAX_ENTRIES). */
  kind: string
  name: string
  /** 1-based. */
  line: number
  /** Nesting level for indentation. */
  depth: number
}

type LanguageKey = 'typescript' | 'tsx' | 'javascript' | 'c_sharp' | 'python'

/**
 * Single source of truth for what `symbol_outline` accepts. Exported so the tool
 * (`tools/symbol-outline.ts`) can build both its description and its refusal message from
 * this list rather than keeping a second copy that could drift from the one actually
 * consulted here.
 */
export const SUPPORTED_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.cs', '.py']

const EXTENSION_TO_LANGUAGE: Record<string, LanguageKey> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.cs': 'c_sharp',
  '.py': 'python',
}

/** The grammar file vendored per language, relative to the resolved wasm directory. */
const GRAMMAR_FILE: Record<LanguageKey, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  c_sharp: 'tree-sitter-c_sharp.wasm',
  python: 'tree-sitter-python.wasm',
}

/**
 * Node type -> OutlineEntry.kind, per language. A node type absent from a table is not an
 * error: it is scaffolding (`program`, `class_body`, `statement_block`, Python's
 * `decorated_definition`, ...) that the walk passes through *without* adding a depth level
 * or an entry, so an entry nested inside scaffolding is still found. This is also how
 * Python's "a decorated_definition contributes its inner definition" requirement is met:
 * `decorated_definition` simply is not in the table, so its `function_definition` /
 * `class_definition` child is reached at the same depth as if the decorator were absent.
 */
const JS_FAMILY_TABLE: Record<string, string> = {
  function_declaration: 'function',
  class_declaration: 'class',
  abstract_class_declaration: 'class',
  method_definition: 'method',
  interface_declaration: 'interface',
  enum_declaration: 'enum',
  type_alias_declaration: 'type',
  // TypeScript's `namespace Foo { ... }` and `module Foo { ... }` both parse as `module`.
  module: 'namespace',
  // The vendored tree-sitter-typescript grammar parses `namespace Foo { ... }` as `internal_module`.
  internal_module: 'namespace',
}

const C_SHARP_TABLE: Record<string, string> = {
  namespace_declaration: 'namespace',
  file_scoped_namespace_declaration: 'namespace',
  class_declaration: 'class',
  interface_declaration: 'interface',
  struct_declaration: 'struct',
  record_declaration: 'record',
  enum_declaration: 'enum',
  method_declaration: 'method',
  constructor_declaration: 'method',
  property_declaration: 'property',
}

const PYTHON_TABLE: Record<string, string> = {
  function_definition: 'function',
  class_definition: 'class',
}

const NODE_TABLE: Record<LanguageKey, Record<string, string>> = {
  typescript: JS_FAMILY_TABLE,
  tsx: JS_FAMILY_TABLE,
  javascript: JS_FAMILY_TABLE,
  c_sharp: C_SHARP_TABLE,
  python: PYTHON_TABLE,
}

/** Cap on entries returned; the rest are folded into one summary entry (see `walk`). */
const MAX_ENTRIES = 400

/**
 * `vendor/tree-sitter`, resolved relative to this module rather than to `process.cwd()` —
 * the CLI runs with the user's workspace as cwd, exactly the reasoning `search-code.ts`
 * documents for `vendor/ripgrep/rg.exe`. `PRIVATECODE_TS_WASM_DIR` overrides it outright
 * (no fallback beneath it: an explicit override that is wrong should be reported as wrong,
 * not silently bypassed), the same override contract `search-code.ts` gives
 * `PRIVATECODE_RG`. See `vendor/tree-sitter/PROVENANCE.md` for bundling rules.
 */
function resolveWasmDir(): string {
  const override = process.env.PRIVATECODE_TS_WASM_DIR
  if (override !== undefined && override.trim() !== '') return override
  const here = dirname(fileURLToPath(import.meta.url))
  // core/src/outline -> core/src -> core -> repo root -> vendor/tree-sitter
  return join(here, '..', '..', '..', 'vendor', 'tree-sitter')
}

/**
 * A missing wasm file must fail loudly, naming the exact path it looked at — the ripgrep
 * lesson (`vendor/ripgrep/PROVENANCE.md`): a silently empty outline is indistinguishable
 * from a genuinely symbol-free file, and the model would have no way to tell "the tool is
 * broken" from "this file has nothing in it".
 */
function assertWasmFile(path: string, what: string): void {
  if (!existsSync(path)) {
    throw new Error(
      `symbol_outline cannot ${what}: no wasm file at "${path}". Restore the vendored copy ` +
      'in vendor/tree-sitter (see vendor/tree-sitter/PROVENANCE.md), or set ' +
      'PRIVATECODE_TS_WASM_DIR to a directory that has it.',
    )
  }
}

/**
 * `Parser.init()` may only usefully run once per process, and is expensive (it loads and
 * instantiates the tree-sitter runtime's own wasm). Cached at module level; on failure the
 * cache is cleared so a later call - e.g. after a missing wasm file is restored - can
 * retry rather than being stuck replaying the same rejection for the life of the process.
 */
let initPromise: Promise<void> | null = null

function ensureInit(): Promise<void> {
  if (initPromise === null) {
    const wasmDir = resolveWasmDir()
    const runtimeWasm = join(wasmDir, 'tree-sitter.wasm')
    initPromise = (async () => {
      assertWasmFile(runtimeWasm, 'start')
      await Parser.init({ locateFile: () => runtimeWasm })
    })().catch((e) => {
      initPromise = null
      throw e
    })
  }
  return initPromise
}

/**
 * `Parser.Language` instances, cached per language at module level: loading a grammar's
 * wasm is the expensive step, and every extension that shares a grammar (`.js` `.jsx`
 * `.mjs` `.cjs` all share `javascript`) should pay that cost once, not once per call.
 * Cleared on failure for the same reason as `ensureInit` above.
 */
const languageCache = new Map<LanguageKey, Promise<Parser.Language>>()

function getLanguage(key: LanguageKey): Promise<Parser.Language> {
  let cached = languageCache.get(key)
  if (cached === undefined) {
    const wasmPath = join(resolveWasmDir(), GRAMMAR_FILE[key])
    cached = (async () => {
      await ensureInit()
      assertWasmFile(wasmPath, `parse ${key}`)
      return Parser.Language.load(wasmPath)
    })().catch((e) => {
      languageCache.delete(key)
      throw e
    })
    languageCache.set(key, cached)
  }
  return cached
}

/**
 * A node's name: its `name` field if the grammar gives it one (true for every
 * entry-producing node in all three languages here, including C#'s `property_declaration`
 * - "name field for property is `name`" per the language table), else the first child that
 * is itself an `identifier` or `type_identifier` (covers shapes a grammar may expose
 * without a named field), else the literal string `(anonymous)`.
 */
function extractName(node: Parser.SyntaxNode): string {
  const nameField = node.childForFieldName('name')
  if (nameField) return nameField.text
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (child && (child.type === 'identifier' || child.type === 'type_identifier')) {
      return child.text
    }
  }
  return '(anonymous)'
}

/**
 * Explicit-stack walk (no recursion limit surprises on a deeply nested or generated file).
 * `depth` increments only inside an entry-producing node's subtree - not for every node -
 * so scaffolding nodes (`program`, `class_body`, a Python `decorated_definition`, ...) are
 * transparent to indentation and can still be walked through to reach entries nested
 * inside them.
 *
 * Children are pushed in reverse so popping the stack still visits them in source order,
 * which is what makes the reported line numbers monotonically increase down the output.
 *
 * Entries are capped at `MAX_ENTRIES`; `total` keeps counting past the cap so the caller
 * can report how many were left out.
 */
function walk(root: Parser.SyntaxNode, table: Record<string, string>): { entries: OutlineEntry[]; total: number } {
  const entries: OutlineEntry[] = []
  let total = 0
  const stack: Array<{ node: Parser.SyntaxNode; depth: number }> = [{ node: root, depth: 0 }]

  while (stack.length > 0) {
    const top = stack.pop()!
    const { node, depth } = top
    const kind = table[node.type]
    let childDepth = depth
    if (kind !== undefined) {
      total++
      if (entries.length < MAX_ENTRIES) {
        entries.push({ kind, name: extractName(node), line: node.startPosition.row + 1, depth })
      }
      childDepth = depth + 1
    }
    for (let i = node.childCount - 1; i >= 0; i--) {
      const child = node.child(i)
      if (child) stack.push({ node: child, depth: childDepth })
    }
  }

  return { entries, total }
}

/**
 * Parse `source` (the contents of the file at `absPath`) and extract its outline.
 *
 * Returns `{ unsupported: ext }` rather than throwing when the extension has no grammar
 * mapped to it - this is an ordinary, expected outcome (the caller decides how to phrase
 * the refusal), not a failure of the tool.
 */
export async function outlineFile(
  absPath: string,
  source: string,
): Promise<OutlineEntry[] | { unsupported: string }> {
  const ext = extname(absPath).toLowerCase()
  const key = EXTENSION_TO_LANGUAGE[ext]
  if (key === undefined) return { unsupported: ext }

  const language = await getLanguage(key)
  const parser = new Parser()
  try {
    parser.setLanguage(language)
    const tree = parser.parse(source)
    try {
      const { entries, total } = walk(tree.rootNode, NODE_TABLE[key])
      if (total > MAX_ENTRIES) {
        entries.push({ kind: '...', name: `${total - MAX_ENTRIES} more`, line: 0, depth: 0 })
      }
      return entries
    } finally {
      tree.delete()
    }
  } finally {
    parser.delete()
  }
}
