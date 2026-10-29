/** Reviewer tooling: confirming candidates, and drafting conflict pairs for a human read. */

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Fact } from '../packages/experimental/knowledge-brain/src/facts.ts'
import { loadFacts } from '../packages/experimental/knowledge-brain/src/load.ts'
import { confirmFacts, renderFact, writeFacts } from './confirm-facts.ts'
import { draftConflicts, renderReport } from './draft-conflicts.ts'

const NOW = 1_800_000_000_000

function fact(overrides: Partial<Fact> & { id: string }): Fact {
  return {
    conclusion: '重试必须复用同一个幂等键',
    appliesTo: { packages: [], dirs: [], paths: ['services/billing/handlers/charge.py'], symbols: [], commands: [] },
    evidence: { source: 'session:charge', quote: '重试必须复用同一个幂等键' },
    exceptions: '',
    confidence: 0.9,
    ttlDays: 90,
    updatedAt: NOW,
    trust: 'background',
    conflictsWith: [],
    origin: 'candidate.md',
    ...overrides,
  }
}

describe('confirmFacts', () => {
  it('marks a background fact as confirmed and reports what it could not find', () => {
    const candidate = fact({ id: 'c1' })
    const confirmed = fact({ id: 'c2', trust: 'user-confirmed' })
    const { result, updated } = confirmFacts([candidate, confirmed], ['c1', 'c2', 'missing'], NOW + 1)

    expect(result.confirmed).toEqual(['c1'])
    expect(result.alreadyConfirmed).toEqual(['c2'])
    expect(result.unknown).toEqual(['missing'])
    expect(updated).toHaveLength(1)
    expect(updated[0]).toMatchObject({ id: 'c1', trust: 'user-confirmed', updatedAt: NOW + 1 })
  })

  it('round-trips a confirmed fact through the document contract', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-confirm-'))
    try {
      const { updated } = confirmFacts([fact({ id: 'c1' })], ['c1'], NOW + 5)
      writeFacts(updated, directory)
      expect(readdirSync(directory)).toEqual(['c1.md'])
      const reloaded = await loadFacts(directory)
      expect(reloaded).toHaveLength(1)
      expect(reloaded[0]).toMatchObject({ id: 'c1', trust: 'user-confirmed', updatedAt: NOW + 5 })
      const rendered = updated[0]
      expect(rendered).toBeDefined()
      if (rendered !== undefined) expect(renderFact(rendered).startsWith('---\n')).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('draftConflicts', () => {
  it('proposes a pair on one scope whose conclusions overlap in vocabulary', () => {
    const left = fact({ id: 'a', conclusion: '汇率只能从 gateway/rates 读取，禁止硬编码' })
    const right = fact({ id: 'b', conclusion: '汇率可以从 handler 内的常量读取，允许硬编码' })
    const proposals = draftConflicts([left, right])
    expect(proposals).toHaveLength(1)
    expect(proposals[0]).toMatchObject({ left: 'a', right: 'b' })
    expect(proposals[0]?.overlap ?? 0).toBeGreaterThan(0.3)
  })

  it('skips different scopes, identical conclusions, and already-declared pairs', () => {
    const left = fact({ id: 'a' })
    const otherScope = fact({ id: 'b', appliesTo: { packages: [], dirs: ['web/'], paths: [], symbols: [], commands: [] } })
    const identical = fact({ id: 'c' })
    const declared = fact({ id: 'd', conclusion: '汇率只能从 gateway/rates 读取，禁止硬编码', conflictsWith: ['a'] })
    expect(draftConflicts([left, otherScope])).toHaveLength(0)
    expect(draftConflicts([left, identical])).toHaveLength(0)
    const overlapPair = fact({ id: 'e', conclusion: '重试必须复用同一个幂等键，否则重复扣款', conflictsWith: ['a'] })
    expect(draftConflicts([left, overlapPair])).toHaveLength(0)
    expect(draftConflicts([left, declared])).toHaveLength(0)
  })

  it('renders a report with the empty case spelled out', () => {
    const alone = fact({ id: 'a' })
    expect(renderReport([], [alone])).toContain('nothing to review')
    const proposals = draftConflicts([
      fact({ id: 'a', conclusion: '汇率只能从 gateway/rates 读取，禁止硬编码' }),
      fact({ id: 'b', conclusion: '汇率可以从 handler 内的常量读取，允许硬编码' }),
    ])
    const report = renderReport(proposals, [
      fact({ id: 'a', conclusion: '汇率只能从 gateway/rates 读取，禁止硬编码' }),
      fact({ id: 'b', conclusion: '汇率可以从 handler 内的常量读取，允许硬编码' }),
    ])
    expect(report).toContain('`a`')
    expect(report).toContain('## a vs b')
    writeFileSync(join(tmpdir(), 'dsh-conflict-report-scratch.md'), report, 'utf8')
  })
})
