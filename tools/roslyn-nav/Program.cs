using System.Collections.Immutable;
using System.Diagnostics;
using System.Reflection.Metadata;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.Rename;
using Microsoft.CodeAnalysis.Text;
using Basic.Reference.Assemblies;

namespace RoslynNav;

/// <summary>
/// One long-lived process answering semantic questions about a C# tree, over ndjson on
/// stdio — the same shape the agent sidecar itself uses.
///
/// Long-lived rather than one-shot because building the compilation is the expensive part:
/// parsing 1500 files costs seconds, and a tool that paid that per question would be slower
/// than the file reading it replaces. It is paid once, on `load`, and every question after
/// that is fast.
/// </summary>
public static class Program
{
    private static Workspace? _workspace;
    private static Solution? _solution;
    private static ProjectId? _projectId;
    private static string _root = "";
    private static readonly List<string> _loadProblems = new();
    /// <summary>Where the references came from, for a person checking this index.</summary>
    private static readonly List<string> _referenceSources = new();
    /// <summary>Files `sync` has been told about since the load, by full path.</summary>
    private static readonly HashSet<string> _touched = new(StringComparer.OrdinalIgnoreCase);
    /// <summary>
    /// The errors the tree had when it was loaded, keyed without line numbers. Computed off
    /// the load's own thread so `load` answers as fast as it did; `diagnostics` awaits it.
    /// </summary>
    private static Task<HashSet<string>>? _baseline;

    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static async Task<int> Main()
    {
        // Line-delimited JSON both ways. A line that cannot be parsed is reported and the
        // loop carries on: one malformed request must not take the process down, because
        // restarting it means paying for the whole compilation again.
        string? line;
        while ((line = await Console.In.ReadLineAsync()) is not null)
        {
            if (line.Length == 0) continue;
            object response;
            int id = 0;
            try
            {
                using var doc = JsonDocument.Parse(line);
                var root = doc.RootElement;
                id = root.TryGetProperty("id", out var idEl) ? idEl.GetInt32() : 0;
                var op = root.TryGetProperty("op", out var opEl) ? opEl.GetString() ?? "" : "";
                response = await Handle(id, op, root);
            }
            catch (Exception e)
            {
                response = new { id, ok = false, error = e.Message };
            }
            Console.Out.WriteLine(JsonSerializer.Serialize(response, Json));
            await Console.Out.FlushAsync();
        }
        return 0;
    }

    private static async Task<object> Handle(int id, string op, JsonElement root) => op switch
    {
        "load" => Load(id, root),
        "definition" => await Definition(id, Arg(root, "symbol")),
        "references" => await References(id, Arg(root, "symbol"), Limit(root)),
        "implementations" => await Implementations(id, Arg(root, "symbol")),
        "members" => Members(id, Arg(root, "symbol")),
        "hierarchy" => await Hierarchy(id, Arg(root, "symbol")),
        "search" => await Search(id, Arg(root, "symbol"), Limit(root)),
        "rename" => await Rename(id, Arg(root, "symbol"), Arg(root, "newName")),
        "sync" => Sync(id, root),
        "diagnostics" => await Diagnostics(id, root),
        "status" => new
        {
            id, ok = true, loaded = _solution is not null, root = _root, problems = _loadProblems,
            references = _referenceSources,
            generated = Current?.Documents.Where(d => IsGenerated(d.FilePath)).Select(d => d.FilePath).ToArray(),
        },
        _ => new { id, ok = false, error = $"unknown op \"{op}\"" },
    };

    private static string Arg(JsonElement root, string name) =>
        root.TryGetProperty(name, out var el) ? el.GetString() ?? "" : "";

    private static int Limit(JsonElement root) =>
        root.TryGetProperty("limit", out var el) && el.TryGetInt32(out var v) ? v : 60;

    // ---------------------------------------------------------------------------------

    /// <summary>
    /// Builds one compilation over every .cs file under <c>root</c>.
    ///
    /// References come from two places. The BCL is carried inside this binary as reference
    /// assemblies and is always present. The target's NuGet surface comes from whatever it
    /// has already built into its own bin folders, and is not guaranteed. A project that has
    /// never been built still loads — every question is then answered from syntax and from
    /// the types it can see, and the load reports what was missing rather than pretending
    /// the answers are complete.
    /// </summary>
    private static object Load(int id, JsonElement root)
    {
        var path = Arg(root, "root");
        if (path.Length == 0) return new { id, ok = false, error = "load needs a root path" };
        if (!Directory.Exists(path)) return new { id, ok = false, error = $"no such directory: {path}" };

        _loadProblems.Clear();
        var sources = EnumerateSources(path).ToList();
        if (sources.Count == 0) return new { id, ok = false, error = $"no .cs files under {path}" };

        var refs = MetadataReferences(path, _loadProblems);

        var workspace = new AdhocWorkspace();
        var projectId = ProjectId.CreateNewId("target");
        var projectInfo = ProjectInfo.Create(
            projectId, VersionStamp.Create(), "target", "target", LanguageNames.CSharp,
            compilationOptions: new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary,
                // A navigation compilation is allowed to have errors; the point is the symbol
                // graph, not a build. Without this a project missing one package answers
                // nothing at all.
                allowUnsafe: true, nullableContextOptions: NullableContextOptions.Enable),
            parseOptions: new CSharpParseOptions(LanguageVersion.Preview),
            metadataReferences: refs);

        var solution = workspace.CurrentSolution.AddProject(projectInfo);
        foreach (var file in sources)
        {
            string text;
            try { text = File.ReadAllText(file); }
            catch (Exception e) { _loadProblems.Add($"could not read {file}: {e.Message}"); continue; }
            solution = solution.AddDocument(DocumentId.CreateNewId(projectId), Path.GetFileName(file),
                text, filePath: file);
        }
        // What the SDK generated on the last build: the implicit global usings, the assembly
        // attributes, the XAML partials. Without them `List<T>` in a file with no `using
        // System.Collections.Generic` and every `InitializeComponent()` are errors here and
        // not in the real build, which made `diagnostics` unusable on exactly the projects
        // it is for. They are documents like any other for the compiler and invisible to
        // every navigation answer — see `IsGenerated`.
        var generated = EnumerateGenerated(path).ToList();
        foreach (var file in generated)
        {
            string text;
            try { text = File.ReadAllText(file); }
            catch { continue; }
            solution = solution.AddDocument(DocumentId.CreateNewId(projectId), Path.GetFileName(file),
                text, filePath: file);
        }

        _workspace = workspace;
        _solution = solution;
        _projectId = projectId;
        _root = path;
        _touched.Clear();

        // The check that should have caught the missing BCL, and the reason it is worth
        // keeping now that the BCL is no longer missing. Every wrong answer this helper has
        // given came from a compilation that could not resolve `System.Object` — and it
        // reported `problems: []` while giving them, because the only problem it knew how to
        // report was the target's own build output being absent. An index that cannot name
        // the root of the type system must say so rather than answer confidently.
        var probe = _solution.GetProject(projectId)?.GetCompilationAsync().Result;
        if (probe?.GetTypeByMetadataName("System.Object") is null)
        {
            _loadProblems.Add(
                "this index could not resolve System.Object, so base types and interfaces " +
                "are unreliable: `implementations` and the interface list of `members` may " +
                "come back empty even where the code declares them. `references` and " +
                "`definition` are unaffected.");
        }

        // The errors the tree ALREADY has, so `diagnostics` can report what an edit added
        // rather than everything an ad-hoc compilation of somebody else's project cannot
        // resolve. Off this thread: binding every method body is the expensive half of a
        // compilation, and `load` is on the clock of the first question.
        var loaded = probe;
        _baseline = loaded is null
            ? Task.FromResult(new HashSet<string>(StringComparer.Ordinal))
            : Task.Run(() => ErrorKeys(loaded));

        return new
        {
            id, ok = true, files = sources.Count, generated = generated.Count, references = refs.Count,
            problems = _loadProblems,
        };
    }

    // `.claude\worktrees` holds whole copies of the tree: on one 2423-file project 39% of
    // what loaded were stale duplicates of files also loaded from their real path, and a
    // duplicate costs a genuine hit its place in a limited result.
    private static readonly string[] SkippedDirs =
    {
        "\\bin\\", "\\obj\\", "\\node_modules\\", "\\.git\\", "\\.privatecode\\", "\\.claude\\worktrees\\",
    };

    private static bool IsSkippedPath(string path)
    {
        var padded = path.Replace('/', '\\');
        return SkippedDirs.Any(s => padded.Contains(s, StringComparison.OrdinalIgnoreCase));
    }

    private static IEnumerable<string> EnumerateSources(string root)
    {
        foreach (var f in Directory.EnumerateFiles(root, "*.cs", SearchOption.AllDirectories))
        {
            if (IsSkippedPath(f)) continue;
            yield return f;
        }
    }

    /// <summary>
    /// The sources the SDK wrote into <c>obj/</c> on the last build, one build's worth per
    /// project: <c>obj/&lt;Configuration&gt;/&lt;TargetFramework&gt;</c> holds the global
    /// usings, the assembly attributes and the XAML partials, and a second configuration
    /// beside it would declare every one of them twice. The most recently built one is taken.
    /// WPF's <c>.g.i.cs</c> twin of each <c>.g.cs</c> is skipped for the same reason.
    /// </summary>
    private static IEnumerable<string> EnumerateGenerated(string root)
    {
        var outside = new[] { "\\bin\\", "\\node_modules\\", "\\.git\\", "\\.claude\\worktrees\\" };
        List<string> objDirs;
        try
        {
            objDirs = Directory.EnumerateDirectories(root, "obj", SearchOption.AllDirectories)
                .Where(d => !outside.Any(s => (d.Replace('/', '\\') + "\\").Contains(s, StringComparison.OrdinalIgnoreCase)))
                .ToList();
        }
        catch { yield break; }

        foreach (var obj in objDirs)
        {
            string? newest = null;
            var newestAt = DateTime.MinValue;
            IEnumerable<string> builds;
            try { builds = Directory.EnumerateDirectories(obj).SelectMany(Directory.EnumerateDirectories).ToList(); }
            catch { continue; }
            foreach (var build in builds)
            {
                DateTime at;
                try
                {
                    at = Directory.EnumerateFiles(build, "*.cs", SearchOption.AllDirectories)
                        .Select(File.GetLastWriteTimeUtc).DefaultIfEmpty(DateTime.MinValue).Max();
                }
                catch { continue; }
                if (at > newestAt) { newest = build; newestAt = at; }
            }
            if (newest is null) continue;

            var byName = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            IEnumerable<string> files;
            try { files = Directory.EnumerateFiles(newest, "*.cs", SearchOption.AllDirectories).ToList(); }
            catch { continue; }
            foreach (var f in files)
            {
                var name = Path.GetFileName(f);
                if (name.EndsWith(".g.i.cs", StringComparison.OrdinalIgnoreCase)) continue;
                // WPF builds a throwaway `<Project>_<random>_wpftmp` project first and leaves
                // its generated files behind, one pair per build: 24 pairs on a 32-file app,
                // each declaring the same global usings and assembly attributes again. Never
                // part of the real compilation.
                if (name.Contains("_wpftmp", StringComparison.OrdinalIgnoreCase)) continue;
                // Assembly attributes are left out on purpose: several projects share this one
                // compilation, and each brings its own copy of [AssemblyTitle] and friends —
                // duplicates the compiler refuses. Nothing a reader edits depends on them.
                var wanted = name.EndsWith(".g.cs", StringComparison.OrdinalIgnoreCase)
                    || f.Replace('/', '\\').Contains("\\generated\\", StringComparison.OrdinalIgnoreCase);
                if (!wanted) continue;
                // A RID-specific folder under the build holds a second copy of the same file;
                // the shallower path is the one the build used.
                if (!byName.TryGetValue(name, out var kept) || f.Length < kept.Length) byName[name] = f;
            }
            foreach (var f in byName.Values) yield return f;
        }
    }

    /// <summary>A document the compiler needs and a reader never asked about.</summary>
    private static bool IsGenerated(string? path) =>
        path is not null && (path.Replace('/', '\\') + "\\").Contains("\\obj\\", StringComparison.OrdinalIgnoreCase);

    private static bool DeclaredOnlyInGenerated(ISymbol s)
    {
        var inSource = s.Locations.Where(l => l.IsInSource).ToList();
        return inSource.Count > 0 && inSource.All(l => IsGenerated(l.SourceTree?.FilePath));
    }

    /// <summary>
    /// The BCL from this helper's own runtime, plus whatever the target has already built.
    /// Duplicate simple names are dropped — two copies of the same assembly is an error
    /// Roslyn reports instead of an answer.
    /// </summary>
    private static List<MetadataReference> MetadataReferences(string root, List<string> problems)
    {
        // One reference per simple name, the highest assembly version winning. Not "first
        // wins": the runtime's own folder carries a `WindowsBase` facade at version 4.0 for
        // compatibility, and taking it over the desktop framework's real 10.0 one made
        // every WPF assembly a version-mismatch error (CS1705) before a line was compiled.
        var byName = new Dictionary<string, (Version version, int index)>(StringComparer.OrdinalIgnoreCase);
        var refs = new List<MetadataReference>();
        _referenceSources.Clear();

        void Add(string dll)
        {
            var name = Path.GetFileNameWithoutExtension(dll);
            var version = AssemblyVersion(dll);
            if (version is null) return;
            if (byName.TryGetValue(name, out var have))
            {
                if (version <= have.version) return;
                try
                {
                    refs[have.index] = MetadataReference.CreateFromFile(dll);
                    byName[name] = (version, have.index);
                }
                catch { /* the one already there stays */ }
                return;
            }
            try
            {
                refs.Add(MetadataReference.CreateFromFile(dll));
                byName[name] = (version, refs.Count - 1);
            }
            catch { /* not a reference; the compiler would only have refused it later */ }
        }
        var seen = byName.Keys;

        // The BCL. From the .NET installation on this machine when there is one, at the
        // major version the project targets — a net8.0 project then compiles against the
        // net8.0 library and not against APIs it cannot use — and otherwise from the reference
        // assemblies embedded in this binary.
        //
        // The embedded copy used to be the only source, and before that this scanned
        // `AppContext.BaseDirectory` for `System.*.dll`, on the reasoning that a self-contained
        // publish drops the runtime beside the exe. `PublishSingleFile` does the opposite — it
        // packs the runtime INSIDE the exe — so that directory holds exactly one file and the
        // loop matched nothing, on every machine, always. A compilation with no
        // `System.Object` does not fail; it quietly loses the ability to classify a base-type
        // list, which is how `members PlanItem` reported no interfaces for `class PlanItem :
        // INotifyPropertyChanged` and `implementations` answered an empty list with ok:true.
        // Embedded resources cannot be emptied by a publish setting, so the fallback stays.
        var facts = ProjectFacts(root);
        var dotnet = DotnetRoot();
        var bcl = dotnet is null ? null : FrameworkDir(dotnet, "Microsoft.NETCore.App", facts.major);
        if (bcl is not null)
        {
            foreach (var dll in ManagedDlls(bcl)) Add(dll);
            _referenceSources.Add($"BCL: {bcl}");
        }
        if (!byName.ContainsKey("System.Runtime"))
        {
            foreach (var info in Net100.ReferenceInfos.All)
            {
                var name = Path.GetFileNameWithoutExtension(info.FileName);
                if (byName.ContainsKey(name)) continue;
                refs.Add(info.Reference);
                // Version unknown, recorded as the lowest: a real assembly of the same name
                // found later (a package in bin, say) is then preferred, as the build prefers it.
                byName[name] = (new Version(0, 0), refs.Count - 1);
            }
            _referenceSources.Add("BCL: embedded net10.0 reference assemblies");
        }

        // The platform's: the shared frameworks a project builds against and never copies
        // into bin. See `AddFrameworkReferences`.
        AddFrameworkReferences(facts.needs, facts.major, dotnet, Add, problems);

        // Theirs: the third-party surface, only available if they have built once. Minus
        // the projects' OWN outputs: every type this tree declares is already here as source,
        // and the compiled twin beside it made each extension method an ambiguous call
        // (CS0121) and each implementation answer a duplicate.
        var own = facts.assemblyNames;
        var binDlls = Directory.EnumerateDirectories(root, "bin", SearchOption.AllDirectories)
            .SelectMany(d => Directory.EnumerateFiles(d, "*.dll", SearchOption.AllDirectories))
            .Where(dll => !own.Contains(Path.GetFileNameWithoutExtension(dll)))
            .ToList();
        if (binDlls.Count == 0)
        {
            problems.Add(
                "this project has no build output, so third-party types are unknown to the " +
                "index. Symbols defined in the source still resolve; anything from a package " +
                "may not. Building the project once makes these answers complete.");
        }
        foreach (var dll in binDlls) Add(dll);
        _referenceSources.Add($"bin: {binDlls.Count} files under {root}");

        return refs;
    }

    /// <summary>
    /// A file that is a .NET assembly, as opposed to the native libraries that sit beside
    /// them in a runtime folder and a bin folder alike. Handing the compiler one of those is
    /// not a skipped reference but an error (CS0009) on every diagnostic pass.
    /// </summary>
    private static Version? AssemblyVersion(string dll)
    {
        try
        {
            using var stream = File.OpenRead(dll);
            using var pe = new System.Reflection.PortableExecutable.PEReader(stream);
            if (!pe.HasMetadata) return null;
            var metadata = pe.GetMetadataReader();
            return metadata.IsAssembly ? metadata.GetAssemblyDefinition().Version : null;
        }
        catch { return null; }
    }

    private static IEnumerable<string> ManagedDlls(string dir)
    {
        IEnumerable<string> files;
        try { files = Directory.EnumerateFiles(dir, "*.dll").ToList(); }
        catch { yield break; }
        foreach (var f in files) yield return f;
    }

    /// <summary>
    /// What the .csproj files say about the tree: which shared frameworks it builds against
    /// and the highest major version it targets.
    /// </summary>
    private static (HashSet<string> needs, int major, HashSet<string> assemblyNames) ProjectFacts(string root)
    {
        var needs = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var assemblyNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var major = 0;
        List<string> projects;
        try
        {
            projects = Directory.EnumerateFiles(root, "*.csproj", SearchOption.AllDirectories)
                .Where(p => !IsSkippedPath(p)).ToList();
        }
        catch { return (needs, major, assemblyNames); }
        foreach (var proj in projects)
        {
            string xml;
            try { xml = File.ReadAllText(proj); }
            catch { continue; }
            assemblyNames.Add(Path.GetFileNameWithoutExtension(proj));
            var asm = Regex.Match(xml, @"<AssemblyName>\s*([^<\s]+)\s*</AssemblyName>");
            if (asm.Success) assemblyNames.Add(asm.Groups[1].Value);
            if (xml.Contains("Microsoft.NET.Sdk.Web", StringComparison.OrdinalIgnoreCase) ||
                xml.Contains("Microsoft.AspNetCore.App", StringComparison.OrdinalIgnoreCase))
            {
                needs.Add("Microsoft.AspNetCore.App");
            }
            if (Regex.IsMatch(xml, @"<UseWPF>\s*true", RegexOptions.IgnoreCase) ||
                Regex.IsMatch(xml, @"<UseWindowsForms>\s*true", RegexOptions.IgnoreCase) ||
                xml.Contains("Microsoft.WindowsDesktop.App", StringComparison.OrdinalIgnoreCase))
            {
                needs.Add("Microsoft.WindowsDesktop.App");
            }
            var m = Regex.Match(xml, @"<TargetFrameworks?>\s*net(\d+)\.");
            if (m.Success && int.TryParse(m.Groups[1].Value, out var v) && v > major) major = v;
        }
        return (needs, major, assemblyNames);
    }

    /// <summary>
    /// ASP.NET Core for a web project, WPF and Windows Forms for a desktop one: assemblies a
    /// project compiles against and never copies into <c>bin/</c>, because the runtime it
    /// runs on carries them. Without them every controller, attribute and window is an
    /// unresolved type — 291 errors on a 32-file WPF app, measured — and `diagnostics` could
    /// only ever report the difference between two wrong compilations.
    ///
    /// Read from the .csproj files (the SDK name, <c>UseWPF</c>, a FrameworkReference) and
    /// taken from the .NET installation on this machine: the SDK's targeting pack when there
    /// is one, otherwise the shared runtime's own copies, which reference just as well. A
    /// machine with neither is told so in the load's problems rather than answering wrongly.
    /// </summary>
    private static void AddFrameworkReferences(
        HashSet<string> needs, int major, string? dotnet, Action<string> add, List<string> problems)
    {
        if (needs.Count == 0) return;

        foreach (var name in needs.OrderBy(n => n, StringComparer.Ordinal))
        {
            var dir = dotnet is null ? null : FrameworkDir(dotnet, name, major);
            if (dir is null)
            {
                problems.Add(
                    $"this project uses {name} and no .NET installation on this machine provides " +
                    "it, so its types are unknown to the index and `diagnostics` cannot tell a " +
                    "framework type from a typo. Installing the matching .NET runtime fixes that.");
                continue;
            }
            foreach (var dll in ManagedDlls(dir)) add(dll);
            _referenceSources.Add($"{name}: {dir}");
        }
    }

    private static string? DotnetRoot()
    {
        var candidates = new[]
        {
            Environment.GetEnvironmentVariable("DOTNET_ROOT"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "dotnet"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "dotnet"),
        };
        foreach (var c in candidates)
        {
            if (!string.IsNullOrEmpty(c) && Directory.Exists(c)) return c;
        }
        return null;
    }

    /// <summary>
    /// The newest installed copy of a shared framework whose major version matches the
    /// project's target (any major when the target is unknown). The targeting pack's
    /// reference assemblies are preferred over the runtime's implementation assemblies at
    /// the same version: they are what the real compiler sees.
    /// </summary>
    private static string? FrameworkDir(string dotnet, string name, int major)
    {
        var candidates = new List<(Version version, bool isRef, string dir)>();
        var packs = Path.Combine(dotnet, "packs", name + ".Ref");
        if (Directory.Exists(packs))
        {
            foreach (var v in Directory.EnumerateDirectories(packs))
            {
                if (!Version.TryParse(Path.GetFileName(v).Split('-')[0], out var ver)) continue;
                var refDir = Path.Combine(v, "ref", $"net{ver.Major}.0");
                if (Directory.Exists(refDir)) candidates.Add((ver, true, refDir));
            }
        }
        var shared = Path.Combine(dotnet, "shared", name);
        if (Directory.Exists(shared))
        {
            foreach (var v in Directory.EnumerateDirectories(shared))
            {
                if (Version.TryParse(Path.GetFileName(v).Split('-')[0], out var ver)) candidates.Add((ver, false, v));
            }
        }
        if (candidates.Count == 0) return null;
        var sameMajor = candidates.Where(c => major == 0 || c.version.Major == major).ToList();
        var pool = sameMajor.Count > 0 ? sameMajor : candidates;
        return pool.OrderByDescending(c => c.version).ThenByDescending(c => c.isRef).First().dir;
    }

    // ---------------------------------------------------------------------------------

    private static Project? Current =>
        _solution is null || _projectId is null ? null : _solution.GetProject(_projectId);

    private static async Task<(Compilation?, string?)> Compile()
    {
        var project = Current;
        if (project is null) return (null, "nothing is loaded; call load first");
        var compilation = await project.GetCompilationAsync();
        return compilation is null ? (null, "the compilation could not be built") : (compilation, null);
    }

    /// <summary>
    /// Every symbol whose name matches, by simple name or by a dotted suffix of its full
    /// name — `Save`, `IInvoiceRepository.Save` and the fully qualified form all find the
    /// same thing, because the model does not reliably know which one it has.
    /// </summary>
    private static async Task<List<ISymbol>> Resolve(Compilation compilation, string query)
    {
        var project = Current!;
        var matches = new List<ISymbol>();
        var wanted = query.Trim();
        if (wanted.Length == 0) return matches;
        var simple = wanted.Contains('.') ? wanted[(wanted.LastIndexOf('.') + 1)..] : wanted;

        foreach (var sym in await SymbolFinder.FindSourceDeclarationsAsync(
                     project, simple, ignoreCase: false))
        {
            var full = sym.ToDisplayString(SymbolDisplayFormat.CSharpErrorMessageFormat);
            if (DeclaredOnlyInGenerated(sym)) continue;
            if (!wanted.Contains('.') || full.EndsWith(wanted, StringComparison.Ordinal) ||
                full.Contains(wanted, StringComparison.Ordinal))
            {
                matches.Add(sym);
            }
        }
        if (matches.Count > 0) return matches;

        // Nothing declared in source under that name. That is not the same as "no such
        // symbol": `INotifyPropertyChanged`, `IDisposable`, `ICommand` and every other type
        // worth asking about live in metadata, and answering "0 implementations" for them
        // was the most confident lie this helper told — on a WPF project, where the answer is
        // on nearly every class.
        //
        // Only types REACHED FROM SOURCE are considered, rather than the whole of the BCL:
        // it keeps the scan proportional to the project instead of to the framework, and a
        // type no source file mentions is one nothing in this project can implement anyway.
        foreach (var candidate in MetadataTypesTouchedBySource(compilation))
        {
            if (candidate.Name != simple) continue;
            var full = candidate.ToDisplayString(SymbolDisplayFormat.CSharpErrorMessageFormat);
            if (!wanted.Contains('.') || full.EndsWith(wanted, StringComparison.Ordinal))
            {
                matches.Add(candidate);
            }
        }
        return matches;
    }

    /// <summary>
    /// Every type from metadata that the source actually touches: the interfaces its types
    /// implement and the classes they derive from, transitively. Small — tens of entries on a
    /// real project — and computed per query rather than cached, because a query that reaches
    /// here has already found nothing and is not on the hot path.
    /// </summary>
    private static IEnumerable<INamedTypeSymbol> MetadataTypesTouchedBySource(Compilation compilation)
    {
        var seen = new HashSet<INamedTypeSymbol>(SymbolEqualityComparer.Default);
        foreach (var tree in compilation.SyntaxTrees)
        {
            var model = compilation.GetSemanticModel(tree);
            foreach (var node in tree.GetRoot().DescendantNodes()
                         .OfType<Microsoft.CodeAnalysis.CSharp.Syntax.TypeDeclarationSyntax>())
            {
                if (model.GetDeclaredSymbol(node) is not INamedTypeSymbol declared) continue;
                foreach (var iface in declared.AllInterfaces)
                {
                    if (!iface.Locations.Any(l => l.IsInSource)) seen.Add(iface);
                }
                for (var b = declared.BaseType; b is not null; b = b.BaseType)
                {
                    if (!b.Locations.Any(l => l.IsInSource)) seen.Add(b);
                }
            }
        }
        return seen;
    }

    private static object Located(ISymbol s)
    {
        // A partial class has a half in `obj/` too; the half a reader can open comes first.
        var loc = s.Locations.FirstOrDefault(l => l.IsInSource && !IsGenerated(l.SourceTree?.FilePath))
                  ?? s.Locations.FirstOrDefault(l => l.IsInSource);
        var span = loc?.GetLineSpan();
        return new
        {
            name = s.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat),
            kind = s.Kind.ToString(),
            // A symbol resolved from metadata has no source location, and inventing a
            // `file:0` for it would send the reader to open nothing. Naming the assembly is
            // the true answer to "where is this" for a type that ships as a binary.
            file = span?.Path ?? (s.ContainingAssembly is null ? null : $"<{s.ContainingAssembly.Name}>"),
            line = span is null ? 0 : span.Value.StartLinePosition.Line + 1,
            containing = s.ContainingType?.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)
                         ?? s.ContainingNamespace?.ToDisplayString(),
        };
    }

    private static async Task<object> Definition(int id, string symbol)
    {
        var (compilation, err) = await Compile();
        if (compilation is null) return new { id, ok = false, error = err };
        var found = await Resolve(compilation, symbol);
        if (found.Count == 0)
        {
            return new { id, ok = true, results = Array.Empty<object>(), note = $"no symbol named \"{symbol}\"", suggestions = await Suggest(symbol) };
        }
        return new
        {
            id,
            ok = true,
            results = found.Take(25).Select(s => new
            {
                located = Located(s),
                signature = s.ToDisplayString(SymbolDisplayFormat.CSharpErrorMessageFormat),
                docs = Summary(s),
                // The declaration itself, so the answer to "where is it defined" carries what
                // the reader would open the file for next.
                source = SourceOf(s),
            }).ToArray(),
            truncated = found.Count > 25 ? found.Count - 25 : (int?)null,
        };
    }

    // ---------------------------------------------------------------------------------
    // Near misses, excerpts and the symbol's neighbourhood: what turns "no symbol named X"
    // into an answer, and one question into what used to take a Read of the file.

    /// <summary>
    /// Declarations whose name is close to the query — the same name in another case, a
    /// prefix, a substring either way, a typo two edits away. "No symbol named X" used to be
    /// the end of the road, after which the model read files to find the name it had
    /// nearly right.
    /// </summary>
    private static async Task<object[]> Suggest(string query)
    {
        var project = Current;
        if (project is null) return Array.Empty<object>();
        var wanted = query.Trim().Replace("*", "");
        var simple = wanted.Contains('.') ? wanted[(wanted.LastIndexOf('.') + 1)..] : wanted;
        if (simple.Length < 2) return Array.Empty<object>();
        var ranked = new List<(ISymbol sym, int rank)>();
        foreach (var sym in await SymbolFinder.FindSourceDeclarationsAsync(
                     project, name => Closeness(name, simple) is not null, SymbolFilter.TypeAndMember))
        {
            if (DeclaredOnlyInGenerated(sym) || sym.IsImplicitlyDeclared) continue;
            if (sym is IMethodSymbol { AssociatedSymbol: not null }) continue;
            ranked.Add((sym, Closeness(sym.Name, simple) ?? 9));
        }
        return ranked
            .OrderBy(r => r.rank).ThenBy(r => r.sym.Name.Length).ThenBy(r => r.sym.Name, StringComparer.Ordinal)
            .Take(8)
            .Select(r => (object)new
            {
                located = Located(r.sym),
                signature = r.sym.ToDisplayString(SymbolDisplayFormat.CSharpErrorMessageFormat),
            })
            .ToArray();
    }

    /// <summary>0 = the same name in another case … 4 = a typo; null = not close at all.</summary>
    private static int? Closeness(string name, string wanted)
    {
        if (name.Equals(wanted, StringComparison.OrdinalIgnoreCase)) return 0;
        if (name.StartsWith(wanted, StringComparison.OrdinalIgnoreCase)) return 1;
        if (name.Contains(wanted, StringComparison.OrdinalIgnoreCase)) return 2;
        if (name.Length >= 4 && wanted.Contains(name, StringComparison.OrdinalIgnoreCase)) return 3;
        // A typo: one edit away for a short name (`Runn` for `Run`), two for a longer one
        // (`Bulid` for `Build` — a transposition is two edits).
        var allowed = wanted.Length >= 5 ? 2 : 1;
        if (wanted.Length >= 4 && Math.Abs(name.Length - wanted.Length) <= allowed &&
            EditDistance(name.ToLowerInvariant(), wanted.ToLowerInvariant(), allowed) <= allowed) return 4;
        return null;
    }

    /// <summary>How many times <c>needle</c> occurs in <c>line</c> as a whole identifier.</summary>
    private static int Occurrences(string line, string needle)
    {
        var count = 0;
        var at = 0;
        while ((at = line.IndexOf(needle, at, StringComparison.Ordinal)) >= 0)
        {
            var before = at == 0 ? ' ' : line[at - 1];
            var afterEnd = at + needle.Length;
            var next = afterEnd >= line.Length ? ' ' : line[afterEnd];
            if (!(char.IsLetterOrDigit(before) || before == '_') && !(char.IsLetterOrDigit(next) || next == '_')) count++;
            at = afterEnd;
        }
        return count;
    }

    /// <summary>Levenshtein with a ceiling: a row that is already past <c>max</c> ends the search.</summary>
    private static int EditDistance(string a, string b, int max)
    {
        var prev = new int[b.Length + 1];
        var cur = new int[b.Length + 1];
        for (var j = 0; j <= b.Length; j++) prev[j] = j;
        for (var i = 1; i <= a.Length; i++)
        {
            cur[0] = i;
            var best = cur[0];
            for (var j = 1; j <= b.Length; j++)
            {
                var cost = a[i - 1] == b[j - 1] ? 0 : 1;
                cur[j] = Math.Min(Math.Min(cur[j - 1] + 1, prev[j] + 1), prev[j - 1] + cost);
                best = Math.Min(best, cur[j]);
            }
            if (best > max) return max + 1;
            (prev, cur) = (cur, prev);
        }
        return prev[b.Length];
    }

    /// <summary>
    /// The declaration as written, bounded: a member's whole text, a type's header up to its
    /// brace (its body is <c>members</c>). Forty lines or three thousand characters at most —
    /// a receipt of what is there, not a second Read.
    /// </summary>
    private static string? SourceOf(ISymbol s)
    {
        var reference = s.DeclaringSyntaxReferences.FirstOrDefault(r => !IsGenerated(r.SyntaxTree.FilePath))
                        ?? s.DeclaringSyntaxReferences.FirstOrDefault();
        if (reference is null) return null;
        SyntaxNode node;
        try { node = reference.GetSyntax(); }
        catch { return null; }
        // A field's or event's declarator sits inside its declaration; the declaration is the
        // readable unit ("private readonly IPlanner _planner;", not "_planner").
        if (node is VariableDeclaratorSyntax v && v.Parent?.Parent is MemberDeclarationSyntax member) node = member;
        string text;
        if (node is BaseTypeDeclarationSyntax type && !type.OpenBraceToken.IsKind(SyntaxKind.None))
        {
            text = type.SyntaxTree.GetText()
                .ToString(TextSpan.FromBounds(type.SpanStart, type.OpenBraceToken.SpanStart)).TrimEnd();
        }
        else
        {
            text = node.ToString();
        }
        var lines = text.Split('\n');
        if (lines.Length > 40) text = string.Join('\n', lines.Take(40)) + $"\n… ({lines.Length - 40} more lines)";
        if (text.Length > 3000) text = text[..3000] + "…";
        return text;
    }

    /// <summary>
    /// The member a position sits in — <c>MainViewModel.Run</c> — which is what "who calls
    /// this" is really asking. Lambdas and local functions are named by the method they live
    /// in; an accessor by its property.
    /// </summary>
    private static string? EnclosingOf(SemanticModel model, int position)
    {
        // By syntax, not by `GetEnclosingSymbol`: that answers the containing TYPE for a
        // position in a field's type, a parameter's type or a method's return type — the
        // declaration a reference most often sits in — because the member's body has not
        // begun there. The member whose declaration holds the token is what the reader wants.
        var token = model.SyntaxTree.GetRoot().FindToken(position);
        foreach (var node in token.Parent?.AncestorsAndSelf() ?? Enumerable.Empty<SyntaxNode>())
        {
            ISymbol? declared = node switch
            {
                FieldDeclarationSyntax f => f.Declaration.Variables.Count > 0 ? model.GetDeclaredSymbol(f.Declaration.Variables[0]) : null,
                EventFieldDeclarationSyntax e => e.Declaration.Variables.Count > 0 ? model.GetDeclaredSymbol(e.Declaration.Variables[0]) : null,
                BaseMethodDeclarationSyntax or BasePropertyDeclarationSyntax or EnumMemberDeclarationSyntax or DelegateDeclarationSyntax => model.GetDeclaredSymbol(node),
                BaseTypeDeclarationSyntax => model.GetDeclaredSymbol(node),
                _ => null,
            };
            if (declared is null) continue;
            return declared switch
            {
                IMethodSymbol { MethodKind: MethodKind.Constructor or MethodKind.StaticConstructor } ctor => $"{ctor.ContainingType.Name}()",
                IMethodSymbol { AssociatedSymbol: { } associated } => Owned(associated),
                INamedTypeSymbol t => t.Name,
                _ => Owned(declared),
            };
        }
        return null;

        static string Owned(ISymbol s) => s.ContainingType is null ? s.Name : $"{s.ContainingType.Name}.{s.Name}";
    }

    /// <summary>
    /// Hits that live in this workspace, one per symbol, with the ones from referenced
    /// assemblies counted. A project that has been built once is referenced by its OWN bin
    /// output, so every type it declares exists twice in this compilation — as source, and
    /// as metadata from the assembly it compiled to; source wins, being the copy a reader
    /// can open and the current one.
    /// </summary>
    private static (List<object> rows, int external) SourceOnly(IEnumerable<ISymbol> hits)
    {
        var bySource = new Dictionary<string, ISymbol>(StringComparer.Ordinal);
        foreach (var h in hits)
        {
            var key = h.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
            var inSource = h.Locations.Any(l => l.IsInSource);
            if (!bySource.TryGetValue(key, out var kept) || (inSource && !kept.Locations.Any(l => l.IsInSource)))
            {
                bySource[key] = h;
            }
        }
        var rows = new List<object>();
        var external = 0;
        foreach (var s in bySource.Values)
        {
            if (DeclaredOnlyInGenerated(s)) continue;
            if (s.Locations.Any(l => l.IsInSource)) rows.Add(Located(s));
            else external++;
        }
        return (rows, external);
    }

    /// <summary>
    /// A type's place in the type graph: what it extends, what it implements, and what in
    /// this workspace extends or implements it — transitively, which is the question
    /// "what would break if I changed this base class" actually asks.
    /// </summary>
    private static async Task<object> Hierarchy(int id, string symbol)
    {
        var (compilation, err) = await Compile();
        if (compilation is null) return new { id, ok = false, error = err };
        var found = (await Resolve(compilation, symbol)).OfType<INamedTypeSymbol>().ToList();
        if (found.Count == 0)
        {
            return new { id, ok = true, results = Array.Empty<object>(), note = $"no type named \"{symbol}\"", suggestions = await Suggest(symbol) };
        }
        var type = found[0];
        var bases = new List<object>();
        for (var b = type.BaseType; b is not null && b.SpecialType != SpecialType.System_Object; b = b.BaseType) bases.Add(Located(b));
        var derived = new List<ISymbol>();
        if (type.TypeKind == TypeKind.Interface)
        {
            derived.AddRange(await SymbolFinder.FindImplementationsAsync(type, _solution!));
            derived.AddRange(await SymbolFinder.FindDerivedInterfacesAsync(type, _solution!, transitive: true));
        }
        else
        {
            derived.AddRange(await SymbolFinder.FindDerivedClassesAsync(type, _solution!, transitive: true));
        }
        var (rows, external) = SourceOnly(derived);
        return new
        {
            id,
            ok = true,
            type = Located(type),
            kind = type.TypeKind.ToString().ToLowerInvariant(),
            @abstract = type.IsAbstract && type.TypeKind != TypeKind.Interface,
            @sealed = type.IsSealed && type.TypeKind == TypeKind.Class,
            bases,
            interfaces = type.AllInterfaces.Select(i => (object)Located(i)).ToArray(),
            results = rows,
            external,
            others = found.Count > 1 ? found.Skip(1).Select(Located).ToArray() : null,
        };
    }

    /// <summary>
    /// Declarations matching a wildcard — <c>*Repository</c>, <c>Get*Async</c> — for a name
    /// the model only half knows. Names only, never bodies.
    /// </summary>
    private static async Task<object> Search(int id, string pattern, int limit)
    {
        var project = Current;
        if (project is null) return new { id, ok = false, error = "nothing is loaded; call load first" };
        var trimmed = pattern.Trim();
        if (trimmed.Length == 0) return new { id, ok = false, error = "search needs a pattern" };
        var regex = new Regex("^" + Regex.Escape(trimmed).Replace("\\*", ".*").Replace("\\?", ".") + "$", RegexOptions.IgnoreCase);
        var matches = new List<ISymbol>();
        foreach (var sym in await SymbolFinder.FindSourceDeclarationsAsync(project, name => regex.IsMatch(name), SymbolFilter.TypeAndMember))
        {
            if (DeclaredOnlyInGenerated(sym) || sym.IsImplicitlyDeclared || sym is IMethodSymbol { AssociatedSymbol: not null }) continue;
            matches.Add(sym);
        }
        // Types first — a pattern like `*Repository` is nearly always after the types — then
        // members, each group by name.
        var ordered = matches
            .OrderBy(s => s is INamedTypeSymbol ? 0 : 1)
            .ThenBy(s => s.Name, StringComparer.Ordinal)
            .ThenBy(s => s.ContainingType?.Name ?? "", StringComparer.Ordinal)
            .ToList();
        var rows = ordered.Take(limit).Select(s => (object)new
        {
            located = Located(s),
            signature = s.ToDisplayString(SymbolDisplayFormat.CSharpErrorMessageFormat),
        }).ToList();
        return new { id, ok = true, results = rows, total = ordered.Count, truncated = ordered.Count > rows.Count ? ordered.Count - rows.Count : (int?)null };
    }

    /// <summary>
    /// The symbol renamed everywhere it is declared and used, as the new text of every file
    /// that changes. Nothing is written here: the caller writes the files — keeping their
    /// own line endings and byte-order marks — and tells this process they changed, so an
    /// index and a disk that disagree cannot happen half-way. Refused for a name that is
    /// not an identifier, a symbol not declared in this workspace, or a query that names
    /// several (a qualified name settles it). Comments and strings are left alone: a word
    /// that happens to be the name is not a use of it.
    /// </summary>
    private static async Task<object> Rename(int id, string symbol, string newName)
    {
        if (_solution is null || _projectId is null) return new { id, ok = false, error = "nothing is loaded; call load first" };
        var wanted = newName.Trim();
        if (!SyntaxFacts.IsValidIdentifier(wanted)) return new { id, ok = false, error = $"\"{wanted}\" is not a valid C# identifier" };
        var (compilation, err) = await Compile();
        if (compilation is null) return new { id, ok = false, error = err };
        var found = (await Resolve(compilation, symbol))
            .Where(s => s.Locations.Any(l => l.IsInSource) && !DeclaredOnlyInGenerated(s))
            .GroupBy(s => s.OriginalDefinition, SymbolEqualityComparer.Default)
            .Select(g => g.First())
            .ToList();
        if (found.Count == 0)
        {
            return new { id, ok = false, error = $"no symbol named \"{symbol}\" is declared in this workspace", suggestions = await Suggest(symbol) };
        }
        if (found.Count > 1)
        {
            return new
            {
                id, ok = false,
                error = $"\"{symbol}\" names {found.Count} symbols; qualify it (Type.Member) so exactly one is meant",
                candidates = found.Take(10).Select(s => (object)new
                {
                    located = Located(s),
                    signature = s.ToDisplayString(SymbolDisplayFormat.CSharpErrorMessageFormat),
                }).ToArray(),
            };
        }
        var target = found[0];
        if (target.Name == wanted) return new { id, ok = false, error = $"\"{symbol}\" is already named {wanted}" };

        var options = new SymbolRenameOptions(RenameOverloads: false, RenameInStrings: false, RenameInComments: false, RenameFile: false);
        var renamed = await Renamer.RenameSymbolAsync(_solution, target, options, wanted);
        var files = new List<object>();
        var generatedTouched = 0;
        foreach (var projectChanges in renamed.GetChanges(_solution).GetProjectChanges())
        {
            foreach (var docId in projectChanges.GetChangedDocuments())
            {
                var before = _solution.GetDocument(docId);
                var after = renamed.GetDocument(docId);
                if (before is null || after is null) continue;
                // A generated file that uses the symbol — a XAML partial's `InitializeComponent`
                // wiring, say — is the build's to regenerate, from a source this rename cannot
                // reach. Counted, so the caller can say the XAML needs the same change.
                if (IsGenerated(after.FilePath)) { generatedTouched++; continue; }
                var oldText = await before.GetTextAsync();
                var newText = await after.GetTextAsync();
                // Line by line, not `GetTextChanges`: the renamed document's text is not an
                // incremental edit of the old one, so that answered with one change that
                // replaced the whole file. A rename never changes the line count, and the
                // places are the lines that differ — with the new name counted where one line
                // holds it twice.
                var oldLines = oldText.Lines.Select(l => l.ToString()).ToList();
                var newLines = newText.Lines.Select(l => l.ToString()).ToList();
                var changedLines = new List<int>();
                var places = 0;
                for (var i = 0; i < Math.Min(oldLines.Count, newLines.Count); i++)
                {
                    if (oldLines[i] == newLines[i]) continue;
                    changedLines.Add(i + 1);
                    places += Math.Max(1, Occurrences(newLines[i], wanted) - Occurrences(oldLines[i], wanted));
                }
                if (changedLines.Count == 0 && oldLines.Count == newLines.Count) continue;
                files.Add(new { file = after.FilePath, text = newText.ToString(), places, lines = changedLines.Take(50).ToArray() });
            }
        }
        return new
        {
            id,
            ok = true,
            symbol = Located(target),
            signature = target.ToDisplayString(SymbolDisplayFormat.CSharpErrorMessageFormat),
            newName = wanted,
            files,
            generated = generatedTouched,
        };
    }

    private static string? Summary(ISymbol s)
    {
        var xml = s.GetDocumentationCommentXml();
        if (string.IsNullOrWhiteSpace(xml)) return null;
        var start = xml.IndexOf("<summary>", StringComparison.Ordinal);
        var end = xml.IndexOf("</summary>", StringComparison.Ordinal);
        if (start < 0 || end < 0 || end <= start) return null;
        var text = xml[(start + 9)..end];
        return string.Join(' ', text.Split('\n').Select(l => l.Trim()).Where(l => l.Length > 0));
    }

    private static async Task<object> References(int id, string symbol, int limit)
    {
        var (compilation, err) = await Compile();
        if (compilation is null) return new { id, ok = false, error = err };
        var found = await Resolve(compilation, symbol);
        if (found.Count == 0)
        {
            return new { id, ok = true, results = Array.Empty<object>(), note = $"no symbol named \"{symbol}\"", suggestions = await Suggest(symbol) };
        }

        var hits = new List<(string file, int line, string text, string? within)>();
        var total = 0;
        // An unqualified name can resolve to several symbols at once — an interface member
        // and every implementation of it — and FindReferences cascades between those, so
        // the same use came back once per symbol. One place is one row.
        var seen = new HashSet<(string, int)>();
        foreach (var sym in found.Take(5))
        {
            foreach (var reference in await SymbolFinder.FindReferencesAsync(sym, _solution!))
            {
                foreach (var loc in reference.Locations)
                {
                    if (IsGenerated(loc.Document.FilePath)) continue;
                    if (!seen.Add((loc.Document.FilePath ?? "", loc.Location.SourceSpan.Start))) continue;
                    total++;
                    if (hits.Count >= limit) continue;
                    var span = loc.Location.GetLineSpan();
                    var text = await loc.Document.GetTextAsync();
                    var model = await loc.Document.GetSemanticModelAsync();
                    var lineIndex = span.StartLinePosition.Line;
                    hits.Add((
                        span.Path,
                        lineIndex + 1,
                        lineIndex < text.Lines.Count ? text.Lines[lineIndex].ToString().Trim() : "",
                        model is null ? null : EnclosingOf(model, loc.Location.SourceSpan.Start)));
                }
            }
        }
        // In file order, so the reader sees each caller's uses together; the member each use
        // sits in rides along, which is what "who calls this" was asking.
        var rows = hits
            .OrderBy(h => h.file, StringComparer.OrdinalIgnoreCase).ThenBy(h => h.line)
            .Select(h => (object)new { file = h.file, line = h.line, text = h.text, @in = h.within })
            .ToList();
        return new { id, ok = true, results = rows, total, truncated = total > rows.Count ? total - rows.Count : (int?)null };
    }

    private static async Task<object> Implementations(int id, string symbol)
    {
        var (compilation, err) = await Compile();
        if (compilation is null) return new { id, ok = false, error = err };
        var found = await Resolve(compilation, symbol);
        var hits = new List<ISymbol>();
        foreach (var sym in found.Take(5))
        {
            if (sym is INamedTypeSymbol type)
            {
                hits.AddRange(await SymbolFinder.FindImplementationsAsync(type, _solution!));
                hits.AddRange(await SymbolFinder.FindDerivedClassesAsync(type, _solution!));
            }
            else
            {
                hits.AddRange(await SymbolFinder.FindImplementationsAsync(sym, _solution!));
                hits.AddRange(await SymbolFinder.FindOverridesAsync(sym, _solution!));
            }
        }

        // The question is "what in THIS project implements it", so framework types that
        // happen to implement it too — ObservableCollection, ExpandoObject, DataRowView —
        // are counted rather than listed. Dropping them silently would be the same mistake
        // this file has already made once; a reader who wanted them is told they exist.
        // (Source over its compiled twin, one row per symbol: see `SourceOnly`.)
        var (rows, external) = SourceOnly(hits);
        var note = external == 0 ? null
            : $"{external} more implementations live in referenced assemblies rather than in " +
              "this workspace, and are not listed.";
        return new
        {
            id, ok = true, results = rows, note,
            suggestions = found.Count == 0 ? await Suggest(symbol) : null,
        };
    }

    private static object Members(int id, string symbol)
    {
        var project = Current;
        if (project is null) return new { id, ok = false, error = "nothing is loaded; call load first" };
        var compilation = project.GetCompilationAsync().Result;
        if (compilation is null) return new { id, ok = false, error = "the compilation could not be built" };

        var found = Resolve(compilation, symbol).Result.OfType<INamedTypeSymbol>().ToList();
        if (found.Count == 0)
        {
            return new { id, ok = true, results = Array.Empty<object>(), note = $"no type named \"{symbol}\"", suggestions = Suggest(symbol).Result };
        }
        var type = found[0];
        return new
        {
            id,
            ok = true,
            type = Located(type),
            baseType = type.BaseType?.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat),
            interfaces = type.Interfaces.Select(i => i.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)).ToArray(),
            results = type.GetMembers()
                .Where(m => !m.IsImplicitlyDeclared && m.DeclaredAccessibility != Accessibility.Private)
                // Property getters and setters are members of the type in Roslyn's view, and
                // listing them triples the answer without adding a fact: `get_Name` beside
                // `Name` tells a reader nothing they did not have. One real type here reported
                // 51 rows for a surface a person would describe in about twenty.
                .Where(m => m is not IMethodSymbol { AssociatedSymbol: not null })
                .Where(m => !DeclaredOnlyInGenerated(m))
                .Select(m => new
                {
                    signature = m.ToDisplayString(SymbolDisplayFormat.CSharpErrorMessageFormat),
                    kind = m.Kind.ToString(),
                    line = m.Locations.FirstOrDefault(l => l.IsInSource)?.GetLineSpan().StartLinePosition.Line + 1 ?? 0,
                })
                .ToArray(),
            others = found.Count > 1 ? found.Skip(1).Select(Located).ToArray() : null,
        };
    }

    // ---------------------------------------------------------------------------------

    /// <summary>
    /// Re-reads the named files from disk into the loaded solution: changed ones are replaced,
    /// new ones added, missing ones removed. This is what makes an edit cost a parse of one
    /// file rather than a reload of the tree — on the projects this runs against a reload is
    /// 0.5–12 s, and after an edit the next question is usually about that edit.
    /// </summary>
    private static object Sync(int id, JsonElement root)
    {
        if (_solution is null || _projectId is null) return new { id, ok = false, error = "nothing is loaded; call load first" };
        if (!root.TryGetProperty("files", out var arr) || arr.ValueKind != JsonValueKind.Array)
        {
            return new { id, ok = false, error = "sync needs a files array" };
        }
        var (updated, added, removed) = ApplySync(arr);
        return new { id, ok = true, updated, added, removed };
    }

    private static (int updated, int added, int removed) ApplySync(JsonElement files)
    {
        int updated = 0, added = 0, removed = 0;
        var solution = _solution!;
        foreach (var el in files.EnumerateArray())
        {
            var raw = el.GetString();
            if (string.IsNullOrWhiteSpace(raw)) continue;
            string full;
            try { full = Path.GetFullPath(Path.IsPathRooted(raw) ? raw : Path.Combine(_root, raw)); }
            catch { continue; }
            if (!full.EndsWith(".cs", StringComparison.OrdinalIgnoreCase)) continue;
            // A file outside the loaded tree is not part of this compilation — another folder
            // of a multi-folder workspace, say — and adding it would make it one.
            if (!IsUnderRoot(full)) continue;
            var project = solution.GetProject(_projectId!)!;
            var doc = project.Documents.FirstOrDefault(d =>
                d.FilePath is not null &&
                string.Equals(Path.GetFullPath(d.FilePath), full, StringComparison.OrdinalIgnoreCase));
            if (File.Exists(full))
            {
                string text;
                try { text = File.ReadAllText(full); }
                catch { continue; }
                if (doc is null)
                {
                    if (IsSkippedPath(full)) continue;
                    solution = solution.AddDocument(DocumentId.CreateNewId(_projectId!), Path.GetFileName(full),
                        text, filePath: full);
                    added++;
                }
                else
                {
                    solution = solution.WithDocumentText(doc.Id, SourceText.From(text));
                    updated++;
                }
            }
            else if (doc is not null)
            {
                solution = solution.RemoveDocument(doc.Id);
                removed++;
            }
            _touched.Add(full);
        }
        _solution = solution;
        return (updated, added, removed);
    }

    /// <summary>
    /// The compile errors an edit introduced, in a few hundred milliseconds instead of the
    /// seconds a build takes.
    ///
    /// "Introduced" is the honest scope. This compilation is built by hand from the source
    /// plus whatever the project last built into <c>bin/</c> and <c>obj/</c>, so on a tree
    /// with a missing package or a source generator it has errors the real build does not.
    /// Those were recorded at load, keyed without line numbers so an edit that moves them
    /// does not resurrect them, and are not reported — unless the tree was essentially clean
    /// at load (few enough errors that this compilation is plainly faithful), in which case
    /// pre-existing errors in a file the model has TOUCHED are reported too, because it is
    /// working there and will be asked about them by the build anyway.
    ///
    /// Takes an optional <c>files</c> array and applies it as <c>sync</c> first, so one
    /// round trip covers the common case.
    /// </summary>
    private static async Task<object> Diagnostics(int id, JsonElement root)
    {
        if (_solution is null || _projectId is null) return new { id, ok = false, error = "nothing is loaded; call load first" };
        if (root.TryGetProperty("files", out var arr) && arr.ValueKind == JsonValueKind.Array) ApplySync(arr);
        // `all`: everything, baseline included — what a person checking this index wants.
        var all = root.TryGetProperty("all", out var allEl) && allEl.ValueKind == JsonValueKind.True;
        // `everything`: bind the whole tree rather than only what the touched files can have
        // broken — the model asking "does it compile now?" — with the baseline still honoured.
        var everything = root.TryGetProperty("everything", out var evEl) && evEl.ValueKind == JsonValueKind.True;

        var sw = Stopwatch.StartNew();
        var (compilation, err) = await Compile();
        if (compilation is null) return new { id, ok = false, error = err };
        var (errors, bound) = ErrorsAfterEdits(compilation, all || everything);
        var baseline = _baseline is null ? new HashSet<string>(StringComparer.Ordinal) : await _baseline;
        // Only a tree with NO pre-existing errors earns the stricter reading, in which an old
        // error in a file the model touched is reported too. A source generator this
        // compilation cannot run leaves a handful of errors in files the model will edit
        // (`[GeneratedRegex]` partials, measured on a real backend), and reporting those as
        // the model's own would send it fixing what is not broken.
        var faithful = baseline.Count == 0;

        var rows = new List<object>();
        var suppressed = 0;
        var reported = 0;
        foreach (var d in errors
                     .OrderBy(d => d.Location.SourceTree?.FilePath ?? "", StringComparer.OrdinalIgnoreCase)
                     .ThenBy(d => d.Location.SourceSpan.Start))
        {
            var path = d.Location.SourceTree?.FilePath;
            // An error inside a generated file is the build's to explain, never an edit's.
            if (IsGenerated(path)) { suppressed++; continue; }
            var touched = path is not null && _touched.Contains(SafeFullPath(path));
            if (!all && baseline.Contains(ErrorKey(d)) && !(faithful && touched)) { suppressed++; continue; }
            reported++;
            if (rows.Count >= 30) continue;
            var span = d.Location.GetLineSpan();
            rows.Add(new
            {
                file = path,
                line = span.StartLinePosition.Line + 1,
                column = span.StartLinePosition.Character + 1,
                code = d.Id,
                message = d.GetMessage(),
            });
        }
        return new
        {
            id, ok = true, errors = rows, reported, suppressed, total = errors.Count,
            baseline = baseline.Count, faithful, bound, trees = compilation.SyntaxTrees.Count(),
            ms = sw.ElapsedMilliseconds,
        };
    }

    /// <summary>
    /// The errors worth looking for after the touched files changed, and how many files were
    /// bound to find them.
    ///
    /// Binding every method body in the tree is what a full <c>GetDiagnostics</c> does, and
    /// on a 276-file backend it is four seconds — a third of the build it replaces, not a
    /// tenth. An edit can only have broken a file that names something the edit declared, so
    /// the touched files are bound together with every file whose identifier tokens include
    /// a name declared in them (a text match over already-parsed trees: milliseconds), and
    /// nothing else. A tree touched in forty places or asked for in full is bound whole.
    /// </summary>
    private static (List<Diagnostic> errors, int bound) ErrorsAfterEdits(Compilation compilation, bool all)
    {
        static bool IsError(Diagnostic d) => d.Severity == DiagnosticSeverity.Error && !d.IsSuppressed;
        var trees = compilation.SyntaxTrees.ToList();
        var touched = trees
            .Where(t => t.FilePath.Length > 0 && _touched.Contains(SafeFullPath(t.FilePath)))
            .ToHashSet();
        if (all || touched.Count == 0 || touched.Count > 40)
        {
            return (compilation.GetDiagnostics().Where(IsError).ToList(), trees.Count);
        }

        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var tree in touched)
        {
            foreach (var node in tree.GetRoot().DescendantNodes())
            {
                switch (node)
                {
                    case BaseTypeDeclarationSyntax t: names.Add(t.Identifier.Text); break;
                    case MethodDeclarationSyntax m: names.Add(m.Identifier.Text); break;
                    case PropertyDeclarationSyntax p: names.Add(p.Identifier.Text); break;
                    case EventDeclarationSyntax e: names.Add(e.Identifier.Text); break;
                    case DelegateDeclarationSyntax d: names.Add(d.Identifier.Text); break;
                    case EnumMemberDeclarationSyntax em: names.Add(em.Identifier.Text); break;
                    case VariableDeclaratorSyntax v when v.Parent?.Parent is FieldDeclarationSyntax or EventFieldDeclarationSyntax:
                        names.Add(v.Identifier.Text); break;
                    case ParameterSyntax prm when prm.Parent?.Parent is RecordDeclarationSyntax:
                        names.Add(prm.Identifier.Text); break;
                }
            }
        }
        var candidates = trees
            .Where(t => touched.Contains(t) ||
                        (!IsGenerated(t.FilePath) && t.GetRoot().DescendantTokens()
                            .Any(tok => tok.IsKind(SyntaxKind.IdentifierToken) && names.Contains(tok.Text))))
            .ToList();
        var errors = candidates
            .AsParallel()
            .SelectMany(t => compilation.GetSemanticModel(t).GetDiagnostics().Where(IsError))
            .ToList();
        return (errors, candidates.Count);
    }

    private static string SafeFullPath(string path)
    {
        try { return Path.GetFullPath(path); }
        catch { return path; }
    }

    private static bool IsUnderRoot(string full)
    {
        var root = SafeFullPath(_root).TrimEnd('\\', '/') + Path.DirectorySeparatorChar;
        return full.StartsWith(root, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>File, code and message — no line, so an error that merely moved is the same error.</summary>
    private static string ErrorKey(Diagnostic d)
    {
        var path = d.Location.SourceTree?.FilePath;
        var file = path is null ? "" : SafeFullPath(path).ToLowerInvariant();
        return $"{file}|{d.Id}|{d.GetMessage()}";
    }

    private static HashSet<string> ErrorKeys(Compilation compilation)
    {
        var keys = new HashSet<string>(StringComparer.Ordinal);
        try
        {
            foreach (var d in compilation.GetDiagnostics())
            {
                if (d.Severity == DiagnosticSeverity.Error && !d.IsSuppressed) keys.Add(ErrorKey(d));
            }
        }
        catch
        {
            // A compilation that cannot even be diagnosed has no baseline; every error is then
            // reported, which is the noisier of the two ways to be wrong and the safer one.
        }
        return keys;
    }
}
