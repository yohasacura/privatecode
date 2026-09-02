import type { VNode } from 'preact'

/**
 * The icon set, as inline SVG.
 *
 * No icon font and no sprite URL: this app must work with the network unplugged and with a
 * CSP that forbids remote anything, and an emoji set renders differently on every machine.
 * Each icon is a 16×16 stroked path on `currentColor`, so a caller styles it by setting
 * `color` — the same way text is styled.
 */

function Svg({ children, size = 16 }: { children: preact.ComponentChildren; size?: number }): VNode {
  return (
    <svg
      class="icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

/** The states a changed file can be in, as the tree marks them. */
export type GitMarkKind = 'M' | 'A' | 'U' | 'D' | 'R' | '!'

/**
 * One git status mark: a rounded square carrying the symbol for its state.
 *
 * A square per state rather than a letter, because a column of letters is a column of
 * words to read, while a column of squares is a shape the eye scans — the same reason
 * every editor's SCM gutter uses glyphs. The symbols are the diff vocabulary people
 * already know: a dot for modified, `+` for added, `−` for deleted, an arrow for renamed,
 * `!` for a conflict.
 *
 * STAGED fills the square and knocks the symbol out of it. That keeps the
 * Changes/Staged distinction as a difference in WEIGHT, visible at a glance across a long
 * list, without a second column or a second colour: an outline is work you have done, a
 * solid is work the next commit will carry.
 */
function gitMark(kind: GitMarkKind, staged: boolean): VNode {
  // The knockout colour is the panel's own background, so a filled mark reads as a hole
  // in the square rather than as a differently-coloured glyph.
  const on = staged ? 'var(--bg-panel)' : 'currentColor'
  return (
    <svg
      class="icon"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect x="2.2" y="2.2" width="11.6" height="11.6" rx="3.2" {...(staged ? { fill: 'currentColor' } : {})} />
      {kind === 'M' && <circle cx="8" cy="8" r="1.9" fill={on} stroke="none" />}
      {(kind === 'A' || kind === 'U') && <path d="M8 5.2v5.6M5.2 8h5.6" stroke={on} />}
      {kind === 'D' && <path d="M5.2 8h5.6" stroke={on} />}
      {kind === 'R' && <path d="M5 8h4.6M8.2 6.2 10 8l-1.8 1.8" stroke={on} />}
      {kind === '!' && <path d="M8 4.9v4M8 11.1v.01" stroke={on} />}
    </svg>
  )
}

export const Icon = {
  plus: () => <Svg><path d="M8 3v10M3 8h10" /></Svg>,
  minus: () => <Svg><path d="M3 8h10" /></Svg>,
  gitMark,
  /** Two dots on one line, one budding off: a branch. The commit box wears it. */
  branch: () => (
    <Svg>
      <circle cx="4.5" cy="3.8" r="1.7" />
      <circle cx="4.5" cy="12.2" r="1.7" />
      <circle cx="11.5" cy="5.8" r="1.7" />
      <path d="M4.5 5.5v5M11.5 7.5c0 2.6-3.4 2.3-5.6 3.4" />
    </Svg>
  ),
  send: () => <Svg><path d="M2.5 8h10M8.5 3.5 13 8l-4.5 4.5" /></Svg>,
  stop: () => <Svg><rect x="4" y="4" width="8" height="8" rx="1.5" /></Svg>,
  chat: () => <Svg><path d="M13.5 9.5A2.5 2.5 0 0 1 11 12H6l-3.5 2.5V4A2.5 2.5 0 0 1 5 1.5h6A2.5 2.5 0 0 1 13.5 4z" /></Svg>,
  files: () => <Svg><path d="M2.5 4.5A1.5 1.5 0 0 1 4 3h2.2l1.3 1.6H12a1.5 1.5 0 0 1 1.5 1.5v5.4A1.5 1.5 0 0 1 12 13H4a1.5 1.5 0 0 1-1.5-1.5z" /></Svg>,
  file: () => <Svg><path d="M4 2h4.5L12 5.5V14H4z" /><path d="M8.5 2v3.5H12" /></Svg>,
  folder: () => <Svg><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2l1.3 1.6h5.7A1.5 1.5 0 0 1 14 6.1v5.4A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z" /></Svg>,
  /** Two opposed arrows: exchanging one thing for another. The workspace switcher. */
  swap: () => <Svg><path d="M2.5 5h8.5M8.5 2.5 11 5l-2.5 2.5M13.5 11H5M7.5 8.5 5 11l2.5 2.5" /></Svg>,
  diff: () => <Svg><path d="M4 2.5v11M2 4.5h4M2 11.5h4M10 2.5v11M8 7h4" /></Svg>,
  terminal: () => <Svg><path d="M3 4l3 3-3 3M8.5 11H13" /><rect x="1.5" y="1.5" width="13" height="13" rx="2" /></Svg>,
  jobs: () => <Svg><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3.2l2 1.3" /></Svg>,
  /** A clock with an arrow going back: history, and specifically the ability to return to it. */
  history: () => (
    <Svg>
      <path d="M2.5 8a5.5 5.5 0 1 0 1.9-4.2" />
      <path d="M2 2.2v2.6h2.6" />
      <path d="M8 5.2V8l2 1.3" />
    </Svg>
  ),
  chevronRight: () => <Svg><path d="M6 3.5 10.5 8 6 12.5" /></Svg>,
  chevronDown: () => <Svg><path d="M3.5 6 8 10.5 12.5 6" /></Svg>,
  check: () => <Svg><path d="M3 8.5 6.5 12 13 4.5" /></Svg>,
  x: () => <Svg><path d="M4 4l8 8M12 4l-8 8" /></Svg>,
  alert: () => <Svg><path d="M8 2.5 14.5 13.5h-13z" /><path d="M8 6.5v3M8 11.5v.01" /></Svg>,
  brain: () => <Svg><path d="M6 2.5a2 2 0 0 0-2 2 2 2 0 0 0-1 3.6A2 2 0 0 0 4.5 12 2 2 0 0 0 8 13V3a2 2 0 0 0-2-.5z" /><path d="M10 2.5a2 2 0 0 1 2 2 2 2 0 0 1 1 3.6A2 2 0 0 1 11.5 12 2 2 0 0 1 8 13" /></Svg>,
  gear: () => <Svg><circle cx="8" cy="8" r="2.2" /><path d="M8 1.6v1.6M8 12.8v1.6M14.4 8h-1.6M3.2 8H1.6M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1M12.5 12.5l-1.1-1.1M4.6 4.6 3.5 3.5" /></Svg>,
  sidebar: () => <Svg><rect x="1.5" y="2.5" width="13" height="11" rx="2" /><path d="M6 2.5v11" /></Svg>,
  panelRight: () => <Svg><rect x="1.5" y="2.5" width="13" height="11" rx="2" /><path d="M10 2.5v11" /></Svg>,
  // The window's own controls, at Windows' 10px glyph size (see .win-btn).
  winMin: () => <Svg><path d="M2 8h12" /></Svg>,
  winMax: () => <Svg><rect x="2.5" y="2.5" width="11" height="11" rx="1" /></Svg>,
  winRestore: () => <Svg><rect x="2.5" y="5" width="8.5" height="8.5" rx="1" /><path d="M5 5V3.5A1 1 0 0 1 6 2.5h6.5a1 1 0 0 1 1 1V10a1 1 0 0 1-1 1H11" /></Svg>,
  winClose: () => <Svg><path d="M3 3l10 10M13 3 3 13" /></Svg>,
  arrowDown: () => <Svg><path d="M8 3v10M4 9l4 4 4-4" /></Svg>,
  arrowLeft: () => <Svg><path d="M13 8H3M7 4 3 8l4 4" /></Svg>,
  /** A line that turns back on itself: wrapping. */
  wrap: () => <Svg><path d="M2.5 4h11M2.5 12h4M2.5 8h9a2 2 0 1 1 0 4h-1.5" /><path d="M8 10.5 6.5 12 8 13.5" /></Svg>,
  refresh: () => <Svg><path d="M13.5 8a5.5 5.5 0 1 1-1.7-4" /><path d="M13.5 2.5V6H10" /></Svg>,
  play: () => <Svg><path d="M5 3.5 12 8l-7 4.5z" /></Svg>,
  shield: () => <Svg><path d="M8 1.8 13 3.6v4.1c0 3-2.1 5.6-5 6.5-2.9-.9-5-3.5-5-6.5V3.6z" /></Svg>,
  search: () => <Svg><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></Svg>,
  trash: () => <Svg><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.2A1 1 0 0 0 5.7 14h4.6a1 1 0 0 0 1-.8L12 4" /></Svg>,
}
