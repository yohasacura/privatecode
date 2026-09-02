import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Mount } from '../core/src/mounts.js'

/**
 * A throwaway copy of a real project that BUILDS without the network.
 *
 * `obj/` carries the restore assets and they name the original folder by absolute path; left
 * alone, MSBuild decides the project moved, re-restores, and hangs on NuGet. Rewriting the
 * path in every text file under `obj/` makes `dotnet build` in the copy the two-second
 * incremental build it is in the original. Binary caches are deleted rather than rewritten.
 */
export interface Shape {
  /** Folders to copy: model-visible name, source path, what to leave out. */
  folders: { name: string; from: string; skip: RegExp; access: 'write' | 'read' }[]
  /** .NET project directories (folder-relative in a multi-folder shape) whose obj/ to rewrite. */
  dotnetProjects: string[]
  /** The check the owner's settings would run, per folder. */
  verify: Record<string, string>
  /** Files left out of the copy, per folder. */
  dropInCopy?: Record<string, string[]>
  /** Where the C# test project lives, folder-relative, for hidden tests. */
  testProject?: { folder: string; dir: string; csproj: string }
}

export const SHAPES: Record<string, Shape> = {
  winopt: {
    folders: [{
      name: 'WindowsOptimizer',
      from: process.env['EVAL_WINOPT'] ?? 'D:\\Projects\\WindowsOptimizer',
      skip: /[\\/](publish|\.git|\.privatecode|docs)([\\/]|$)/,
      access: 'write',
    }],
    dotnetProjects: ['src/WinOptimizer', 'tests/WinOptimizer.Tests'],
    verify: {
      WindowsOptimizer: 'dotnet build src/WinOptimizer/WinOptimizer.csproj --no-restore --nologo -v q',
    },
    // The owner's working tree carries failing view-model tests unrelated to any task; a
    // model that runs `dotnet test` and sees them goes off to fix them.
    dropInCopy: { WindowsOptimizer: ['tests/WinOptimizer.Tests/MainViewModelTests.cs'] },
    testProject: { folder: 'WindowsOptimizer', dir: 'tests/WinOptimizer.Tests', csproj: 'WinOptimizer.Tests.csproj' },
  },
  blackport: {
    folders: [
      {
        name: 'backend',
        from: process.env['EVAL_BLACKPORT'] !== undefined
          ? join(process.env['EVAL_BLACKPORT'], 'src', 'backend')
          : 'D:\\Projects\\black-port\\src\\backend',
        skip: /[\\/](\.git|\.privatecode)([\\/]|$)/,
        access: 'write',
      },
      {
        name: 'frontend',
        from: process.env['EVAL_BLACKPORT'] !== undefined
          ? join(process.env['EVAL_BLACKPORT'], 'src', 'frontend')
          : 'D:\\Projects\\black-port\\src\\frontend',
        skip: /[\\/](node_modules|\.next|\.git|\.privatecode)([\\/]|$)/,
        access: 'write',
      },
    ],
    dotnetProjects: [
      'BlackPort.Api', 'BlackPort.Application', 'BlackPort.Domain', 'BlackPort.Infrastructure', 'BlackPort.Tests',
    ].map((p) => `backend/${p}`),
    verify: {
      backend: 'dotnet build BlackPort.Api/BlackPort.Api.csproj --no-restore --nologo -v q',
    },
  },
}

export function makeWorkspace(shape: Shape): { root: string; mounts: Mount[] } {
  const dir = mkdtempSync(join(tmpdir(), 'pc-eval-'))
  const mounts: Mount[] = []
  for (const [i, folder] of shape.folders.entries()) {
    const to = join(dir, folder.name)
    cpSync(folder.from, to, { recursive: true, filter: (p) => !folder.skip.test(p) })
    for (const rel of shape.dropInCopy?.[folder.name] ?? []) {
      if (existsSync(join(to, rel))) unlinkSync(join(to, rel))
    }
    mounts.push({ name: folder.name, root: to, access: folder.access, primary: i === 0 })
    const escapedOld = JSON.stringify(folder.from).slice(1, -1)
    const escapedNew = JSON.stringify(to).slice(1, -1)
    const rewrite = (dirPath: string): void => {
      for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
        const p = join(dirPath, entry.name)
        if (entry.isDirectory()) { rewrite(p); continue }
        if (/\.cache$/i.test(entry.name)) { unlinkSync(p); continue }
        if (!/\.(json|props|targets|txt|g\.cs|AssemblyInfo\.cs|editorconfig)$/i.test(entry.name)) continue
        if (statSync(p).size > 5_000_000) continue
        const before = readFileSync(p, 'utf8')
        const after = before.split(escapedOld).join(escapedNew).split(folder.from).join(to)
        if (after !== before) writeFileSync(p, after, 'utf8')
      }
    }
    for (const proj of shape.dotnetProjects) {
      if (shape.folders.length > 1 && !proj.startsWith(`${folder.name}/`)) continue
      const rel = shape.folders.length > 1 ? proj.slice(folder.name.length + 1) : proj
      const obj = join(to, rel, 'obj')
      if (existsSync(obj)) rewrite(obj)
    }
  }
  mkdirSync(join(mounts[0]!.root, '.privatecode'), { recursive: true })
  return { root: mounts[0]!.root, mounts }
}

/**
 * The copy goes, and the build servers MSBuild left behind go first: node reuse and
 * VBCSCompiler keep the copy's files open for minutes after the last build, and `rmSync`
 * against them throws EPERM. Never throws.
 */
export function removeCopy(dir: string): void {
  try { spawnSync('dotnet', ['build-server', 'shutdown'], { timeout: 60_000, shell: true, stdio: 'ignore' }) } catch { /* best effort */ }
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { timeout: 10_000 })
    }
  }
  console.log(`could not remove ${dir}; leaving it`)
}

/** One command in a folder, with its exit code and the tail of its output. */
export function runIn(cwd: string, command: string, timeoutMs = 240_000): { ok: boolean; output: string; seconds: number } {
  const started = Date.now()
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
    cwd, encoding: 'utf8', timeout: timeoutMs, windowsHide: true,
  })
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`
  return { ok: r.status === 0, output: output.slice(-4000), seconds: (Date.now() - started) / 1000 }
}
