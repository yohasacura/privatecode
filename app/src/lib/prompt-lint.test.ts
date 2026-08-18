import { describe, expect, it } from 'vitest'
import { carryAcceptance, commandShaped, glueSuggestions, lintPrompt, taskShaped } from './prompt-lint'

const LONG_VAGUE =
  'Сделай пожалуйста нормальную обработку ошибок во всём проекте, и заодно посмотри почему ' +
  'иногда всё падает при запуске, хочется чтобы стало стабильнее и понятнее, и вообще наведи ' +
  'порядок там где это возможно, чтобы дальше было проще жить и развивать этот код.'

describe('commandShaped — the expander\'s input gate', () => {
  it('matches a rough imperative command in either language', () => {
    expect(commandShaped('сделай красную кнопку в шапке')).toBe(true)
    expect(commandShaped('кнопку в шапке сделай красной')).toBe(true)
    expect(commandShaped('fix the login redirect loop')).toBe(true)
  })

  it('stays out of questions, reports and chatter', () => {
    // «сделать» is not an imperative — a question about how is not an order to do.
    expect(commandShaped('как сделать красную кнопку?')).toBe(false)
    expect(commandShaped('я вчера добавил кнопку и всё сломалось')).toBe(false)
    expect(commandShaped('спасибо, отличная работа')).toBe(false)
    // A `?` anywhere is a question, whatever vocabulary it uses.
    expect(commandShaped('сделай красную кнопку?')).toBe(false)
  })

  it('does not mistake English nouns and CLI names for orders', () => {
    // English has no imperative form, so a verb counts only when it OPENS the draft
    // and is followed by a Latin word — reports about fix/build/update stay out.
    expect(commandShaped('how do I make a red button')).toBe(false)
    expect(commandShaped('did the fix work')).toBe(false)
    expect(commandShaped('npm run build падает с ошибкой')).toBe(false)
    expect(commandShaped('этот fix не помог, стало хуже')).toBe(false)
    expect(commandShaped('что делает git add -p ?')).toBe(false)
    expect(commandShaped('fix-login.ts глянь пожалуйста')).toBe(false)
    expect(commandShaped('make выдаёт ошибку линкера')).toBe(false)
    expect(commandShaped('посмотри на add_user.py, почему падает')).toBe(false)
  })

  it('leaves the ends of the spectrum to their own tools', () => {
    // Too short to mean anything; long enough that the chips distiller owns it.
    expect(commandShaped('сделай')).toBe(false)
    expect(commandShaped(`сделай так: ${'подробности '.repeat(20)}`)).toBe(false)
  })
})

describe('prompt lint', () => {
  it('a short message is not a task and gets no hints', () => {
    expect(taskShaped('поправь отступы')).toBe(false)
    expect(lintPrompt('поправь отступы')).toEqual([])
  })

  it('a long vague draft earns all three hints', () => {
    const hints = lintPrompt(LONG_VAGUE)
    expect(hints).toHaveLength(3)
    expect(hints[0]).toMatch(/файл/)
    expect(hints[1]).toMatch(/готовности/)
    expect(hints[2]).toMatch(/ограничени/)
  })

  it('each hint disappears the moment the draft covers the point', () => {
    expect(lintPrompt(`${LONG_VAGUE} Начни с src/boot.ts.`)).toHaveLength(2)
    expect(lintPrompt(`${LONG_VAGUE} Готово, когда все тесты проходят.`)).toEqual([
      'Не назван ни один файл — агент будет искать сам',
      'Нет ограничений — агент сам решит, что можно трогать',
    ])
    expect(lintPrompt(`${LONG_VAGUE} Тесты в tests/app.test.ts должны проходить, не трогай публичный API.`))
      .toEqual([])
  })
})

describe('glueSuggestions', () => {
  const s = {
    criteria: ['tests/a.test.ts проходит', 'экспорт обновлён'],
    constraints: ['не менять greet()'],
    questions: ['Какие файлы затронуть?', 'Что считается готовым?'],
  }

  it('appends accepted structure below the draft, words untouched', () => {
    const out = glueSuggestions('Сделай greetMany.', s,
      new Set(['c:tests/a.test.ts проходит', 'k:не менять greet()']),
      new Map([['Какие файлы затронуть?', 'src/greet.js']]))
    expect(out).toBe(
      'Сделай greetMany.\n\nКритерии готовности:\n1. tests/a.test.ts проходит\n\n' +
      'Ограничения:\n- не менять greet()\n\nУточнения:\n- Какие файлы затронуть — src/greet.js')
  })

  it('unchecked chips and unanswered questions do not travel', () => {
    expect(glueSuggestions('Черновик.', s, new Set(), new Map())).toBe('Черновик.')
  })
})

describe('carryAcceptance', () => {
  const prev = { criteria: ['a', 'b'], constraints: ['x'], questions: ['q?'] }

  it('keeps the user\'s unchecks and answers for chips that came back verbatim', () => {
    const next = { criteria: ['a', 'c'], constraints: ['x'], questions: ['q?', 'w?'] }
    const out = carryAcceptance(next, prev, new Set(['c:a']), new Map([['q?', 'да']]))
    // 'a' was known and checked -> stays; 'c' is new -> default checked;
    // 'x' was known and UNchecked -> stays unchecked.
    expect(out.accepted.has('c:a')).toBe(true)
    expect(out.accepted.has('c:c')).toBe(true)
    expect(out.accepted.has('k:x')).toBe(false)
    expect(out.answers.get('q?')).toBe('да')
    expect(out.answers.has('w?')).toBe(false)
  })

  it('with no previous round everything arrives in the default state', () => {
    const out = carryAcceptance(prev, null, new Set(), new Map())
    expect(out.accepted.size).toBe(3)
    expect(out.answers.size).toBe(0)
  })
})

describe('the softer lint gate', () => {
  it('a 120+ char two-sentence task gets hints the strict gate would miss', () => {
    const draft = 'Сделай нормальную обработку ошибок в проекте, всё падает некрасиво. ' +
      'Хочется чтобы при любых сбоях выводилось понятное сообщение и код жил дальше.'
    expect(taskShaped(draft)).toBe(false)
    expect(lintPrompt(draft).length).toBeGreaterThan(0)
  })
})
