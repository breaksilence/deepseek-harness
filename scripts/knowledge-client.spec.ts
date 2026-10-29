/** Client protocol: staged delivery, abstention, and span records. */

import { describe, expect, it } from 'vitest'
import type { Fact } from '../packages/experimental/knowledge-brain/src/facts.ts'
import { deliver, spanFor, tokensOf } from './knowledge-client.ts'

const NOW = 1_800_000_000_000

function fact(id: string, overrides: Partial<Fact> = {}): Fact {
  return {
    id,
    conclusion: `结论 ${id}`,
    appliesTo: { packages: [], dirs: [], paths: [`scripts/${id}.ts`], symbols: [], commands: [] },
    evidence: { source: 'notes/x', quote: 'q' },
    exceptions: '',
    confidence: 0.9,
    ttlDays: 90,
    updatedAt: NOW,
    trust: 'verified',
    conflictsWith: [],
    origin: `${id}.md`,
    ...overrides,
  }
}

const query = { paths: ['scripts/a.ts'], symbols: [], commands: [], tokens: [] }

describe('deliver', () => {
  it('abstains without cost when nothing reaches the floor', () => {
    const delivery = deliver([fact('a')], { paths: ['docs/x.md'], symbols: [], commands: [], tokens: [] }, 5, 2, NOW)
    expect(delivery).toMatchObject({ abstained: true, stages: [], tokens: 0 })
  })

  it('stages index, trust, and body for a hit', () => {
    const delivery = deliver([fact('a')], query, 5, 2, NOW)
    expect(delivery.abstained).toBe(false)
    expect(delivery.stages.map(stage => stage.stage)).toEqual(['k0', 'k2', 'k3'])
    expect(new Set(delivery.stages.flatMap(stage => (stage.factId === undefined ? [] : [stage.factId])))).toEqual(new Set(['a']))
    expect(delivery.tokens).toBe(delivery.stages.reduce((sum, stage) => sum + stage.tokens, 0))
  })

  it('lists an authored conflict in the trust stage', () => {
    const facts = [fact('a', { conflictsWith: ['b'] }), fact('b')]
    const delivery = deliver(facts, query, 5, 2, NOW)
    const doubt = delivery.stages.find(stage => stage.stage === 'k2')
    expect(doubt?.text).toContain('conflicts (1)')
  })
})

describe('spanFor', () => {
  it('records the delivered ids once and the token cost', () => {
    const delivery = deliver([fact('a')], query, 5, 2, NOW)
    const span = spanFor(delivery, 'corpus', NOW)
    expect(span).toMatchObject({ corpus: 'corpus', paths: ['scripts/a.ts'], abstained: false, delivered: ['a'] })
    expect(span.tokens).toBe(delivery.tokens)
  })

  it('records an abstention with no delivered ids', () => {
    const delivery = deliver([fact('a')], { paths: [], symbols: [], commands: [], tokens: [] }, 5, 2, NOW)
    expect(spanFor(delivery, 'corpus', NOW)).toMatchObject({ abstained: true, delivered: [], tokens: 0 })
  })
})

describe('tokensOf', () => {
  it('approximates four characters per token', () => {
    expect(tokensOf('abcd')).toBe(1)
    expect(tokensOf('abcde')).toBe(2)
  })
})
