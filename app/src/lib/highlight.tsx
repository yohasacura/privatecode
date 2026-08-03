import type { ComponentChildren } from 'preact'

/**
 * A deliberately tiny syntax highlighter: comments, strings, numbers, keywords. Nothing
 * else.
 *
 * Why not a real one: every off-the-shelf highlighter's API is "give me a string of HTML",
 * and this app's one hard UI rule (plan 4, Global Constraint 6) is that model-controlled
 * text never reaches an HTML sink. This produces Preact VNodes, so every fragment is a text
 * node Preact escapes — a code block cannot become markup no matter what the model writes.
 * It is also ~90 lines and zero dependencies, against ~1 MB of grammars for a level of
 * fidelity nobody reads chat code blocks closely enough to miss.
 */

const KEYWORDS = new Set([
  // shared control flow / declarations across the languages this tool actually sees
  'abstract', 'as', 'async', 'await', 'base', 'bool', 'break', 'byte', 'case', 'catch',
  'char', 'class', 'const', 'constructor', 'continue', 'debugger', 'declare', 'def',
  'default', 'delete', 'do', 'double', 'elif', 'else', 'enum', 'except', 'export',
  'extends', 'false', 'final', 'finally', 'float', 'fn', 'for', 'from', 'func', 'function',
  'get', 'global', 'go', 'if', 'impl', 'implements', 'import', 'in', 'instanceof', 'int',
  'interface', 'is', 'lambda', 'let', 'match', 'mod', 'mut', 'namespace', 'new', 'nil',
  'none', 'not', 'null', 'object', 'or', 'override', 'package', 'pass', 'private',
  'protected', 'pub', 'public', 'raise', 'readonly', 'record', 'ref', 'return', 'sealed',
  'self', 'set', 'static', 'string', 'struct', 'super', 'switch', 'this', 'throw', 'trait',
  'true', 'try', 'type', 'typeof', 'undefined', 'use', 'using', 'var', 'virtual', 'void',
  'when', 'where', 'while', 'with', 'yield',
])

/** Languages where a bare `#` starts a comment. Everywhere else it is a selector, a
 * preprocessor directive, or a fragment — never dimmed. */
const HASH_COMMENT_LANGS = new Set([
  'py', 'python', 'sh', 'bash', 'zsh', 'shell', 'ps1', 'powershell', 'yaml', 'yml',
  'toml', 'ruby', 'rb', 'r', 'makefile', 'dockerfile', 'ini', 'conf',
])

type Piece = { cls: string | null; text: string }

const PATTERN = new RegExp(
  [
    '(\\/\\/[^\\n]*)',                                  // 1 line comment
    '(\\/\\*[\\s\\S]*?\\*\\/)',                         // 2 block comment
    '(#[^\\n]*)',                                       // 3 hash comment (language-gated)
    '(\'(?:\\\\.|[^\'\\\\\\n])*\'' +
    '|"(?:\\\\.|[^"\\\\\\n])*"' +
    '|`(?:\\\\.|[^`\\\\])*`)',                          // 4 string
    '(\\b0[xXbB][0-9a-fA-F_]+\\b|\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)', // 5 number
    '([A-Za-z_$][A-Za-z0-9_$]*)',                       // 6 word
  ].join('|'),
  'g',
)

function tokenize(code: string, lang: string): Piece[] {
  const hashComments = HASH_COMMENT_LANGS.has(lang.toLowerCase())
  const pieces: Piece[] = []
  let last = 0
  PATTERN.lastIndex = 0

  for (let m = PATTERN.exec(code); m !== null; m = PATTERN.exec(code)) {
    const [whole, lineComment, blockComment, hashComment, str, num, word] = m
    let cls: string | null = null
    if (lineComment !== undefined || blockComment !== undefined) cls = 'hl-comment'
    else if (hashComment !== undefined) cls = hashComments ? 'hl-comment' : null
    else if (str !== undefined) cls = 'hl-string'
    else if (num !== undefined) cls = 'hl-number'
    else if (word !== undefined) cls = KEYWORDS.has(word) ? 'hl-keyword' : null

    if (cls === null) continue // leave it inside the surrounding plain run
    if (m.index > last) pieces.push({ cls: null, text: code.slice(last, m.index) })
    pieces.push({ cls, text: whole })
    last = m.index + whole.length
  }
  if (last < code.length) pieces.push({ cls: null, text: code.slice(last) })
  return pieces
}

/** Code in, an array of text nodes and `<span class="hl-…">` in, ready to drop into a
 * `<code>`. Never returns markup. */
export function highlight(code: string, lang = ''): ComponentChildren[] {
  return tokenize(code, lang).map((p, i) =>
    p.cls === null ? p.text : <span key={i} class={p.cls}>{p.text}</span>)
}
