import { describe, expect, test } from 'vitest'
import {
  SUBJECT_KEYS, factsAbout, keyFacts, lengthBucket, nextMoveBetween, subjectsOf,
  type Fact,
} from '../src/doctor/behaviour.js'

/**
 * Diagnosing WHY, without quoting what.
 *
 * The point of these is not that the functions work — it is that the method generalises. A
 * path was the first example and building around it would have been the mistake: the same
 * three moves (shape, relation, provenance) have to explain a bad regex, a shell operator, a
 * symbol that does not resolve and a gate that will not accept a criterion. So every relation
 * is tested on at least two different KINDS of subject, and the leak test is run against all
 * of them at once.
 */

/** Everything a `Fact` can carry, flattened, so a leak has nowhere to hide. */
function words(facts: Fact[]): string {
  return facts.map((f) => Object.values(f).join(' ')).join(' ')
}

describe('a fact can never carry the value it describes', () => {
  const secrets: { value: string; kind: Parameters<typeof factsAbout>[1] }[] = [
    { value: 'src/AcmeBank/Ledger/PostingEngine.cs', kind: 'location' },
    { value: 'cd D:/clients/zebracorp/api; dotnet build ./Zebra.Api.csproj', kind: 'command' },
    { value: 'ProjectNightingale_(Secret|Internal)', kind: 'pattern' },
    { value: 'AcmeBank.Ledger.PostingEngine.Recalculate', kind: 'name' },
    { value: 'the merger with ZebraCorp closes in Q3', kind: 'content' },
  ]

  test('nothing recognisable survives, whatever kind it is', () => {
    for (const { value, kind } of secrets) {
      const said = words(factsAbout(value, kind))
      for (const secret of ['AcmeBank', 'zebracorp', 'ZebraCorp', 'Nightingale', 'Ledger',
        'PostingEngine', 'merger', 'clients', 'Zebra']) {
        expect(said).not.toContain(secret)
      }
    }
  })

  test('what DOES survive is our own vocabulary and counts', () => {
    const facts = factsAbout('cd D:/clients/zebracorp/api; dotnet build ./Zebra.Api.csproj', 'command')
    const said = words(facts)
    // Ours: a public program name, an operator we defined, a habit we named.
    expect(said).toContain('dotnet')
    expect(said).toContain(';')
    expect(facts.some((f) => f.fact === 'opens-with-cd')).toBe(true)
    // And the client's own tooling would NOT have survived; only whitelisted names do.
    expect(words(factsAbout('.\\LedgerSync.exe --push', 'command'))).toContain('other-program')
    expect(words(factsAbout('.\\LedgerSync.exe --push', 'command'))).not.toContain('LedgerSync')
  })

  test('an extension we do not ship a name for is dropped, not reported', () => {
    // `.cs` says something about the workspace; `.acmeledger` says whose it is.
    expect(words(factsAbout('data/x.cs', 'location'))).toContain('cs')
    expect(words(factsAbout('data/x.acmeledger', 'location'))).not.toContain('acmeledger')
  })
})

describe('the relation between two attempts, across different kinds', () => {
  test('narrowed — the owner\'s own example, and the same relation elsewhere', () => {
    // A path that lost a leading segment: the multi-folder "which folder am I in" mistake.
    expect(nextMoveBetween('src/Engine/Program.cs', 'Engine/Program.cs', 'location')).toBe('narrowed')
    // The identical relation in a NAME: a symbol that dropped its namespace. Same finding,
    // different tool, and this is why the relation is not called "dropped-path-segment".
    expect(nextMoveBetween('Acme.Ledger.Posting', 'Ledger.Posting', 'name')).toBe('narrowed')
  })

  test('broadened is its mirror', () => {
    expect(nextMoveBetween('Engine/Program.cs', 'src/Engine/Program.cs', 'location')).toBe('broadened')
  })

  test('rejoined — the same pieces, put together differently', () => {
    // A separator confusion, which is a different bug from a wrong path and needs a
    // different fix.
    expect(nextMoveBetween('src\\Engine\\a.cs', 'src/Engine/a.cs', 'location')).toBe('rejoined')
  })

  test('changed-operator — the habit this project has watched most', () => {
    expect(nextMoveBetween('cd x && dotnet build', 'cd x; dotnet build', 'command'))
      .toBe('changed-operator')
  })

  test('retried-identically — the failure taught nothing', () => {
    expect(nextMoveBetween('same', 'same', 'location')).toBe('retried-identically')
  })

  test('guessed-again — no structural relation at all', () => {
    expect(nextMoveBetween('src/a.cs', 'tests/helpers/b.ts', 'location')).toBe('guessed-again')
  })
})

describe('what a value is ABOUT, keyed on our own schema', () => {
  test('a call is split into its subjects, each with its kind', () => {
    const subjects = subjectsOf(JSON.stringify({
      path: 'src/a.ts',
      pattern: 'class .*',
      action: 'references',
    }))
    expect(subjects.map((s) => `${s.key}:${s.kind}`).sort())
      .toEqual(['action:choice', 'path:location', 'pattern:pattern'])
  })

  test('an array argument contributes each of its entries', () => {
    // `run_command` takes `commands: string[]`, and each line is its own attempt at
    // something — treating the array as one blob would hide which line was wrong.
    const subjects = subjectsOf(JSON.stringify({ commands: ['cd x', 'dotnet build'] }))
    expect(subjects).toHaveLength(2)
    expect(subjects.every((s) => s.kind === 'command')).toBe(true)
  })

  test('a key we do not know contributes nothing rather than a guess', () => {
    // Silence is the right answer: a guess about an unknown key is how a diagnosis becomes
    // confidently wrong.
    expect(subjectsOf(JSON.stringify({ mystery: 'D:/clients/secret' }))).toEqual([])
  })

  test('an invented key is counted, never named', () => {
    const facts = keyFacts(
      JSON.stringify({ path: 'a.ts', acme_ledger_id: 'X-991' }),
      new Set(['path']),
    )
    const said = words(facts)
    expect(said).toContain('path')
    expect(said).toContain('unknown-key')
    expect(said).not.toContain('acme_ledger_id')
    expect(said).not.toContain('X-991')
  })
})

describe('the shapes that are themselves the bug', () => {
  test('a pattern that does not compile is told apart from one that matches nothing', () => {
    // Different mistakes with different fixes, and a report that merged them would send
    // somebody looking in the wrong place.
    expect(factsAbout('(unclosed', 'pattern').some((f) => f.fact === 'malformed')).toBe(true)
    expect(factsAbout('plainword', 'pattern').some((f) => f.fact === 'malformed')).toBe(false)
  })

  test('a tiny anchor is visible as tiny, which is usually why it matched everywhere', () => {
    expect(lengthBucket(3)).toBe('tiny')
    expect(lengthBucket(500)).toBe('long')
    expect(lengthBucket(50_000)).toBe('huge')
  })

  test('walking upward and mixing separators are named, because both are the model lost', () => {
    const facts = factsAbout('..\\..\\src/a.ts', 'location')
    expect(facts.some((f) => f.fact === 'escapes-upward')).toBe(true)
    expect(facts.some((f) => f.fact === 'mixed-separators')).toBe(true)
  })
})

test('every subject key maps to a kind we handle', () => {
  // A tool whose keys are missing here contributes nothing to the diagnosis, silently —
  // which is the failure that produces a confidently incomplete report.
  for (const kind of Object.values(SUBJECT_KEYS)) {
    expect(['location', 'pattern', 'command', 'name', 'content', 'choice', 'other'])
      .toContain(kind)
  }
})
