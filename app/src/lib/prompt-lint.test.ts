import { describe, expect, it } from 'vitest'
import { carryAcceptance, glueSuggestions, lintPrompt, taskShaped } from './prompt-lint'

const LONG_VAGUE =
  'Сделай пожалуйста нормальную обработку ошибок во всём проекте, и заодно посмотри почему ' +
  'иногда всё падает при запуске, хочется чтобы стало стабильнее и понятнее, и вообще наведи ' +
  'порядок там где это возможно, чтобы дальше было проще жить и развивать этот код.'

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
