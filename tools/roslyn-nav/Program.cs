using System.Collections.Immutable;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.FindSymbols;
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

        _workspace = workspace;
        _solution = solution;
        _projectId = projectId;
        _root = path;

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

        return new { id, ok = true, files = sources.Count, references = refs.Count, problems = _loadProblems };
    }

    private static IEnumerable<string> EnumerateSources(string root)
    {
        // `.claude\worktrees` holds whole copies of the tree: on one 2423-file project 39% of
        // what loaded were stale duplicates of files also loaded from their real path, and a
        // duplicate costs a genuine hit its place in a limited result.
        var skip = new[] { "\\bin\\", "\\obj\\", "\\node_modules\\", "\\.git\\", "\\.privatecode\\",
                           "\\.claude\\worktrees\\" };
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

        // Ours: the BCL, as reference assemblies embedded in this binary.
        //
        // This used to scan `AppContext.BaseDirectory` for `System.*.dll`, on the reasoning
        // that a self-contained publish drops the runtime beside the exe. `PublishSingleFile`
        // does the opposite — it packs the runtime INSIDE the exe — so that directory holds
        // exactly one file and the loop matched nothing, on every machine, always. A
        // compilation with no `System.Object` does not fail; it quietly loses the ability to
        // classify a base-type list, which is how `members PlanItem` reported no interfaces
        // for `class PlanItem : INotifyPropertyChanged` and `implementations` answered an
        // empty list with ok:true. Embedded resources cannot be emptied by a publish setting.
        foreach (var info in Net100.ReferenceInfos.All)
        {
            var name = Path.GetFileNameWithoutExtension(info.FileName);
            if (seen.Add(name)) refs.Add(info.Reference);
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
        var loc = s.Locations.FirstOrDefault(l => l.IsInSource);
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

        // A project that has been built once is referenced by its OWN bin output, so every
        // type it declares exists twice in this compilation: as source, and as metadata from
        // the assembly it compiled to. Both are real symbols and both match, so the raw answer
        // listed each of this project's four view models twice. Source wins — it is the copy
        // the reader can open, and it is current, which the compiled twin may not be.
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

        // The question is "what in THIS project implements it", so framework types that
        // happen to implement it too — ObservableCollection, ExpandoObject, DataRowView —
        // are counted rather than listed. Dropping them silently would be the same mistake
        // this file has already made once; a reader who wanted them is told they exist.
        var rows = new List<object>();
        var external = 0;
        foreach (var s in bySource.Values)
        {
            if (s.Locations.Any(l => l.IsInSource)) rows.Add(Located(s));
            else external++;
        }
        var note = external == 0 ? null
            : $"{external} more implementations live in referenced assemblies rather than in " +
              "this workspace, and are not listed.";
        return new { id, ok = true, results = rows, note };
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
                // Property getters and setters are members of the type in Roslyn's view, and
                // listing them triples the answer without adding a fact: `get_Name` beside
                // `Name` tells a reader nothing they did not have. One real type here reported
                // 51 rows for a surface a person would describe in about twenty.
                .Where(m => m is not IMethodSymbol { AssociatedSymbol: not null })
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
