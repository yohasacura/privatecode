/**
 * Do the WindowsOptimizer hidden tests mean what they say? Against a hand-written reference
 * solution for all ten tasks they must all pass; against the untouched original (with the
 * bugfix tasks' bugs planted) they must all fail. Run whenever a task or a hidden test changes.
 *
 *   npx tsx spike/winopt-hidden-tests-try.mts --reference
 *   npx tsx spike/winopt-hidden-tests-try.mts --untouched
 */
import { copyFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SHAPES, makeWorkspace, removeCopy, runIn } from '../eval/workspace.js'
import { TASKS } from '../eval/tasks.js'

const MODE = process.argv.includes('--untouched') ? 'untouched' : 'reference'

function edit(file: string, from: string, to: string): void {
  const raw = readFileSync(file, 'utf8')
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const f = from.split('\n').join(eol)
  if (!raw.includes(f)) throw new Error(`anchor not found in ${file}: ${from.slice(0, 60)}`)
  writeFileSync(file, raw.replace(f, to.split('\n').join(eol)), 'utf8')
}

/** The smallest correct answer to each feature task; the bugfix tasks' answer is the original. */
function applyReference(root: string): void {
  const src = join(root, 'src', 'WinOptimizer')
  // snapshot-savedat, snapshot-servicecount, appstate-lasterror
  edit(join(src, 'Core', 'Snapshot.cs'),
    '    public List<string> ClosedProcesses { get; set; } = new();  // history/display only\n}',
    '    public List<string> ClosedProcesses { get; set; } = new();  // history/display only\n' +
    '    public DateTimeOffset SavedAt { get; set; }\n' +
    '    [System.Text.Json.Serialization.JsonIgnore] public int ServiceCount => Services.Count;\n}')
  edit(join(src, 'Core', 'Snapshot.cs'),
    '    public int RestoreAttempts { get; set; }\n}',
    '    public int RestoreAttempts { get; set; }\n    public string? LastError { get; set; }\n}')
  edit(join(src, 'Services', 'SnapshotStore.cs'),
    '        try { WriteAtomic(SnapshotPath, JsonSerializer.Serialize(snapshot, JsonOpts)); return true; }',
    '        try { snapshot.SavedAt = DateTimeOffset.Now; WriteAtomic(SnapshotPath, JsonSerializer.Serialize(snapshot, JsonOpts)); return true; }')
  // planner-max-processes, fallback-brightness-config
  edit(join(src, 'Core', 'Config.cs'),
    'public sealed class AppConfig\n{',
    'public sealed class AppConfig\n{\n    public int MaxProcessesInPlan { get; set; } = 0;\n    public int FallbackBrightnessPercent { get; set; } = 70;\n')
  edit(join(src, 'Core', 'OptimizationPlanner.cs'),
    '            BrightnessPercent = 70,',
    '            BrightnessPercent = config.FallbackBrightnessPercent,')
  edit(join(src, 'Core', 'OptimizationPlanner.cs'),
    '        var byName = new Dictionary<string, ServiceInfo>(StringComparer.OrdinalIgnoreCase);',
    '        if (config.MaxProcessesInPlan > 0)\n' +
    '        {\n' +
    '            foreach (var extra in plan.Where(p => p.Category == ActionCategory.Process).Skip(config.MaxProcessesInPlan).ToList())\n' +
    '                plan.Remove(extra);\n' +
    '        }\n' +
    '        var byName = new Dictionary<string, ServiceInfo>(StringComparer.OrdinalIgnoreCase);')
  // logger-rotation
  writeFileSync(join(src, 'Services', 'FileLogger.cs'), [
    'using System.IO;',
    'using System.Text;',
    '',
    'namespace WinOptimizer.Services;',
    '',
    'public sealed class FileLogger : ILogger, IDisposable',
    '{',
    '    private readonly string _path;',
    '    private readonly long _maxBytes;',
    '    private readonly object _lock = new();',
    '    private StreamWriter? _writer;',
    '    private bool _disposed;',
    '',
    '    public FileLogger(string? baseDir = null, long maxBytes = 1_048_576)',
    '    {',
    '        var dir = baseDir ?? Path.Combine(',
    '            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WinOptimizer");',
    '        Directory.CreateDirectory(dir);',
    '        _path = Path.Combine(dir, "log.txt");',
    '        _maxBytes = maxBytes;',
    '    }',
    '',
    '    public void Info(string message) => Log("INFO", message);',
    '    public void Warn(string message) => Log("WARN", message);',
    '    public void Error(string message, Exception? ex = null) => Log("ERROR", message + (ex != null ? $"\\n  {ex}" : ""));',
    '',
    '    private void Log(string level, string message)',
    '    {',
    '        if (_disposed) return;',
    '        try',
    '        {',
    '            lock (_lock)',
    '            {',
    '                if (_writer is not null && new FileInfo(_path).Length > _maxBytes)',
    '                {',
    '                    _writer.Dispose();',
    '                    _writer = null;',
    '                    File.Move(_path, Path.Combine(Path.GetDirectoryName(_path)!, "log.1.txt"), overwrite: true);',
    '                }',
    '                if (_writer is null)',
    '                {',
    '                    Directory.CreateDirectory(Path.GetDirectoryName(_path)!);',
    '                    _writer = new StreamWriter(File.Open(_path, FileMode.Append, FileAccess.Write, FileShare.Read), Encoding.UTF8)',
    '                    { AutoFlush = true };',
    '                }',
    '                _writer.WriteLine($"[{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss.fff}] [{level}] {message}");',
    '            }',
    '        }',
    '        catch { /* avoid crashing the app if logging fails */ }',
    '    }',
    '',
    '    public void Dispose()',
    '    {',
    '        lock (_lock)',
    '        {',
    '            if (_disposed) return;',
    '            _writer?.Flush();',
    '            _writer?.Dispose();',
    '            _disposed = true;',
    '        }',
    '    }',
    '}',
    '',
  ].join('\r\n'), 'utf8')
  // converter-bool-visibility
  writeFileSync(join(src, 'Converters', 'BoolToVisibilityConverter.cs'), [
    'using System.Globalization;',
    'using System.Windows;',
    'using System.Windows.Data;',
    '',
    'namespace WinOptimizer.Converters;',
    '',
    'public class BoolToVisibilityConverter : IValueConverter',
    '{',
    '    public object Convert(object value, Type targetType, object parameter, CultureInfo culture)',
    '        => value is true ? Visibility.Visible : Visibility.Collapsed;',
    '',
    '    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture)',
    '        => value is Visibility.Visible;',
    '}',
    '',
  ].join('\r\n'), 'utf8')
}

function applyPlants(root: string): void {
  for (const task of TASKS.filter((t) => t.workspace === 'winopt')) {
    for (const plant of task.plant ?? []) edit(join(root, plant.file), plant.from, plant.to)
  }
}

const shape = SHAPES['winopt']!
const { root } = makeWorkspace(shape)
console.log(`copy at ${root} (${MODE})`)
try {
  if (MODE === 'reference') applyReference(root)
  else applyPlants(root)
  const tp = shape.testProject!
  const testDir = join(root, tp.dir)
  for (const task of TASKS.filter((t) => t.workspace === 'winopt' && t.hidden !== undefined)) {
    const dir = new URL(`../eval/hidden/${task.hidden}/`, import.meta.url)
    for (const f of readdirSync(dir)) if (f.endsWith('.cs')) copyFileSync(new URL(f, dir), join(testDir, f))
  }
  const b = runIn(root, shape.verify['WindowsOptimizer']!)
  console.log(`builds: ok=${b.ok} in ${b.seconds.toFixed(1)}s`)
  if (!b.ok) console.log(b.output.split(/\r?\n/).filter((l) => /error/.test(l)).slice(0, 8).join('\n'))
  const r = runIn(testDir, `dotnet test ${tp.csproj} --no-restore --nologo -v q`, 600_000)
  console.log(`dotnet test: ok=${r.ok} in ${r.seconds.toFixed(1)}s`)
  const lines = r.output.split(/\r?\n/)
  console.log(lines.filter((l) => /Passed!|Failed!|error CS/.test(l)).slice(-6).join('\n'))
  const failed = lines.filter((l) => /\[FAIL\]/.test(l)).map((l) => l.replace(/.*Tests\./, '').trim())
  console.log(`failed (${failed.length}):\n  ${failed.join('\n  ')}`)
} finally {
  removeCopy(join(root, '..'))
}
