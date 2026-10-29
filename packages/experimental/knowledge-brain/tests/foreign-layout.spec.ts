/**
 * Foreign-layout regression: the same rules must hold on a repository whose paths, languages,
 * and modules differ from this one.
 *
 * The facts below describe a Python service tree with Terraform and a React app. They exist only
 * here, so a change that quietly assumes this repository's layout fails immediately.
 */

import { describe, expect, it } from 'vitest'
import type { Fact } from '../src/facts.ts'
import { rankFacts, scoreFact, scopeWeight } from '../src/rank.ts'
import { tokenize } from '../src/tokens.ts'
import { renderScan } from '../src/render.ts'

const NOW = 1_800_000_000_000

function fact(overrides: Partial<Fact> & { id: string }): Fact {
  return {
    conclusion: 'charge 与 refund 必须带 Idempotency-Key',
    appliesTo: { packages: [], dirs: [], paths: ['services/billing/handlers/charge.py'], symbols: [], commands: [] },
    evidence: { source: 'docs/billing/idempotency', quote: 'every retry carries the same Idempotency-Key' },
    exceptions: '',
    confidence: 0.95,
    ttlDays: 90,
    updatedAt: NOW,
    trust: 'verified',
    conflictsWith: [],
    origin: 'charge.md',
    ...overrides,
  }
}

const charge = fact({ id: 'charge-idempotency' })
const rates = fact({
  id: 'rate-source',
  conclusion: '汇率只能从 gateway/rates 读取，禁止在 handler 内硬编码',
  appliesTo: { packages: [], dirs: [], paths: ['services/billing/gateway/rates.py'], symbols: [], commands: [] },
})
const broad = fact({
  id: 'services-broad',
  conclusion: 'services 下所有改动都要写回滚步骤',
  appliesTo: { packages: [], dirs: ['services/'], paths: [], symbols: [], commands: [] },
})

const corpus: readonly Fact[] = [charge, rates, broad]

describe('foreign layout', () => {
  it('treats a one-segment service directory as a broad scope', () => {
    expect(scopeWeight('services/')).toBe(1)
    expect(scopeWeight('services/billing/handlers')).toBe(5)
  })

  it('keeps a broad-scope fact below the floor even when its directory matches', () => {
    const hits = rankFacts(corpus, { paths: ['services/billing/handlers/charge.py'], symbols: [], commands: [], tokens: [] }, 5, 3)
    expect(hits.map(hit => hit.fact.id)).toEqual(['charge-idempotency'])
  })

  it('matches a python handler and a terraform-adjacent file by exact path', () => {
    const hits = rankFacts(corpus, { paths: ['services/billing/gateway/rates.py'], symbols: [], commands: [], tokens: [] }, 5, 3)
    expect(hits.map(hit => hit.fact.id)).toEqual(['rate-source'])
  })

  it('requires topic agreement in Chinese on this layout too', () => {
    const question = tokenize('charge 与 refund 的幂等键要一起带吗')
    expect(scoreFact(charge, { paths: ['services/billing/handlers/charge.py'], symbols: [], commands: [], tokens: question })).toBeGreaterThan(5)
    expect(scoreFact(rates, { paths: ['services/billing/gateway/rates.py'], symbols: [], commands: [], tokens: question })).toBe(0)
  })

  it('abstains without path context', () => {
    expect(rankFacts(corpus, { paths: [], symbols: [], commands: [], tokens: tokenize('幂等键怎么加') }, 5, 3)).toEqual([])
  })

  it('renders one line per hit with its scope', () => {
    const hits = rankFacts(corpus, { paths: ['services/billing/handlers/charge.py'], symbols: [], commands: [], tokens: [] }, 5, 3)
    const text = renderScan(hits, { now: NOW })
    expect(text).toContain('charge-idempotency')
    expect(text).toContain('services/billing/handlers/charge.py')
  })
})
