import { describe, expect, it } from 'vitest'
import { presentTool } from './tools'

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
