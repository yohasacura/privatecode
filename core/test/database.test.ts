import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { databaseTool } from '../src/tools/database.js'
import { renderRows, renderSchema } from '../src/sql/render.js'
import { describeConnection, expandEnv, loadDatabaseSettings } from '../src/sql/settings.js'
import { resolveHelper } from '../src/sql/sql-process.js'
import { PRIVATE_DIR } from '../src/private-dir.js'
import { Workspace } from '../src/workspace.js'

/**
 * The database tool's edges — configuration, secrets, and what is refused before a process
 * is ever started.
 *
 * What the helper ANSWERS is exercised against a real SQL Server by hand (see
 * `vendor/sql/PROVENANCE.md`); a mock of a database is a test of the mock.
 */

let root: string
const roots: string[] = []
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-db-'))
  roots.push(root)
  mkdirSync(join(root, PRIVATE_DIR), { recursive: true })
})
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true })
})

const settingsFile = (body: unknown): void => {
  writeFileSync(join(root, PRIVATE_DIR, 'settings.json'), JSON.stringify(body), 'utf8')
}

describe('configuring a database', () => {
  test('a workspace with no database configured is the ordinary state, not a problem', () => {
    const { database, problems } = loadDatabaseSettings(root, {})
    expect(database).toBeNull()
    expect(problems).toEqual([])
  })

  test('a connection string is read from the project settings file', () => {
    settingsFile({ database: { connectionString: 'Server=x;Database=Crm;Integrated Security=true' } })
    const { database, problems } = loadDatabaseSettings(root, {})
    expect(database?.connectionString).toContain('Database=Crm')
    expect(problems).toEqual([])
  })

  test('a password can live in the environment instead of the file', () => {
    // `.privatecode/` is git-ignored in full, so a secret here would not travel with the
    // repository -- but it would still sit in plain text in a file that gets opened, shared
    // and copied to another laptop, and the ignore rule covers none of that.
    settingsFile({ database: { connectionString: 'Server=x;User Id=app;Password=${env:CRM_PW}' } })
    const { database, problems } = loadDatabaseSettings(root, { CRM_PW: 'hunter2' })
    expect(database?.connectionString).toBe('Server=x;User Id=app;Password=hunter2')
    expect(problems).toEqual([])
  })

  test('an unset variable refuses the connection instead of sending an empty password', () => {
    // Otherwise the failure arrives as the server's own unhelpful message, several steps
    // from the actual mistake, which is a line in a settings file.
    settingsFile({ database: { connectionString: 'Server=x;Password=${env:NOT_SET}' } })
    const { database, problems } = loadDatabaseSettings(root, {})
    expect(database).toBeNull()
    expect(problems.join(' ')).toContain('NOT_SET')
  })

  test('a malformed database block is reported and ignored, not fatal', () => {
    settingsFile({ database: 'Server=x' })
    const { database, problems } = loadDatabaseSettings(root, {})
    expect(database).toBeNull()
    expect(problems.join(' ')).toContain('must be an object')
  })

  test('expandEnv leaves an ordinary string alone', () => {
    const problems: string[] = []
    expect(expandEnv('Server=x;Integrated Security=true', 'project', problems, {}))
      .toBe('Server=x;Integrated Security=true')
    expect(problems).toEqual([])
  })
})

describe('naming a connection without leaking it', () => {
  test('the description carries the server and database and never the password', () => {
    const shown = describeConnection({
      connectionString: 'Server=sql01;Database=Crm;User Id=app;Password=hunter2',
    })
    expect(shown).toBe('Crm on sql01')
    expect(shown).not.toContain('hunter2')
  })

  test('a label wins when one is set', () => {
    expect(describeConnection({ connectionString: 'Server=x;Database=y', label: 'staging' }))
      .toBe('staging')
  })

  test('the alternative spellings of the same two fields are understood', () => {
    expect(describeConnection({ connectionString: 'Data Source=sql02;Initial Catalog=Billing' }))
      .toBe('Billing on sql02')
  })
})

describe('what is refused before a process starts', () => {
  test('the three actions are the only ones offered', () => {
    expect(databaseTool.validate({ action: 'schema' }).ok).toBe(true)
    expect(databaseTool.validate({ action: 'describe', target: 'dbo.Invoice' }).ok).toBe(true)
    expect(databaseTool.validate({ action: 'query', target: 'SELECT 1' }).ok).toBe(true)
    const bad = databaseTool.validate({ action: 'insert', target: 'x' })
    expect(bad.ok).toBe(false)
  })

  test('describe and query need a target and say which one they wanted', () => {
    const d = databaseTool.validate({ action: 'describe' })
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.error).toContain('dbo.Invoice')
    const q = databaseTool.validate({ action: 'query' })
    expect(q.ok).toBe(false)
    if (!q.ok) expect(q.error).toContain('SELECT')
  })

  test('the row limit is clamped, because the result is permanent context', () => {
    const v = databaseTool.validate({ action: 'query', target: 'SELECT 1', limit: 99999 })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.args.limit).toBe(500)
  })

  test('an unconfigured workspace is told where to configure one, not that it failed', async () => {
    const r = await databaseTool.execute({ action: 'schema' }, { workspace: new Workspace(root) })
    expect(r.ok).toBe(false)
    expect(r.content).toContain('settings.json')
    expect(r.content).toContain('connectionString')
  })
})

describe('finding the helper', () => {
  /** Where `sql-process.ts` lives — the fallback counts directories up from there. */
  const MODULE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sql')

  test('no env var falls back to the copy vendored in this checkout', () => {
    const found = resolveHelper(undefined, MODULE_DIR)
    expect(found).not.toBeNull()
    expect(found).toContain('sql-probe.exe')
  })

  test('an exe missing ANY of its native siblings is not a usable helper', () => {
    // A single-file publish leaves native libraries beside the exe, and an exe without them
    // starts fine and then fails with a message naming nothing that is actually wrong — a
    // broken install presenting as a network fault. Refusing here turns it back into a clear
    // answer.
    //
    // The list is checked one at a time on purpose. It grew from one entry to two the moment
    // DacFx was added, and this test failed the instant it did — which is the behaviour
    // wanted from it, since the alternative is a half-vendored helper shipping quietly.
    const exe = join(root, 'sql-probe.exe')
    writeFileSync(exe, 'not really an exe', 'utf8')
    expect(resolveHelper(exe, null)).toBeNull()

    writeFileSync(join(root, 'Microsoft.Data.SqlClient.SNI.dll'), 'nor this', 'utf8')
    expect(resolveHelper(exe, null)).toBeNull()

    writeFileSync(join(root, 'SqlServerSpatial160.dll'), 'nor this', 'utf8')
    expect(resolveHelper(exe, null)).toBe(exe)
  })

  test('a caller that cannot locate itself gets null, not a crash', () => {
    // The shipped sidecar is CommonJS, where `import.meta` is `{}` and `fileURLToPath` on
    // its `url` throws.
    expect(resolveHelper(undefined, null)).toBeNull()
  })
})

describe('rendering what comes back', () => {
  test('a schema reads like a sketch, with keys and nullability inline', () => {
    const text = renderSchema({
      database: 'Crm',
      tables: [{
        name: 'dbo.Invoice',
        columns: [
          { name: 'InvoiceId', type: 'int', nullable: false, identity: true, pk: true },
          { name: 'TaxNumber', type: 'nvarchar(20)', nullable: true, identity: false, pk: false },
        ],
      }],
      foreignKeys: [{ from: 'dbo.Invoice.CustomerId', to: 'dbo.Customer.CustomerId' }],
      routines: [{ name: 'dbo.vOpen', kind: 'view' }],
    })
    expect(text).toContain('Crm — 1 table')
    expect(text).toContain('InvoiceId int (PK, identity, not null)')
    expect(text).toContain('TaxNumber nvarchar(20) (null)')
    expect(text).toContain('dbo.Invoice.CustomerId -> dbo.Customer.CustomerId')
    expect(text).toContain('dbo.vOpen (view)')
  })

  test('rows are aligned so the model reads a grid rather than counting separators', () => {
    const text = renderRows({
      columns: ['Number', 'Total'],
      rows: [['INV-1', '1200.50'], ['INV-22', '3.00']],
    })
    const lines = text.split('\n')
    expect(lines[0]).toBe('Number  Total')
    expect(lines[2]).toBe('INV-1   1200.50')
    expect(lines[3]).toBe('INV-22  3.00')
  })

  test('a truncated result says how much it is not showing', () => {
    const text = renderRows({ columns: ['n'], rows: [['1']], truncated: 40 })
    expect(text).toContain('40 more rows not shown')
  })

  test('an empty result is not an error', () => {
    expect(renderRows({ columns: ['n'], rows: [] })).toContain('(no rows)')
  })
})

describe('the schema block that goes into the prompt', () => {
  const many = (n: number): Record<string, unknown> => ({
    database: 'Warehouse',
    tables: Array.from({ length: n }, (_, i) => ({
      name: `dbo.Table${i}`,
      columns: [
        { name: 'Id', type: 'int', nullable: false, identity: true, pk: true },
        { name: 'Payload', type: 'nvarchar(400)', nullable: true, identity: false, pk: false },
      ],
    })),
    foreignKeys: [{ from: 'dbo.Table1.Id', to: 'dbo.Table0.Id' }],
    routines: [{ name: 'dbo.vAll', kind: 'view' }],
  })

  test('a large schema is cut to the budget and SAYS how much it cut', () => {
    // A model told "here is the database" would take a truncated list as complete and
    // conclude a table it cannot see does not exist. The count is what prevents that.
    const text = renderSchema(many(200), 1_000)
    expect(text.length).toBeLessThan(2_000)
    expect(text).toContain('Warehouse — 200 tables')
    expect(text).toMatch(/\d+ more tables are not listed here/)
  })

  test('relationships and routines survive the cut, because they are what a map is for', () => {
    const text = renderSchema(many(200), 1_000)
    expect(text).toContain('dbo.Table1.Id -> dbo.Table0.Id')
    expect(text).toContain('dbo.vAll (view)')
  })

  test('a schema inside the budget says nothing about truncation', () => {
    const text = renderSchema(many(2))
    expect(text).not.toContain('not listed here')
  })
})
