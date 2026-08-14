# sql-probe.exe

Built from `tools/sql-probe/` in this repository — the source is here, not downloaded.

```powershell
cd tools\sql-probe
dotnet publish -c Release -o ..\..\vendor\sql
```

- .NET 10, `win-x64`, self-contained, single file, **not** trimmed.
- `Microsoft.Data.SqlClient` 6.0.1.
- Ships as **two** files. `Microsoft.Data.SqlClient.SNI.dll` is a native library and
  `PublishSingleFile` leaves native libraries beside the exe rather than inside it. Copy both
  or the process starts and cannot connect to anything.

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
