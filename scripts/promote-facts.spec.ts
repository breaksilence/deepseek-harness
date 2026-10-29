/** Unit tests for the promotion gate's pure evaluation. */

import { describe, expect, it } from 'vitest'
import type { Fact } from '../packages/experimental/knowledge-brain/src/facts.ts'
import { evaluate, requireStability, type ReplayTurn } from './promote-facts.ts'

const NOW = 1_800_000_000_000

function fact(id: string, dirs: readonly string[]): Fact {
  return {
    id,
    conclusion: `结论 ${id}`,
    appliesTo: { packages: [], dirs, paths: [], symbols: [], commands: [] },
    evidence: { source: 'notes/x', quote: 'q' },
    exceptions: '',
    confidence: 0.9,
    ttlDays: 90,
    updatedAt: NOW,
    trust: 'verified',
    conflictsWith: [],
    origin: `${id}.md`,
  }
}

const turns: readonly ReplayTurn[] = [
  { paths: ['scripts/tools/a.ts'] },
  { paths: ['scripts/tools/b.ts'] },
  { paths: ['docs/guide/c.md'] },
  { paths: ['packages/core/tools/src/index.ts'] },
  { paths: [] },
]

describe('promotion gate', () => {
  it('blocks every candidate when no gold labels exist', () => {
    const report = evaluate([fact('kb-1', ['scripts/tools/'])], turns, undefined, 2, 0.55)
    expect(report.goldProvided).toBe(false)
    expect(report.candidates.map(entry => entry.decision)).toEqual(['blocked'])
    expect(report.coverage).toBe(0)
    expect(report.candidates[0]?.support).toBe(2)
  })

  it('promotes a candidate that meets support, precision, and novelty', () => {
    const gold = { 0: ['kb-1'], 1: ['kb-1'] }
    const report = evaluate([fact('kb-1', ['scripts/tools/'])], turns, gold, 2, 0.55)
    expect(report.candidates[0]).toMatchObject({ decision: 'promote', precision: 1, addedTurns: 2 })
    expect(report.coverage).toBe(0.4)
  })

  it('rejects a candidate below the precision floor', () => {
    const gold = { 0: ['kb-1'], 1: ['other'] }
    const report = evaluate([fact('kb-1', ['scripts/tools/'])], turns, gold, 2, 0.9)
    expect(report.candidates[0]).toMatchObject({ decision: 'reject', precision: 0.5 })
    expect(report.candidates[0]?.reason).toContain('below 0.9')
  })

  it('rejects an overlapping candidate that adds no coverage', () => {
    const facts = [fact('kb-1', ['scripts/tools/']), fact('kb-2', ['scripts/tools/'])]
    const gold = { 0: ['kb-1', 'kb-2'], 1: ['kb-1', 'kb-2'] }
    const report = evaluate(facts, turns, gold, 2, 0.55)
    const second = report.candidates.find(entry => entry.id === 'kb-2')
    expect(second).toMatchObject({ decision: 'reject', addedTurns: 0 })
    expect(second?.reason).toBe('no marginal coverage')
  })

  it('rejects a candidate below the support floor', () => {
    const report = evaluate([fact('kb-rare', ['packages/nowhere/pkg/'])], turns, {}, 2, 0.55)
    expect(report.candidates[0]).toMatchObject({ decision: 'reject', support: 0 })
    expect(report.candidates[0]?.reason).toContain('support 0 below 2')
  })
})

describe('scope specificity', () => {
  it('does not count a broad scope as support', () => {
    const report = evaluate([fact('kb-broad', ['packages/'])], turns, {}, 1, 0.55)
    expect(report.candidates[0]).toMatchObject({ decision: 'reject', support: 0 })
    expect(report.candidates[0]?.reason).toContain('support 0 below 1')
  })

  it('counts a specific package as support', () => {
    const report = evaluate([fact('kb-pkg', ['packages/core/tools'])], turns, { 3: ['kb-pkg'] }, 1, 0.55)
    expect(report.candidates[0]).toMatchObject({ decision: 'promote', support: 1, precision: 1 })
  })
})

describe('cross-set stability', () => {
  it('downgrades a promotion that only one replay set supports', () => {
    const gold = { 0: ['kb-1'], 1: ['kb-1'], 3: ['kb-2'] }
    const facts = [fact('kb-1', ['scripts/tools/']), fact('kb-2', ['packages/core/tools'])]
    const primary = evaluate(facts, turns, gold, 1, 0.55)
    const secondaryFactsOnly = [fact('kb-1', ['scripts/tools/'])]
    const secondary = evaluate(secondaryFactsOnly, turns, gold, 1, 0.55)
    const merged = requireStability(primary, secondary)
    const byId = new Map(merged.candidates.map(entry => [entry.id, entry]))
    expect(byId.get('kb-1')?.decision).toBe('promote')
    expect(byId.get('kb-2')?.decision).toBe('unstable')
    expect(byId.get('kb-2')?.reason).toContain('primary set only')
  })
})

describe('scope saturation', () => {
  it('reports a scope claimed by three or more promoted facts', () => {
    const make = (id: string, path: string): Fact => ({
      ...fact(id, []),
      appliesTo: { packages: [], dirs: ['shared/'], paths: [path], symbols: [], commands: [] },
    })
    const facts = [make('kb-a', 'scripts/a.ts'), make('kb-b', 'scripts/b.ts'), make('kb-c', 'scripts/c.ts')]
    const turns = [{ paths: ['scripts/a.ts'] }, { paths: ['scripts/b.ts'] }, { paths: ['scripts/c.ts'] }]
    const gold = { 0: ['kb-a'], 1: ['kb-b'], 2: ['kb-c'] }
    const report = evaluate(facts, turns, gold, 1, 0.5)
    expect(report.candidates.filter(entry => entry.decision === 'promote')).toHaveLength(3)
    expect(report.saturatedScopes).toEqual([{ scope: 'shared/', facts: ['kb-a', 'kb-b', 'kb-c'] }])
  })
})

describe('scope saturation rejection', () => {
  it('rejects a fourth fact claiming the same scope', () => {
    const make = (id: string, path: string): Fact => ({
      ...fact(id, []),
      appliesTo: { packages: [], dirs: ['shared/'], paths: [path], symbols: [], commands: [] },
    })
    const facts = [make('kb-a', 'scripts/a.ts'), make('kb-b', 'scripts/b.ts'), make('kb-c', 'scripts/c.ts'), make('kb-d', 'scripts/d.ts')]
    const turns = [{ paths: ['scripts/a.ts'] }, { paths: ['scripts/b.ts'] }, { paths: ['scripts/c.ts'] }, { paths: ['scripts/d.ts'] }]
    const gold = { 0: ['kb-a'], 1: ['kb-b'], 2: ['kb-c'], 3: ['kb-d'] }
    const report = evaluate(facts, turns, gold, 1, 0.5)
    const promoted = report.candidates.filter(entry => entry.decision === 'promote').map(entry => entry.id)
    expect(promoted).toHaveLength(3)
    const rejected = report.candidates.find(entry => entry.id === 'kb-d')
    expect(rejected?.reason).toContain('scope saturated: shared/')
  })
})
