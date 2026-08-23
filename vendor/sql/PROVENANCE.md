# sql-probe.exe

Built from `tools/sql-probe/` in this repository — the source is here, not downloaded.

```powershell
cd tools\sql-probe
dotnet publish -c Release -o ..\..\vendor\sql
```

- .NET 10, `win-x64`, self-contained, single file, **not** trimmed.
- `Microsoft.Data.SqlClient` 6.0.1.
- `Microsoft.SqlServer.DacFx` 162.5.57, for deploying a built `.sqlproj`.
- Ships as **three** files. `PublishSingleFile` leaves native libraries beside the exe rather
  than inside it, and there are two: `Microsoft.Data.SqlClient.SNI.dll` and, since DacFx
  arrived, `SqlServerSpatial160.dll`. Copy all of them or the process starts and cannot
  connect to anything.

  **This list has already changed once**, from one native library to two, the moment a
  package was added — which is why `bundle.mjs` stages the whole directory rather than a list
  of names, and why the three places that CHECK the list (`sql-process.ts`, `main.rs`,
  `bundle.mjs`) all name it explicitly. If a future package adds a third, the staging keeps
  working and the checks are what tell you.

## Two settings that are not the same as roslyn-nav's, and why

`InvariantGlobalization` is **off** here. The data provider refuses to open a connection under
invariant mode — "Globalization Invariant Mode is not supported" — because it needs real
collation data. That costs ICU in the published file, and it means the machine's locale
reaches the process, which is why every value is formatted with `CultureInfo.InvariantCulture`
on the way out: the first run on this Russian-locale machine returned a decimal as `1200,50`,
and a reader deciding whether that is one number or two has been handed a bug.

`PublishTrimmed` is off for the same reason as roslyn-nav: the provider resolves a great deal
by reflection.

## What it will not do

There is no operation that changes anything. `query` refuses a statement containing a writing
keyword outside a comment or a literal, and then runs what is left inside a transaction it
always rolls back — the filter is the readable error, the rollback is the guarantee.

This is a deliberate boundary, not an unfinished one. The undo history in this tool is a git
snapshot of the working tree; a database is not in the working tree, and no snapshot taken
afterwards can undo an `UPDATE` that has already committed. Writing to a database should be
its own capability, with its own permission, designed on purpose.

## LocalDB

`(localdb)\Name` is resolved to the named pipe the instance is listening on, by asking
`sqllocaldb`, and a stopped instance is started first. The provider is supposed to do this
itself and did not in a self-contained build — `(localdb)\MSSQLLocalDB` came back as SQL error
53, "no network path", with the native SNI library present and `sqlcmd` connecting to the same
instance from the same shell. The pipe name changes on every start, so it is re-read on every
`connect`.

## Verified

Against a SQL Server 2025 LocalDB instance (17.0.4025) with a two-table schema, a foreign key,
a view and a stored procedure: `connect`, `schema` (columns with types, nullability, identity,
primary keys, plus routines and foreign keys), `describe` (returns the procedure body), and
`query`. The guard was checked on four statements — `UPDATE` refused, `SELECT 1; DROP TABLE`
refused, the word `delete` inside a string literal allowed, and the word `delete` inside a
comment allowed — and the data was confirmed unchanged afterwards.

## Deploying a `.sqlproj`

`script` and `publish` are one function differing by a boolean, so a dry run cannot drift
from the thing it describes. Two of DacFx's guards stay on and are not exposed:
`BlockOnPossibleDataLoss` refuses a deployment that would discard rows, and
`DropObjectsNotInSource` stays off so a deployment adds and alters but never removes an
object the project happens not to mention.

Verified against the LocalDB instance above, with a `.sqlproj` built by
`Microsoft.Build.Sql/2.2.0`: the dry run produced a real script (rebuild of `dbo.Invoice` to
add a column) and left all six columns as they were; `publish` then applied it, the seventh
column appeared, and both rows survived the table rebuild with their totals intact.

Note for anyone rebuilding the fixture: `Microsoft.Build.Sql/1.0.0` does not build under
.NET SDK 10 — it imports a `NuGet.Build.Tasks.Pack` path that has moved — and 2.2.0 needs
`<DSP>` naming a schema provider explicitly.

## Where this file comes from now

It is **not committed**. `scripts/fetch-vendor.mjs` recreates it from the source named above,
verifying the publisher's own SHA-256 before staging, and CI runs that script before every
build. The binaries were removed from git because they total 382 MB and one of them is past
GitHub's hard 100 MiB per-file limit, so a repository carrying them cannot be pushed.

Nothing about the vendoring rationale changed: the machine the app RUNS on still has no
toolchain, and the release still ships this exact pinned binary. What changed is that the
machine that BUILDS it fetches from the publisher and checks the hash first — which is a
stronger guarantee than a blob somebody committed once.
