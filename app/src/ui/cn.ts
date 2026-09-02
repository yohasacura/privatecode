/** Joins class names, dropping the falsy ones: `cn('btn', active && 'btn-on')`. */
export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter((p): p is string => typeof p === 'string' && p !== '').join(' ')
}
