# Vendored C# navigator

`roslyn-nav.exe` is the semantic half of code navigation: it answers "where is this
defined", "what references it", "what implements it" and "what is on this type" about a C#
tree. It is what `csharp_nav` talks to.

## What this is and where it came from

- **Built from source in this repository:** `tools/roslyn-nav/`
- **Roslyn:** `Microsoft.CodeAnalysis.CSharp` and `.CSharp.Workspaces` 4.14.0 (MIT)
- **Runtime:** .NET 10, published self-contained for `win-x64` as a single file
- **Size:** ~92 MB

Rebuild it with:

```powershell
cd tools\roslyn-nav
dotnet publish -c Release -r win-x64 --self-contained true
copy bin\Release\net10.0\win-x64\publish\roslyn-nav.exe ..\..\vendor\roslyn\
```

## Why self-contained, and why that size

The work laptop has no .NET SDK and is not getting one, so the runtime travels with the
binary. That is where nearly all 92 MB goes; the navigator's own code is a few hundred
kilobytes.

`PublishTrimmed` is deliberately OFF. Roslyn resolves a great deal by reflection, and a
trimmed build fails at runtime — on the machine that has no SDK to diagnose it with. Size
is the cheaper thing to spend here.

## Why not MSBuildWorkspace

The obvious way to load a C# project is `MSBuildWorkspace`, and it needs an installed SDK
to locate MSBuild — the exact dependency being avoided. So the compilation is assembled by
hand: every `.cs` file under the root, plus metadata references from this binary's own
runtime (the BCL) and from whatever assemblies the target project has already built (its
packages).

The consequence is worth knowing: **a project that has never been built resolves its own
symbols but may not resolve types from its packages.** That is reported in the `load`
response and passed through to the model as a note, rather than being presented as a
complete answer.

## Optional

This binary is optional. A build without it stages nothing, sets no `PRIVATECODE_ROSLYN`,
and `csharp_nav` says C# navigation is unavailable and points at `search_code`. Ninety-two
megabytes only earns its place on a machine that works on C#.
