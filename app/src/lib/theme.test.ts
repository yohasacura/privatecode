// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest'
import { applyTheme, isThemeSetting, resolveTheme, systemPrefersDark, watchSystemTheme } from './theme'

/**
 * The theme decision, without a browser: what the setting means, what happens when the
 * OS cannot be asked, and that following the OS can be stopped.
 */

describe('resolving the setting', () => {
  test('dark and light are themselves whatever the OS says', () => {
    expect(resolveTheme('dark', false)).toBe('dark')
    expect(resolveTheme('light', true)).toBe('light')
  })

  test('system follows the OS', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })

  test('only the three settings are settings', () => {
    expect(isThemeSetting('system')).toBe(true)
    expect(isThemeSetting('dark')).toBe(true)
    expect(isThemeSetting('light')).toBe(true)
    expect(isThemeSetting('auto')).toBe(false)
    expect(isThemeSetting(undefined)).toBe(false)
  })
})

describe('asking the OS', () => {
  test('answers dark when there is nothing to ask — the theme every screen was drawn in', () => {
    expect(systemPrefersDark(null)).toBe(true)
    expect(systemPrefersDark({} as unknown as Window)).toBe(true)
    expect(systemPrefersDark({ matchMedia: () => { throw new Error('no') } } as unknown as Window)).toBe(true)
  })

  test('reads the media query when there is one', () => {
    const win = { matchMedia: (q: string) => ({ matches: q.includes('dark') }) } as unknown as Window
    expect(systemPrefersDark(win)).toBe(true)
  })

  test('following the OS can be stopped, and a window without matchMedia is a no-op', () => {
    const listeners: ((e: { matches: boolean }) => void)[] = []
    const win = {
      matchMedia: () => ({
        matches: true,
        addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.push(fn),
        removeEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.splice(listeners.indexOf(fn), 1),
      }),
    } as unknown as Window
    const seen: boolean[] = []
    const stop = watchSystemTheme((dark) => seen.push(dark), win)
    listeners[0]!({ matches: false })
    expect(seen).toEqual([false])
    stop()
    expect(listeners).toHaveLength(0)
    expect(() => watchSystemTheme(() => {}, {} as unknown as Window)()).not.toThrow()
  })
})

describe('applying', () => {
  test('stamps the root element and the colour scheme', () => {
    const root = document.createElement('html')
    applyTheme('light', root)
    expect(root.getAttribute('data-theme')).toBe('light')
    expect(root.style.getPropertyValue('color-scheme')).toBe('light')
    applyTheme('dark', root)
    expect(root.getAttribute('data-theme')).toBe('dark')
  })

  test('a missing root is nothing to do', () => {
    expect(() => applyTheme('dark', null)).not.toThrow()
  })
})
