using System.Data;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Data.SqlClient;

namespace SqlProbe;

/// <summary>
/// One long-lived process answering questions about a SQL Server database, over ndjson on
/// stdio — the same shape as the agent sidecar and as `roslyn-nav`.
///
/// It READS. There is no operation here that changes anything, and that is a design decision
/// rather than an unfinished feature: the undo story in this tool is a git snapshot of the
/// working tree, a database is not in the working tree, and an `UPDATE` without a `WHERE` is
/// not recoverable by anything this program could offer afterwards. Changing data belongs
/// behind its own explicit permission, designed on purpose, not next to a read.
///
/// Even so `query` runs inside a transaction that is always rolled back. The statement filter
/// below is an early, readable error; the rollback is the actual guarantee, because a filter
/// that parses SQL with string comparisons is a filter that will eventually be wrong.
/// </summary>
public static class Program
{
    private static string _connectionString = "";
    private static string _server = "";
    private static string _database = "";

    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    /// <summary>Rows returned by one `query`, past which the answer is truncated with a note.
    /// A model that asked for a thousand rows wanted an aggregate and phrased it wrong.</summary>
    private const int DefaultRowLimit = 50;
    private const int MaxRowLimit = 500;
    /// <summary>A cell longer than this is clipped: one NVARCHAR(MAX) can carry a document,
    /// and a table where one cell is a document is unreadable anyway.</summary>
    private const int MaxCellChars = 300;
    private const int CommandTimeoutSeconds = 30;

    public static async Task<int> Main()
    {
        string? line;
        while ((line = await Console.In.ReadLineAsync()) is not null)
        {
            if (line.Length == 0) continue;
            object response;
            var id = 0;
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
        "connect" => await Connect(id, Arg(root, "connectionString")),
        "schema" => await Schema(id),
        "describe" => await Describe(id, Arg(root, "object")),
        "query" => await Query(id, Arg(root, "sql"), Limit(root)),
        "status" => new { id, ok = true, connected = _connectionString.Length > 0, server = _server, database = _database },
        _ => new { id, ok = false, error = $"unknown op \"{op}\"" },
    };

    private static string Arg(JsonElement root, string name) =>
        root.TryGetProperty(name, out var el) ? el.GetString() ?? "" : "";

    private static int Limit(JsonElement root) =>
        root.TryGetProperty("limit", out var el) && el.TryGetInt32(out var v)
            ? Math.Clamp(v, 1, MaxRowLimit)
            : DefaultRowLimit;

    // ---------------------------------------------------------------------------------

    private static async Task<object> Connect(int id, string connectionString)
    {
        if (connectionString.Length == 0) return new { id, ok = false, error = "connect needs a connectionString" };
        try
        {
            var builder = new SqlConnectionStringBuilder(connectionString)
            {
                // A hung connect is worse than a refused one: the model can read an error.
                ConnectTimeout = 15,
            };
            var asked = builder.DataSource;
            var localDb = ResolveLocalDb(asked);
            if (localDb is not null) builder.DataSource = localDb;
            try
            {
                await using var conn = new SqlConnection(builder.ConnectionString);
                await conn.OpenAsync();
                _connectionString = builder.ConnectionString;
                _server = conn.DataSource;
                _database = conn.Database;
                return new { id, ok = true, server = asked, database = _database, version = conn.ServerVersion };
            }
            catch (Exception e)
            {
                // Naming what was actually dialled matters when it is not what was asked for:
                // a LocalDB instance is reached through a pipe whose name changes every time
                // it starts, so "could not connect to (localdb)\X" alone hides the whole story.
                var via = localDb is null ? "" : $" (via {localDb})";
                return new { id, ok = false, error = $"could not connect to {asked}{via}: {Explain(e)}" };
            }
        }
        catch (Exception e)
        {
            return new { id, ok = false, error = Explain(e) };
        }
    }

    /// <summary>
    /// `(localdb)\Name` turned into the named pipe it is actually listening on, or null when
    /// the data source is not LocalDB and should be left alone.
    ///
    /// The provider is supposed to do this itself and does not here: a self-contained build
    /// resolves `(localdb)\MSSQLLocalDB` to SQL error 53, "no network path", even with the
    /// native SNI library sitting beside the exe and `sqlcmd` connecting to the same instance
    /// from the same shell. Rather than guess at why, ask the tool that owns the answer —
    /// `sqllocaldb`, which ships with LocalDB, so anyone who has the instance has it.
    ///
    /// Starting a stopped instance is part of the job: LocalDB shuts itself down after idling
    /// and "it was not running" is not a useful answer to someone who asked what is in their
    /// database. Failure is silent by design — the ordinary connection is then attempted
    /// anyway, and its error is the honest one to report.
    /// </summary>
    private static string? ResolveLocalDb(string dataSource)
    {
        const string prefix = "(localdb)\\";
        if (!dataSource.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return null;
        var instance = dataSource[prefix.Length..].Trim();
        if (instance.Length == 0) return null;

        var info = RunLocalDb($"info \"{instance}\"");
        if (info is null) return null;
        if (info.Contains("State:", StringComparison.Ordinal) &&
            !info.Contains("Running", StringComparison.OrdinalIgnoreCase))
        {
            RunLocalDb($"start \"{instance}\"");
            info = RunLocalDb($"info \"{instance}\"") ?? info;
        }

        foreach (var line in info.Split('\n'))
        {
            var i = line.IndexOf("np:", StringComparison.Ordinal);
            if (i >= 0) return line[i..].Trim();
        }
        return null;
    }

    private static string? RunLocalDb(string arguments)
    {
        try
        {
            using var p = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
            {
                FileName = "sqllocaldb",
                Arguments = arguments,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            });
            if (p is null) return null;
            var text = p.StandardOutput.ReadToEnd();
            if (!p.WaitForExit(15_000)) return null;
            return p.ExitCode == 0 ? text : null;
        }
        catch
        {
            // No LocalDB on this machine, which is ordinary. The caller falls through to the
            // connection string as written.
            return null;
        }
    }

    /// <summary>
    /// The whole shape of the database, compactly: what a person would sketch on a whiteboard
    /// before answering any question about it.
    ///
    /// One round trip, three result sets, ordered so the reader meets a table's columns
    /// immediately after its name. Programmability objects are named with their parameters but
    /// not their bodies — a database with fifty procedures would otherwise be a hundred
    /// thousand characters, and `describe` exists for the one that matters.
    /// </summary>
    private static async Task<object> Schema(int id)
    {
        if (_connectionString.Length == 0) return new { id, ok = false, error = "not connected; call connect first" };

        const string sql = """
            SELECT s.name AS [schema], t.name AS [table], c.name AS [column],
                   ty.name AS [type], c.max_length, c.precision, c.scale, c.is_nullable,
                   c.is_identity, c.column_id,
                   CAST(CASE WHEN pk.column_id IS NOT NULL THEN 1 ELSE 0 END AS BIT) AS is_pk
            FROM sys.tables t
            JOIN sys.schemas s ON s.schema_id = t.schema_id
            JOIN sys.columns c ON c.object_id = t.object_id
            JOIN sys.types ty ON ty.user_type_id = c.user_type_id
            LEFT JOIN (
                SELECT ic.object_id, ic.column_id
                FROM sys.index_columns ic
                JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
                WHERE i.is_primary_key = 1
            ) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id
            ORDER BY s.name, t.name, c.column_id;

            SELECT s.name AS [schema], o.name AS [name], o.type_desc AS [kind]
            FROM sys.objects o
            JOIN sys.schemas s ON s.schema_id = o.schema_id
            WHERE o.type IN ('V', 'P', 'FN', 'IF', 'TF')
            ORDER BY o.type, s.name, o.name;

            SELECT fk.name AS [name],
                   ps.name + '.' + pt.name AS [from_table], pc.name AS [from_column],
                   rs.name + '.' + rt.name AS [to_table], rc.name AS [to_column]
            FROM sys.foreign_keys fk
            JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
            JOIN sys.tables pt ON pt.object_id = fkc.parent_object_id
            JOIN sys.schemas ps ON ps.schema_id = pt.schema_id
            JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
            JOIN sys.tables rt ON rt.object_id = fkc.referenced_object_id
            JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
            JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
            ORDER BY fk.name;
            """;

        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();
            await using var cmd = new SqlCommand(sql, conn) { CommandTimeout = CommandTimeoutSeconds };
            await using var reader = await cmd.ExecuteReaderAsync();

            var tables = new Dictionary<string, List<object>>();
            var order = new List<string>();
            while (await reader.ReadAsync())
            {
                var name = $"{reader.GetString(0)}.{reader.GetString(1)}";
                if (!tables.TryGetValue(name, out var cols))
                {
                    cols = new List<object>();
                    tables[name] = cols;
                    order.Add(name);
                }
                cols.Add(new
                {
                    name = reader.GetString(2),
                    type = TypeName(reader.GetString(3), reader.GetInt16(4), reader.GetByte(5), reader.GetByte(6)),
                    nullable = reader.GetBoolean(7),
                    identity = reader.GetBoolean(8),
                    pk = reader.GetBoolean(10),
                });
            }

            var routines = new List<object>();
            if (await reader.NextResultAsync())
            {
                while (await reader.ReadAsync())
                {
                    routines.Add(new
                    {
                        name = $"{reader.GetString(0)}.{reader.GetString(1)}",
                        kind = reader.GetString(2).Replace("_", " ").ToLowerInvariant(),
                    });
                }
            }

            var links = new List<object>();
            if (await reader.NextResultAsync())
            {
                while (await reader.ReadAsync())
                {
                    links.Add(new
                    {
                        from = $"{reader.GetString(1)}.{reader.GetString(2)}",
                        to = $"{reader.GetString(3)}.{reader.GetString(4)}",
                    });
                }
            }

            return new
            {
                id,
                ok = true,
                database = _database,
                tables = order.Select(n => new { name = n, columns = tables[n] }).ToArray(),
                routines = routines.ToArray(),
                foreignKeys = links.ToArray(),
            };
        }
        catch (Exception e)
        {
            return new { id, ok = false, error = Explain(e) };
        }
    }

    /// <summary>One object in full, including the text of a view, procedure or function.</summary>
    private static async Task<object> Describe(int id, string name)
    {
        if (_connectionString.Length == 0) return new { id, ok = false, error = "not connected; call connect first" };
        if (name.Length == 0) return new { id, ok = false, error = "describe needs an object name" };

        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();

            await using var cmd = new SqlCommand(
                "SELECT o.type_desc, OBJECT_SCHEMA_NAME(o.object_id) + '.' + o.name, m.definition " +
                "FROM sys.objects o LEFT JOIN sys.sql_modules m ON m.object_id = o.object_id " +
                "WHERE o.object_id = OBJECT_ID(@n)", conn)
            { CommandTimeout = CommandTimeoutSeconds };
            cmd.Parameters.AddWithValue("@n", name);

            await using var reader = await cmd.ExecuteReaderAsync();
            if (!await reader.ReadAsync())
            {
                return new { id, ok = true, found = false, note = $"no object named \"{name}\" in {_database}" };
            }
            return new
            {
                id,
                ok = true,
                found = true,
                kind = reader.GetString(0).Replace("_", " ").ToLowerInvariant(),
                name = reader.GetString(1),
                definition = reader.IsDBNull(2) ? null : reader.GetString(2),
            };
        }
        catch (Exception e)
        {
            return new { id, ok = false, error = Explain(e) };
        }
    }

    /// <summary>
    /// One read, run inside a transaction that is always rolled back.
    ///
    /// The rollback is the guarantee and the filter below is only a readable early error. A
    /// filter that decides what SQL does by looking at its first word will be wrong eventually
    /// — comments, CTEs, batches — and being wrong there would mean a silent write. Being
    /// wrong inside a transaction that never commits means an error message.
    /// </summary>
    private static async Task<object> Query(int id, string sql, int limit)
    {
        if (_connectionString.Length == 0) return new { id, ok = false, error = "not connected; call connect first" };
        if (sql.Trim().Length == 0) return new { id, ok = false, error = "query needs a statement" };

        var refusal = NotARead(sql);
        if (refusal is not null) return new { id, ok = false, error = refusal };

        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();
            await using var tx = (SqlTransaction)await conn.BeginTransactionAsync();
            try
            {
                await using var cmd = new SqlCommand(sql, conn, tx) { CommandTimeout = CommandTimeoutSeconds };
                await using var reader = await cmd.ExecuteReaderAsync();

                var columns = new string[reader.FieldCount];
                for (var i = 0; i < reader.FieldCount; i++) columns[i] = reader.GetName(i);

                var rows = new List<string[]>();
                var truncated = 0;
                while (await reader.ReadAsync())
                {
                    if (rows.Count >= limit) { truncated++; continue; }
                    var row = new string[reader.FieldCount];
                    for (var i = 0; i < reader.FieldCount; i++) row[i] = Cell(reader, i);
                    rows.Add(row);
                }

                return new
                {
                    id,
                    ok = true,
                    columns,
                    rows = rows.ToArray(),
                    truncated = truncated > 0 ? truncated : (int?)null,
                };
            }
            finally
            {
                // Always. Nothing this process does is allowed to outlive the call.
                await tx.RollbackAsync();
            }
        }
        catch (Exception e)
        {
            return new { id, ok = false, error = Explain(e) };
        }
    }

    /// <summary>Null when it looks like a read. A message naming the offending word otherwise.</summary>
    private static string? NotARead(string sql)
    {
        var stripped = StripCommentsAndStrings(sql);
        string[] writes =
        [
            "insert", "update", "delete", "merge", "truncate", "drop", "create", "alter",
            "grant", "revoke", "deny", "backup", "restore", "shutdown", "reconfigure",
        ];
        var words = stripped.Split([' ', '\t', '\r', '\n', '(', ')', ';', ','],
            StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        foreach (var w in words)
        {
            if (Array.Exists(writes, x => string.Equals(x, w, StringComparison.OrdinalIgnoreCase)))
            {
                return $"this helper only reads. \"{w.ToUpperInvariant()}\" changes the database, " +
                       "and a change to a database is not covered by the checkpoint history — " +
                       "run it yourself if you mean it.";
            }
        }
        return null;
    }

    /// <summary>So a keyword inside a comment or a literal is not mistaken for a statement.</summary>
    private static string StripCommentsAndStrings(string sql)
    {
        var sb = new StringBuilder(sql.Length);
        for (var i = 0; i < sql.Length; i++)
        {
            if (sql[i] == '-' && i + 1 < sql.Length && sql[i + 1] == '-')
            {
                while (i < sql.Length && sql[i] != '\n') i++;
                sb.Append(' ');
            }
            else if (sql[i] == '/' && i + 1 < sql.Length && sql[i + 1] == '*')
            {
                i += 2;
                while (i + 1 < sql.Length && !(sql[i] == '*' && sql[i + 1] == '/')) i++;
                i++;
                sb.Append(' ');
            }
            else if (sql[i] == '\'')
            {
                i++;
                while (i < sql.Length && sql[i] != '\'') i++;
                sb.Append(' ');
            }
            else
            {
                sb.Append(sql[i]);
            }
        }
        return sb.ToString();
    }

    private static string Cell(SqlDataReader reader, int i)
    {
        if (reader.IsDBNull(i)) return "NULL";
        var value = reader.GetValue(i);
        // Invariant, always. `InvariantGlobalization` had to be turned off for the data
        // provider to connect at all, which means the machine's locale now reaches this line:
        // on a Russian Windows a decimal came back as "1200,50", and a reader deciding whether
        // that is one number or two is a reader who has been handed a bug. Dates likewise, in
        // one unambiguous shape rather than the local one.
        var text = value switch
        {
            byte[] bytes => $"0x{Convert.ToHexString(bytes[..Math.Min(bytes.Length, 8)])}…({bytes.Length} bytes)",
            DateTime dt => dt.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture),
            DateTimeOffset dto => dto.ToString("yyyy-MM-dd HH:mm:sszzz", CultureInfo.InvariantCulture),
            IFormattable f => f.ToString(null, CultureInfo.InvariantCulture),
            _ => value.ToString() ?? "",
        };
        return text.Length > MaxCellChars ? text[..MaxCellChars] + "…" : text;
    }

    private static string TypeName(string type, short maxLength, byte precision, byte scale)
    {
        switch (type.ToLowerInvariant())
        {
            case "decimal":
            case "numeric":
                return $"{type}({precision},{scale})";
            case "varchar":
            case "char":
            case "varbinary":
            case "binary":
                return maxLength == -1 ? $"{type}(max)" : $"{type}({maxLength})";
            case "nvarchar":
            case "nchar":
                return maxLength == -1 ? $"{type}(max)" : $"{type}({maxLength / 2})";
            default:
                return type;
        }
    }

    /// <summary>
    /// The message the model gets. A raw provider exception names a TCP endpoint and a stack;
    /// what is actionable is which of the four ordinary things went wrong.
    /// </summary>
    private static string Explain(Exception e)
    {
        if (e is SqlException sql)
        {
            return sql.Number switch
            {
                4060 or 911 => $"the server is reachable but there is no database by that name ({sql.Message})",
                18456 => "the server refused the credentials in the connection string",
                53 => "no server answered at that address — check the instance name and that it is running",
                _ => $"{sql.Message} (SQL error {sql.Number})",
            };
        }
        return e.Message;
    }
}
