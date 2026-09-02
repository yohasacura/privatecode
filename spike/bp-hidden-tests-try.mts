/**
 * Does the black-port hidden test project restore, build and run inside a throwaway copy,
 * and do the hidden tests mean what they say? Run once before wiring it into the eval, and
 * again whenever the template, the hidden tests or the package versions change.
 *
 *   npx tsx spike/bp-hidden-tests-try.mts              # smoke: the project builds and runs
 *   npx tsx spike/bp-hidden-tests-try.mts --reference  # the four tasks' hidden tests against a
 *                                                      # hand-written reference solution: all pass
 *   npx tsx spike/bp-hidden-tests-try.mts --untouched  # the same tests against the original: all fail
 */
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SHAPES, makeWorkspace, removeCopy, runIn } from '../eval/workspace.js'

const MODE = process.argv.includes('--reference') ? 'reference' : process.argv.includes('--untouched') ? 'untouched' : 'smoke'
const TASKS = ['bp-quote-cost-total', 'bp-quote-is-expired', 'bp-count-by-status', 'bp-dashboard-lead-sources']

function edit(file: string, from: string, to: string): void {
  const raw = readFileSync(file, 'utf8')
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const f = from.split('\n').join(eol)
  if (!raw.includes(f)) throw new Error(`anchor not found in ${file}: ${from.slice(0, 60)}`)
  writeFileSync(file, raw.replace(f, to.split('\n').join(eol)), 'utf8')
}

/** The smallest change that satisfies each task — what a correct answer looks like. */
function applyReference(backend: string): void {
  edit(join(backend, 'BlackPort.Domain', 'Entities', 'Quote.cs'),
    '    public bool IsDeleted => DeletedAtUtc is not null;',
    '    public bool IsDeleted => DeletedAtUtc is not null;\n\n' +
    '    [System.ComponentModel.DataAnnotations.Schema.NotMapped]\n' +
    '    public decimal CostTotal => Lines.Sum(l => l.Amount);\n\n' +
    '    [System.ComponentModel.DataAnnotations.Schema.NotMapped]\n' +
    '    public bool IsExpired => ValidUntilUtc is { } until && until < DateTime.UtcNow;')
  edit(join(backend, 'BlackPort.Application', 'DTOs', 'Crm', 'LeadDtos.cs'),
    'namespace BlackPort.Application.DTOs.Crm;',
    'namespace BlackPort.Application.DTOs.Crm;\n\npublic sealed record LeadStatusCountDto(Guid StatusId, string StatusName, int Count);')
  edit(join(backend, 'BlackPort.Application', 'DTOs', 'Crm', 'DashboardDtos.cs'),
    'namespace BlackPort.Application.DTOs.Crm;',
    'namespace BlackPort.Application.DTOs.Crm;\n\npublic sealed record LeadSourceCountDto(string Source, int Count);')
  // An action with the route, enough for the reflection half; the eval's real runs also
  // build, so a body that compiles is all the reference needs.
  const leads = join(backend, 'BlackPort.Api', 'Controllers', 'Crm', 'LeadsController.cs')
  const leadsRaw = readFileSync(leads, 'utf8')
  const leadsClass = /public sealed class LeadsController[^\n]*\n(\s*[^\n]*\n)*?\{\r?\n/.exec(leadsRaw)
  if (leadsClass === null) throw new Error('LeadsController class head not found')
  writeFileSync(leads, leadsRaw.replace(leadsClass[0], leadsClass[0] +
    '    [HttpGet("count-by-status")]\n    public IActionResult CountByStatus() => Ok(Array.Empty<LeadStatusCountDto>());\n\n'), 'utf8')
  const dash = join(backend, 'BlackPort.Api', 'Controllers', 'Crm', 'DashboardController.cs')
  const dashRaw = readFileSync(dash, 'utf8')
  const dashClass = /public sealed class DashboardController[^\n]*\n(\s*[^\n]*\n)*?\{\r?\n/.exec(dashRaw)
  if (dashClass === null) throw new Error('DashboardController class head not found')
  writeFileSync(dash, dashRaw.replace(dashClass[0], dashClass[0] +
    '    [HttpGet("lead-sources")]\n    public IActionResult LeadSources() => Ok(Array.Empty<LeadSourceCountDto>());\n\n'), 'utf8')
}

const { root, mounts } = makeWorkspace(SHAPES['blackport']!)
const backend = mounts.find((m) => m.name === 'backend')!.root
console.log(`copy at ${root} (${MODE})`)
try {
  if (MODE === 'reference') applyReference(backend)
  const testDir = join(backend, 'BlackPort.Eval.Tests')
  cpSync(new URL('../eval/hidden-blackport/BlackPort.Eval.Tests/', import.meta.url), testDir, { recursive: true })
  mkdirSync(testDir, { recursive: true })
  if (MODE === 'smoke') {
    writeFileSync(join(testDir, 'Smoke.cs'), [
      'using BlackPort.Domain.Entities;',
      'using Xunit;',
      'namespace BlackPort.Eval.Tests;',
      'public class Smoke',
      '{',
      '    [Fact] public void An_existing_member_is_found() => Assert.Equal(typeof(bool), Reflect.Property(typeof(Quote), "IsDeleted").PropertyType);',
      '    [Fact] public void A_controller_type_loads() => Assert.NotNull(typeof(BlackPort.Api.Controllers.Crm.LeadsController));',
      '}',
    ].join('\n'), 'utf8')
  } else {
    for (const task of TASKS) {
      const dir = new URL(`../eval/hidden/${task}/`, import.meta.url)
      for (const f of readdirSync(dir)) if (f.endsWith('.cs')) cpSync(new URL(f, dir), join(testDir, f))
    }
  }
  if (MODE === 'reference') {
    const b = runIn(backend, SHAPES['blackport']!.verify['backend']!)
    console.log(`reference solution builds: ok=${b.ok} in ${b.seconds.toFixed(1)}s`)
    if (!b.ok) console.log(b.output.split(/\r?\n/).filter((l) => /error/.test(l)).slice(0, 8).join('\n'))
  }
  const r = runIn(testDir, 'dotnet test BlackPort.Eval.Tests.csproj --nologo -v q', 600_000)
  console.log(`dotnet test: ok=${r.ok} in ${r.seconds.toFixed(1)}s`)
  console.log(r.output.split(/\r?\n/).filter((l) => /Passed!|Failed!|error CS|\[FAIL\]/.test(l)).slice(-16).join('\n'))
} finally {
  removeCopy(join(root, '..'))
}
