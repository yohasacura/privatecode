import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execa } from 'execa'

/**
 * A marketplace the plugin tests install from: three plugins under `plugins/`, resolved
 * through `metadata.pluginRoot`, plus (optionally) one fetched from a git repository.
 */

export interface FixtureOptions {
  alphaVersion?: string
  /** A fourth entry, `remote`, with a git-subdir source. */
  remote?: { url: string; path: string; sha?: string }
}

export function writePlugin(dir: string, name: string, version: string | null, extras: { defaultEnabled?: boolean; single?: boolean } = {}): void {
  mkdirSync(dir, { recursive: true })
  if (extras.single === true) {
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: A single skill\n---\n# ${name}\n`)
    return
  }
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  const manifest: Record<string, unknown> = { name, description: `${name} plugin`, author: { name: 'Tests' } }
  if (version !== null) manifest['version'] = version
  if (extras.defaultEnabled !== undefined) manifest['defaultEnabled'] = extras.defaultEnabled
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  mkdirSync(join(dir, 'skills', 'greet'), { recursive: true })
  writeFileSync(join(dir, 'skills', 'greet', 'SKILL.md'), '---\nname: greet\ndescription: Says hello\n---\nSay hello.\n')
  mkdirSync(join(dir, 'commands', 'review'), { recursive: true })
  writeFileSync(join(dir, 'commands', 'hello.md'), '---\ndescription: Greets\nargument-hint: [name]\n---\nHello $ARGUMENTS\n')
  writeFileSync(join(dir, 'commands', 'review', 'security.md'), 'Review for security.\n')
  mkdirSync(join(dir, 'agents'), { recursive: true })
  writeFileSync(join(dir, 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Reviews code\n---\nYou review.\n')
  mkdirSync(join(dir, 'hooks'), { recursive: true })
  writeFileSync(join(dir, 'hooks', 'hooks.json'), `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] } }, null, 2)}\n`)
  writeFileSync(join(dir, '.mcp.json'), `${JSON.stringify({ mcpServers: { memory: { command: 'node', args: ['server.js'] } } }, null, 2)}\n`)
}

export function writeMarketplace(dir: string, name: string, opts: FixtureOptions = {}): void {
  writePlugin(join(dir, 'plugins', 'alpha'), 'alpha', opts.alphaVersion ?? '1.0.0')
  writePlugin(join(dir, 'plugins', 'beta'), 'beta', null, { single: true })
  writePlugin(join(dir, 'plugins', 'gamma'), 'gamma', '2.0.0', { defaultEnabled: false })
  const plugins: unknown[] = [
    { name: 'alpha', source: './alpha', description: 'The full plugin' },
    { name: 'beta', source: 'beta', version: '0.1.0', description: 'One skill' },
    { name: 'gamma', source: './gamma', description: 'Off by default' },
  ]
  if (opts.remote !== undefined) plugins.push({ name: 'remote', source: { source: 'git-subdir', ...opts.remote } })
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  writeFileSync(join(dir, '.claude-plugin', 'marketplace.json'), `${JSON.stringify({
    name, owner: { name: 'Tests' }, description: 'Fixture', metadata: { pluginRoot: './plugins' }, plugins,
    renames: { 'old-alpha': 'alpha', gone: null },
  }, null, 2)}\n`)
}

const GIT = ['-c', 'user.name=tests', '-c', 'user.email=tests@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false']

export async function gitInit(dir: string): Promise<string> {
  await execa('git', [...GIT, 'init', '-q', '-b', 'main'], { cwd: dir })
  return gitCommit(dir, 'init')
}

export async function gitCommit(dir: string, message: string): Promise<string> {
  await execa('git', [...GIT, 'add', '-A'], { cwd: dir })
  await execa('git', [...GIT, 'commit', '-q', '-m', message], { cwd: dir })
  return (await execa('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim()
}
