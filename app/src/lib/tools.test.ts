import { describe, expect, it } from 'vitest'
import { presentTool, screenshotPathOf, toolName, WRITE_TOOLS } from './tools'

/**
 * How the two new tool families read in the transcript.
 *
 * The registered name is built for the permission rule language (`mcp__sqlite__query`), not
 * for a person. What a reader needs is which server answered and what it was asked.
 */

describe('MCP tools', () => {
  it('shows the server and the tool, not the wire name', () => {
    const p = presentTool('mcp__sqlite__query', '{"sql":"select 1"}')
    expect(p.verb).toBe('sqlite')
    expect(p.target).toBe('query: select 1')
    // Nothing about an MCP call names a workspace path, so the card is not clickable.
    expect(p.path).toBeNull()
  })

  it('survives a tool with no string arguments', () => {
    expect(presentTool('mcp__notes__list', '{"limit":10}').target).toBe('list')
  })

  it('survives a malformed name rather than rendering an empty row', () => {
    expect(presentTool('mcp__lonely', '{}').verb).toBe('lonely')
  })
})

describe('the browser tool', () => {
  it('names the action, because one tool does eleven different things', () => {
    expect(presentTool('Browser', '{"action":"open","url":"http://localhost:5173/"}'))
      .toMatchObject({ verb: 'Browser open', target: 'http://localhost:5173/' })
  })

  it('shows the ref for a click, and the expression for an eval', () => {
    expect(presentTool('Browser', '{"action":"click","ref":3}').target).toBe('ref_3')
    expect(presentTool('Browser', '{"action":"eval","expression":"document.title"}').target)
      .toBe('document.title')
  })

  it('does not show what was typed, only where', () => {
    // A fill can carry a password the user pasted in; the ref says enough.
    expect(presentTool('Browser', '{"action":"fill","ref":1,"text":"hunter2"}').target)
      .toBe('ref_1')
  })

  it('is not a file operation, so it never claims a path', () => {
    expect(presentTool('Browser', '{"action":"screenshot"}').path).toBeNull()
  })
})

describe('the search family', () => {
  it('shows the glob a Glob call searched for', () => {
    // `glob` is Glob' only argument; the presenter used to look for pattern/query/path
    // and find none of them, so every Find row was a bare verb with nothing after it.
    const p = presentTool('Glob', '{"glob":"src/**/*.ts"}')
    expect(p).toMatchObject({ verb: 'Find', target: 'src/**/*.ts', path: null })
  })

  it('shows the regex a scoped search ran, and where it ran', () => {
    const p = presentTool('Grep', '{"pattern":"presentTool","path":"app/src/panels"}')
    // The pattern first: the scope alone (what `path ?? pattern` produced) never said what
    // was being looked for.
    expect(p.target).toBe('presentTool in app/src/panels')
    expect(presentTool('Grep', '{"pattern":"presentTool"}').target).toBe('presentTool')
  })

  it('offers no file to open for the tools whose path is a directory', () => {
    // The transcript renders its "Open file" button on any non-null path, and opening a
    // directory as a file answers "… is a directory; use fs.tree" — a tab whose only content
    // is that error.
    expect(presentTool('LS', '{"path":"app/src/panels"}'))
      .toMatchObject({ verb: 'List', target: 'app/src/panels', path: null })
    expect(presentTool('Grep', '{"pattern":"x","path":"app/src"}').path).toBeNull()
    // A file the model asked to READ is still openable — that is the button's real case.
    expect(presentTool('Read', '{"path":"app/src/lib/tools.ts"}').path)
      .toBe('app/src/lib/tools.ts')
  })

  it('names the row even when the arguments never finished streaming', () => {
    // A card opens on the tool NAME, mid-generation, with args that are not yet valid JSON.
    expect(presentTool('Glob', '{"glob":"src/**').target).toBe('')
    expect(presentTool('LS', '{"pa').verb).toBe('List')
  })
})

describe('screenshotPathOf', () => {
  it('recognises exactly what the screenshot action writes', () => {
    expect(screenshotPathOf('Browser', '.privatecode/state/browser/shot-001.png'))
      .toBe('.privatecode/state/browser/shot-001.png')
  })

  it('ignores prose that merely names a screenshot', () => {
    // The tool's own `content` and the model's answer both mention the path. Matching
    // loosely would turn any message that talks ABOUT a screenshot into an image.
    expect(screenshotPathOf('Browser', 'Screenshot saved to .privatecode/state/browser/shot-001.png for the user'))
      .toBeNull()
  })

  it('is scoped to the browser tool and to that directory', () => {
    expect(screenshotPathOf('Read', '.privatecode/state/browser/shot-001.png')).toBeNull()
    expect(screenshotPathOf('Browser', 'assets/logo.png')).toBeNull()
    expect(screenshotPathOf('Browser', '.privatecode/state/logs/run.log')).toBeNull()
    expect(screenshotPathOf('Browser', undefined)).toBeNull()
  })
})

it('labels a Bash card from a LIST of commands, and still from a string', () => {
  // The tool takes a list now — that shape is what stops the model writing `&&` for a shell
  // that has none — and a card built from `args.command` alone went blank. The string form
  // stays because every session recorded before the change replays through this same
  // function.
  const fromList = presentTool('Bash', JSON.stringify({
    commands: ['npm install', 'npm test'],
  }))
  expect(fromList.target).toBe('npm install; npm test')

  const fromString = presentTool('Bash', JSON.stringify({ command: 'git status' }))
  expect(fromString.target).toBe('git status')
})

describe('the names a recorded session may carry', () => {
  it('resolve to the tool they became, both rounds of renames', () => {
    expect(toolName('read_file')).toBe('Read')
    expect(toolName('list_dir')).toBe('LS')
    expect(toolName('move_file')).toBe('MoveFile')
    expect(toolName('background_task')).toBe('TaskOutput')
    expect(toolName('browser')).toBe('Browser')
    expect(toolName('plugins')).toBe('Plugin')
    expect(toolName('TaskStop')).toBe('TaskStop')
  })
  it('still count an old write as a write', () => {
    for (const name of ['edit_file', 'write_file', 'move_file', 'delete_file', 'Edit', 'Write', 'MoveFile', 'DeleteFile']) {
      expect(WRITE_TOOLS.has(name), name).toBe(true)
    }
  })
  it('presents the background pair by the task id', () => {
    expect(presentTool('TaskOutput', '{"id":"task-3","wait_seconds":5}')).toMatchObject({ kind: 'command', verb: 'Poll', target: 'task-3' })
    expect(presentTool('TaskStop', '{"id":"task-3"}')).toMatchObject({ verb: 'Stop', target: 'task-3' })
    expect(presentTool('background_task', '{"action":"poll","id":"task-3"}').target).toBe('task-3')
  })
})
