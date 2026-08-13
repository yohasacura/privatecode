using System.Collections.Immutable;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.FindSymbols;

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
        "status" => new { id, ok = true, loaded = _solution is not null, root = _root, problems = _loadProblems },
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
    /// References are gathered from two places and neither is guaranteed: the runtime this
    /// helper itself ships with (which supplies the BCL), and any assemblies the target
    /// project has already built into its own bin folders (which supply its NuGet
    /// dependencies). A project that has never been built still loads — every question is
    /// then answered from syntax and from the types it can see, and `status` reports what
    /// was missing rather than pretending the answers are complete.
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

        _workspace = workspace;
        _solution = solution;
        _projectId = projectId;
        _root = path;
        return new { id, ok = true, files = sources.Count, references = refs.Count, problems = _loadProblems };
    }

    private static IEnumerable<string> EnumerateSources(string root)
    {
        var skip = new[] { "\\bin\\", "\\obj\\", "\\node_modules\\", "\\.git\\", "\\.privatecode\\" };
        foreach (var f in Directory.EnumerateFiles(root, "*.cs", SearchOption.AllDirectories))
        {
            var padded = f.Replace('/', '\\');
            if (skip.Any(s => padded.Contains(s, StringComparison.OrdinalIgnoreCase))) continue;
            yield return f;
        }
    }

    /// <summary>
    /// The BCL from this helper's own runtime, plus whatever the target has already built.
    /// Duplicate simple names are dropped — two copies of the same assembly is an error
    /// Roslyn reports instead of an answer.
    /// </summary>
    private static List<MetadataReference> MetadataReferences(string root, List<string> problems)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var refs = new List<MetadataReference>();

        void Add(string dll)
        {
            var name = Path.GetFileNameWithoutExtension(dll);
            if (!seen.Add(name)) return;
            try { refs.Add(MetadataReference.CreateFromFile(dll)); }
            catch { seen.Remove(name); }
        }

        // Ours: shipped beside this exe by the self-contained publish.
        foreach (var dll in Directory.EnumerateFiles(AppContext.BaseDirectory, "*.dll"))
        {
            var n = Path.GetFileName(dll);
            if (n.StartsWith("System.", StringComparison.Ordinal) ||
                n.StartsWith("Microsoft.CSharp", StringComparison.Ordinal) ||
                n.Equals("netstandard.dll", StringComparison.OrdinalIgnoreCase) ||
                n.Equals("mscorlib.dll", StringComparison.OrdinalIgnoreCase)) Add(dll);
        }

        // Theirs: the third-party surface, only available if they have built once.
        var binDlls = Directory.EnumerateDirectories(root, "bin", SearchOption.AllDirectories)
            .SelectMany(d => Directory.EnumerateFiles(d, "*.dll", SearchOption.AllDirectories))
            .ToList();
        if (binDlls.Count == 0)
        {
            problems.Add(
                "this project has no build output, so third-party types are unknown to the " +
                "index. Symbols defined in the source still resolve; anything from a package " +
                "may not. Building the project once makes these answers complete.");
        }
        foreach (var dll in binDlls) Add(dll);

        return refs;
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
            if (!wanted.Contains('.') || full.EndsWith(wanted, StringComparison.Ordinal) ||
                full.Contains(wanted, StringComparison.Ordinal))
            {
                matches.Add(sym);
            }
        }
        return matches;
    }

    private static object Located(ISymbol s)
    {
        var loc = s.Locations.FirstOrDefault(l => l.IsInSource);
        var span = loc?.GetLineSpan();
        return new
        {
            name = s.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat),
            kind = s.Kind.ToString(),
            file = span?.Path,
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
        if (found.Count == 0) return new { id, ok = true, results = Array.Empty<object>(), note = $"no symbol named \"{symbol}\"" };
        return new
        {
            id,
            ok = true,
            results = found.Take(25).Select(s => new
            {
                located = Located(s),
                signature = s.ToDisplayString(SymbolDisplayFormat.CSharpErrorMessageFormat),
                docs = Summary(s),
            }).ToArray(),
            truncated = found.Count > 25 ? found.Count - 25 : (int?)null,
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
        if (found.Count == 0) return new { id, ok = true, results = Array.Empty<object>(), note = $"no symbol named \"{symbol}\"" };

        var rows = new List<object>();
        var total = 0;
        foreach (var sym in found.Take(5))
        {
            foreach (var reference in await SymbolFinder.FindReferencesAsync(sym, _solution!))
            {
                foreach (var loc in reference.Locations)
                {
                    total++;
                    if (rows.Count >= limit) continue;
                    var span = loc.Location.GetLineSpan();
                    var text = loc.Document.GetTextAsync().Result;
                    var lineIndex = span.StartLinePosition.Line;
                    rows.Add(new
                    {
                        file = span.Path,
                        line = lineIndex + 1,
                        text = lineIndex < text.Lines.Count ? text.Lines[lineIndex].ToString().Trim() : "",
                    });
                }
            }
        }
        return new { id, ok = true, results = rows, total, truncated = total > rows.Count ? total - rows.Count : (int?)null };
    }

    private static async Task<object> Implementations(int id, string symbol)
    {
        var (compilation, err) = await Compile();
        if (compilation is null) return new { id, ok = false, error = err };
        var found = await Resolve(compilation, symbol);
        var rows = new List<object>();
        foreach (var sym in found.Take(5))
        {
            if (sym is INamedTypeSymbol type)
            {
                foreach (var impl in await SymbolFinder.FindImplementationsAsync(type, _solution!))
                    rows.Add(Located(impl));
                foreach (var derived in await SymbolFinder.FindDerivedClassesAsync(type, _solution!))
                    rows.Add(Located(derived));
            }
            else
            {
                foreach (var impl in await SymbolFinder.FindImplementationsAsync(sym, _solution!))
                    rows.Add(Located(impl));
                foreach (var over in await SymbolFinder.FindOverridesAsync(sym, _solution!))
                    rows.Add(Located(over));
            }
        }
        return new { id, ok = true, results = rows };
    }

    private static object Members(int id, string symbol)
    {
        var project = Current;
        if (project is null) return new { id, ok = false, error = "nothing is loaded; call load first" };
        var compilation = project.GetCompilationAsync().Result;
        if (compilation is null) return new { id, ok = false, error = "the compilation could not be built" };

        var found = Resolve(compilation, symbol).Result.OfType<INamedTypeSymbol>().ToList();
        if (found.Count == 0) return new { id, ok = true, results = Array.Empty<object>(), note = $"no type named \"{symbol}\"" };
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
}
