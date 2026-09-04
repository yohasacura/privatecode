/**
 * Windows' reserved device names.
 *
 * A file whose base name is one of these — with or without an extension, so `nul.txt` too,
 * and whatever folder it is in — is opened by Win32 as the DEVICE: a write to it lands
 * nowhere, a read of it is empty, and Explorer, `del` and Node's plain `fs` cannot delete
 * one that exists. One CAN exist: Git Bash's MSYS runtime opens paths through the NT API,
 * which has no such rule, so a cmd.exe-style `2>nul` in that shell creates a real file
 * called `nul`. Watched on the owner's other machine: the model wrote exactly that, and the
 * workspace root gained a file nothing could remove.
 */
const WINDOWS_DEVICE_NAMES: ReadonlySet<string> = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 10 }, (_, i) => `COM${i}`),
  ...Array.from({ length: 10 }, (_, i) => `LPT${i}`),
])

/** Whether Win32 would open a file of this name as a device rather than as a file. */
export function isWindowsDeviceName(name: string): boolean {
  // Trailing dots and spaces are stripped before Windows looks at a name, and the
  // extension is not part of the test: `nul.txt` is the device too.
  const base = name.replace(/[. ]+$/, '').split('.')[0] ?? ''
  return WINDOWS_DEVICE_NAMES.has(base.trim().toUpperCase())
}
