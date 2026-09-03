'use strict'
/**
 * The design system: canvas, palettes and type. Every layout draws from here, which is what
 * keeps a deck consistent from slide to slide, and what lets the one `theme` word in a spec
 * restyle the whole deck.
 *
 * The palettes follow one rule: a dominant dark, one accent, a supporting mid-tone, a light
 * paper for content slides. Title, section, quote and closing slides sit on the dark; content
 * sits on the paper. No decorative bars or stripes anywhere — a tint, a shadow or a badge is
 * how a block is set apart.
 */

const W = 13.333
const H = 7.5
const M = 0.62
const CW = W - 2 * M

/** Where the footer sits, and the lowest edge content may reach with and without a callout. */
const FOOTER_Y = H - 0.46
const CALLOUT_Y = H - 1.18
const CALLOUT_H = 0.56
const BOTTOM = H - 0.72
const BOTTOM_WITH_CALLOUT = CALLOUT_Y - 0.18

const THEMES = {
  midnight: {
    label: 'navy with amber — analytical, corporate, history',
    fonts: { head: 'Cambria', body: 'Calibri' },
    colors: {
      dark: '1B2A49', darker: '12203A', darkCard: '24365A',
      accent: 'E0A526', accentSoft: 'F3C96B',
      support: '2E5A84', supportSoft: '7FA8C9',
      paper: 'F3F5F8', ink: '1B2430', mute: '5A6675', rule: 'D6DCE4',
      tint: 'E9EEF4', tint2: 'DCE5EF',
      onDark: 'D6E1EE', onDarkMute: '8FA3BA', white: 'FFFFFF',
    },
  },
  forest: {
    label: 'deep green with gold — nature, sustainability, agriculture, calm',
    fonts: { head: 'Century Schoolbook', body: 'Calibri' },
    colors: {
      dark: '1F3D2B', darker: '15301F', darkCard: '2A4D37',
      accent: 'C9A227', accentSoft: 'E4C866',
      support: '4E7D5B', supportSoft: '9BC0A4',
      paper: 'F4F6F2', ink: '1E2A22', mute: '5B6B60', rule: 'D5DED6',
      tint: 'E8EFE8', tint2: 'DCE7DD',
      onDark: 'D8E4DA', onDarkMute: '93AB98', white: 'FFFFFF',
    },
  },
  coral: {
    label: 'indigo with coral — product, marketing, startups, energy',
    fonts: { head: 'Calibri', body: 'Calibri' },
    colors: {
      dark: '2F3C7E', darker: '232D62', darkCard: '3B4A96',
      accent: 'F96167', accentSoft: 'FFA5A8',
      support: '4E5BA6', supportSoft: '9AA6D8',
      paper: 'F7F7FA', ink: '23263A', mute: '5C6078', rule: 'DCDCE6',
      tint: 'EEEFF6', tint2: 'E3E5F1',
      onDark: 'D9DDF0', onDarkMute: '9AA3CF', white: 'FFFFFF',
    },
  },
  slate: {
    label: 'charcoal with vermilion — engineering, technology, minimal',
    fonts: { head: 'Arial', body: 'Arial' },
    colors: {
      dark: '2B3038', darker: '1F2329', darkCard: '3A414B',
      accent: 'E4572E', accentSoft: 'F2A184',
      support: '55606E', supportSoft: '9AA5B1',
      paper: 'F5F6F7', ink: '1F2429', mute: '5F6975', rule: 'D9DDE2',
      tint: 'EBEDF0', tint2: 'E0E3E7',
      onDark: 'D9DDE2', onDarkMute: '9AA3AD', white: 'FFFFFF',
    },
  },
  ocean: {
    label: 'deep blue with gold — finance, logistics, science, trust',
    fonts: { head: 'Cambria', body: 'Calibri' },
    colors: {
      dark: '0B3C5D', darker: '072B43', darkCard: '134E74',
      accent: 'F2A900', accentSoft: 'FFD166',
      support: '1C7293', supportSoft: '7FB7C9',
      paper: 'F2F6F8', ink: '142B3A', mute: '52697A', rule: 'D3DEE5',
      tint: 'E5EEF3', tint2: 'D8E6ED',
      onDark: 'D2E2EC', onDarkMute: '86A6BA', white: 'FFFFFF',
    },
  },
  berry: {
    label: 'plum with raspberry — culture, education, lifestyle, humanities',
    fonts: { head: 'Bookman Old Style', body: 'Calibri' },
    colors: {
      dark: '4A1F35', darker: '36162A', darkCard: '5E2C46',
      accent: 'C9455E', accentSoft: 'F0A6B4',
      support: '7E4B62', supportSoft: 'B58AA0',
      paper: 'F8F5F6', ink: '2A1B22', mute: '6A5560', rule: 'E3D9DE',
      tint: 'F1E9ED', tint2: 'E8DCE3',
      onDark: 'EAD9E0', onDarkMute: 'B392A2', white: 'FFFFFF',
    },
  },
}

/** Fonts whose glyphs run wider than Calibri's; the measurer scales them up. */
const SERIF = new Set(['Cambria', 'Century Schoolbook', 'Bookman Old Style', 'Georgia', 'Times New Roman', 'Garamond', 'Palatino Linotype'])

/**
 * The resolved theme for a deck: palette, fonts (with the spec's overrides), chart colours,
 * and the geometry — one object handed to every layout.
 */
function resolveTheme(name, overrides = {}) {
  const base = THEMES[name]
  if (base === undefined) throw new Error(`unknown theme "${name}"; one of ${Object.keys(THEMES).join(', ')}`)
  const fonts = { ...base.fonts, ...(overrides.head ? { head: overrides.head } : {}), ...(overrides.body ? { body: overrides.body } : {}) }
  const c = { ...base.colors, ...(overrides.accent ? { accent: overrides.accent } : {}) }
  return {
    name,
    fonts,
    headSerif: SERIF.has(fonts.head),
    bodySerif: SERIF.has(fonts.body),
    c,
    chartColors: [c.accent, c.support, c.supportSoft, c.dark, c.accentSoft, c.mute],
    W, H, M, CW, FOOTER_Y, CALLOUT_Y, CALLOUT_H, BOTTOM, BOTTOM_WITH_CALLOUT,
  }
}

module.exports = { THEMES, resolveTheme, W, H, M, CW, FOOTER_Y, CALLOUT_Y, CALLOUT_H, BOTTOM, BOTTOM_WITH_CALLOUT }
