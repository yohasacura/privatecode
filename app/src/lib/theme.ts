/**
 * Which of the two themes the window shows, and how that is decided.
 *
 * Three settings, as the platform has them: `system` follows Windows and changes live when
 * Windows does; `dark` and `light` are the person's own choice. The setting lives in
 * `ui.json` beside the server URL (host `config.get` / `config.set`); this module never
 * reads it — it is handed the setting and applies it. Everything here is pure or takes its
 * document so it can be tested without a browser. See docs/UI-REDESIGN-2026-09.md §1.
 */

export type ThemeSetting = 'system' | 'dark' | 'light'
export type Theme = 'dark' | 'light'

export const THEME_SETTINGS: readonly ThemeSetting[] = ['system', 'dark', 'light']

export function isThemeSetting(value: unknown): value is ThemeSetting {
  return typeof value === 'string' && (THEME_SETTINGS as readonly string[]).includes(value)
}

/** What the setting means right now, given what the OS prefers. */
export function resolveTheme(setting: ThemeSetting, systemPrefersDark: boolean): Theme {
  if (setting === 'dark' || setting === 'light') return setting
  return systemPrefersDark ? 'dark' : 'light'
}

/**
 * The OS preference, or dark when it cannot be asked (a test document, an old webview):
 * dark is the theme every screen was drawn in first, so it is the safe answer.
 */
export function systemPrefersDark(win: Pick<Window, 'matchMedia'> | null = globalThis.window ?? null): boolean {
  try {
    return win?.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true
  } catch {
    return true
  }
}

/** Stamps the theme on the root element; the stylesheet's `[data-theme]` blocks do the rest. */
export function applyTheme(theme: Theme, root: HTMLElement | null = globalThis.document?.documentElement ?? null): void {
  if (root === null) return
  root.setAttribute('data-theme', theme)
  root.style.setProperty('color-scheme', theme)
}

/**
 * Follows the OS while the setting is `system`. Returns the unsubscribe. A window without
 * `matchMedia` gets a no-op, not an exception: the theme stays at whatever was applied.
 */
export function watchSystemTheme(
  onChange: (prefersDark: boolean) => void,
  win: Pick<Window, 'matchMedia'> | null = globalThis.window ?? null,
): () => void {
  let query: MediaQueryList | undefined
  try {
    query = win?.matchMedia?.('(prefers-color-scheme: dark)')
  } catch {
    return () => {}
  }
  if (query === undefined) return () => {}
  const handler = (e: MediaQueryListEvent): void => onChange(e.matches)
  query.addEventListener('change', handler)
  return () => query.removeEventListener('change', handler)
}
