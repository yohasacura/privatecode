// @vitest-environment happy-dom
import { render } from 'preact'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { TodoItem } from '@core/interaction'
import { TodosCard } from './approvals'

/**
 * The plan card's paths, mounted.
 *
 * `file-refs.test.ts` pins what counts as a path; this pins that the card actually asks —
 * the wiring is three props deep (Transcript → TodosCard → FileRefText) and every step of it
 * is the kind that type-checks perfectly while rendering flat text.
 */

let host: HTMLDivElement

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
})

afterEach(() => {
  render(null, host)
  host.remove()
})

function todo(text: string, status: TodoItem['status'] = 'pending'): TodoItem {
  return { text, status }
}

test('a path in a plan step is a chip that opens the file', () => {
  const opened: string[] = []
  render(
    <TodosCard
      todos={[todo('rewrite the insert in core/src/db/invoice.ts', 'in_progress')]}
      onOpenFile={(p) => opened.push(p)}
    />,
    host,
  )

  const chips = [...host.querySelectorAll('button.file-ref')]
  expect(chips.map((c) => c.textContent)).toEqual(['core/src/db/invoice.ts'])
  // The prose around it is untouched — the chip replaces the path, not the sentence.
  expect(host.querySelector('.todo-text')?.textContent).toContain('rewrite the insert in')

  ;(chips[0] as HTMLButtonElement).click()
  expect(opened).toEqual(['core/src/db/invoice.ts'])
})

test('without a handler the path is still marked, and is not a button', () => {
  // Which is what the collapsed header needs: it is itself a <button>, and a button inside a
  // button is not something a document may contain.
  render(<TodosCard todos={[todo('check app/src/App.css')]} />, host)
  expect(host.querySelectorAll('button.file-ref')).toHaveLength(0)
  expect(host.querySelector('span.file-ref')?.textContent).toBe('app/src/App.css')
})

test('a step with nothing to open renders as plain text', () => {
  render(<TodosCard todos={[todo('tune the plan so it gets marked')]} onOpenFile={() => {}} />, host)
  expect(host.querySelectorAll('.file-ref')).toHaveLength(0)
  expect(host.querySelector('.todo-text')?.textContent?.trim()).toBe('tune the plan so it gets marked')
})
