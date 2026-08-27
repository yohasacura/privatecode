import { describe, expect, it } from 'vitest'
import { presentTool, screenshotPathOf } from './tools'

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
    expect(presentTool('browser', '{"action":"open","url":"http://localhost:5173/"}'))
      .toMatchObject({ verb: 'Browser open', target: 'http://localhost:5173/' })
  })

  it('shows the ref for a click, and the expression for an eval', () => {
    expect(presentTool('browser', '{"action":"click","ref":3}').target).toBe('ref_3')
    expect(presentTool('browser', '{"action":"eval","expression":"document.title"}').target)
      .toBe('document.title')
  })

  it('does not show what was typed, only where', () => {
    // A fill can carry a password the user pasted in; the ref says enough.
    expect(presentTool('browser', '{"action":"fill","ref":1,"text":"hunter2"}').target)
      .toBe('ref_1')
  })

  it('is not a file operation, so it never claims a path', () => {
    expect(presentTool('browser', '{"action":"screenshot"}').path).toBeNull()
  })
})

describe('the search family', () => {
  it('shows the glob a find_files call searched for', () => {
    // `glob` is find_files' only argument; the presenter used to look for pattern/query/path
    // and find none of them, so every Find row was a bare verb with nothing after it.
    const p = presentTool('find_files', '{"glob":"src/**/*.ts"}')
    expect(p).toMatchObject({ verb: 'Find', target: 'src/**/*.ts', path: null })
  })

  it('shows the regex a scoped search ran, and where it ran', () => {
    const p = presentTool('search_code', '{"pattern":"presentTool","path":"app/src/panels"}')
    // The pattern first: the scope alone (what `path ?? pattern` produced) never said what
    // was being looked for.
    expect(p.target).toBe('presentTool in app/src/panels')
    expect(presentTool('search_code', '{"pattern":"presentTool"}').target).toBe('presentTool')
  })

  it('offers no file to open for the tools whose path is a directory', () => {
    // The transcript renders its "Open file" button on any non-null path, and opening a
    // directory as a file answers "… is a directory; use fs.tree" — a tab whose only content
    // is that error.
    expect(presentTool('list_dir', '{"path":"app/src/panels"}'))
      .toMatchObject({ verb: 'List', target: 'app/src/panels', path: null })
    expect(presentTool('search_code', '{"pattern":"x","path":"app/src"}').path).toBeNull()
    // A file the model asked to READ is still openable — that is the button's real case.
    expect(presentTool('read_file', '{"path":"app/src/lib/tools.ts"}').path)
      .toBe('app/src/lib/tools.ts')
  })

  it('names the row even when the arguments never finished streaming', () => {
    // A card opens on the tool NAME, mid-generation, with args that are not yet valid JSON.
    expect(presentTool('find_files', '{"glob":"src/**').target).toBe('')
    expect(presentTool('list_dir', '{"pa').verb).toBe('List')
  })
})

describe('screenshotPathOf', () => {
  it('recognises exactly what the screenshot action writes', () => {
    expect(screenshotPathOf('browser', '.privatecode/state/browser/shot-001.png'))
      .toBe('.privatecode/state/browser/shot-001.png')
  })

  it('ignores prose that merely names a screenshot', () => {
    // The tool's own `content` and the model's answer both mention the path. Matching
    // loosely would turn any message that talks ABOUT a screenshot into an image.
    expect(screenshotPathOf('browser', 'Screenshot saved to .privatecode/state/browser/shot-001.png for the user'))
      .toBeNull()
  })

  it('is scoped to the browser tool and to that directory', () => {
    expect(screenshotPathOf('read_file', '.privatecode/state/browser/shot-001.png')).toBeNull()
    expect(screenshotPathOf('browser', 'assets/logo.png')).toBeNull()
    expect(screenshotPathOf('browser', '.privatecode/state/logs/run.log')).toBeNull()
    expect(screenshotPathOf('browser', undefined)).toBeNull()
  })
})

it('labels a run_command card from a LIST of commands, and still from a string', () => {
  // The tool takes a list now — that shape is what stops the model writing `&&` for a shell
  // that has none — and a card built from `args.command` alone went blank. The string form
  // stays because every session recorded before the change replays through this same
  // function.
  const fromList = presentTool('run_command', JSON.stringify({
    commands: ['npm install', 'npm test'],
  }))
  expect(fromList.target).toBe('npm install; npm test')

  const fromString = presentTool('run_command', JSON.stringify({ command: 'git status' }))
  expect(fromString.target).toBe('git status')
})
