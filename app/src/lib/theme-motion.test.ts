// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest'
import { applyLigatures, applyMotion, isMotionSetting } from './theme'

/** The two Appearance choices beside the theme: motion and the code font's ligatures. */
describe('motion', () => {
  test('recognises its three settings and nothing else', () => {
    expect(isMotionSetting('system')).toBe(true)
    expect(isMotionSetting('reduce')).toBe(true)
    expect(isMotionSetting('full')).toBe(true)
    expect(isMotionSetting('off')).toBe(false)
    expect(isMotionSetting(undefined)).toBe(false)
  })

  test('stamps the root for a choice and clears it for "system", so the media query decides', () => {
    const root = document.createElement('html')
    applyMotion('reduce', root)
    expect(root.getAttribute('data-motion')).toBe('reduce')
    applyMotion('full', root)
    expect(root.getAttribute('data-motion')).toBe('full')
    applyMotion('system', root)
    expect(root.hasAttribute('data-motion')).toBe(false)
    expect(() => applyMotion('reduce', null)).not.toThrow()
  })
})

describe('ligatures', () => {
  test('off is a stamp, on is the absence of one', () => {
    const root = document.createElement('html')
    applyLigatures(false, root)
    expect(root.getAttribute('data-ligatures')).toBe('off')
    applyLigatures(true, root)
    expect(root.hasAttribute('data-ligatures')).toBe(false)
    expect(() => applyLigatures(true, null)).not.toThrow()
  })
})
