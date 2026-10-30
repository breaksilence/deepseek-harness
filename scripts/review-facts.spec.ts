/** Reviewer tooling: confirming candidates, and drafting conflict pairs for a human read. */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Fact } from '../packages/experimental/knowledge-brain/src/facts.ts'
import { loadFacts } from '../packages/experimental/knowledge-brain/src/load.ts'
import { archiveRejections, confirmFacts, renderFact, writeFacts } from './confirm-facts.ts'
import { draftConflicts, renderReport } from './draft-conflicts.ts'
import { buildPrompt, distillCandidates, statisticsOf } from './distill-facts.ts'

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

  it('archives a rejected candidate outside the corpus and logs why', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-reject-'))
    try {
      const candidate = fact({ id: 'r1', origin: 'r1.md' })
      writeFacts([candidate], directory)
      const archive = archiveRejections([candidate], directory, 'claim was wrong', NOW)

      expect(archive.archived).toEqual(['r1'])
      expect(readdirSync(join(directory, 'rejected'))).toEqual(['r1.md'])
      const logged = readFileSync(archive.logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { id: string; reason: string })
      expect(logged).toEqual([{ id: 'r1', conclusion: candidate.conclusion, reason: 'claim was wrong', at: NOW }])
      expect(await loadFacts(directory)).toHaveLength(0)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
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

describe('unparsable replies', () => {
  const turn = { paths: ['services/billing/handlers/charge.py'], text: '重试必须复用同一个 Idempotency-Key。' }

  it('asks once more when the first reply is prose', async () => {
    const prompts: string[] = []
    const ask = async (prompt: string): Promise<string> => {
      prompts.push(prompt)
      return prompts.length === 1
        ? '这条片段看起来没什么可提炼的。'
        : JSON.stringify([{ conclusion: '重试必须复用同一个 Idempotency-Key', evidence: '重试必须复用同一个 Idempotency-Key', confidence: 0.9 }])
    }
    const outcome = await distillCandidates([turn], ask)
    expect(outcome.accepted).toHaveLength(1)
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('只输出 JSON 数组本身')
  })

  it('drops the turn when the stricter ask is also prose', async () => {
    const ask = async (): Promise<string> => '还是解释。'
    const outcome = await distillCandidates([turn], ask)
    expect(outcome.accepted).toHaveLength(0)
    expect(outcome.rejected[0]?.reason).toBe('reply is not a JSON array')
  })
})

describe('statisticsOf', () => {
  it('reports yield, drop rate, and the reason histogram', () => {
    const stats = statisticsOf(4, 3, [
      { reason: 'evidence quote not found in the turn' },
      { reason: 'evidence quote not found in the turn' },
      { reason: 'already rejected by a reviewer' },
    ])
    expect(stats).toEqual({
      turns: 4,
      accepted: 3,
      rejected: 3,
      yieldPerTurn: 0.75,
      dropRate: 0.5,
      byReason: {
        'evidence quote not found in the turn': 2,
        'already rejected by a reviewer': 1,
      },
    })
  })

  it('avoids dividing by zero on an empty run', () => {
    expect(statisticsOf(0, 0, [])).toMatchObject({ yieldPerTurn: 0, dropRate: 0 })
  })

  it('rides along on a real run', async () => {
    const turn = { paths: ['services/billing/handlers/charge.py'], text: '重试必须复用同一个 Idempotency-Key。' }
    const reply = async (): Promise<string> => JSON.stringify([
      { conclusion: '重试必须复用同一个 Idempotency-Key', evidence: '重试必须复用同一个 Idempotency-Key', confidence: 0.9 },
      { conclusion: '无引句的结论', evidence: '原文里没有这句', confidence: 0.9 },
    ])
    const outcome = await distillCandidates([turn], reply)
    expect(outcome.stats.turns).toBe(1)
    expect(outcome.stats.accepted).toBe(1)
    expect(outcome.stats.byReason).toMatchObject({ 'evidence quote not found in the turn': 1 })
  })
})

describe('buildPrompt', () => {
  const turn = { paths: ['services/billing/handlers/charge.py'], text: '重试必须复用同一个 Idempotency-Key。' }

  it('carries one correct and one wrong evidence example', () => {
    const prompt = buildPrompt(turn)
    expect(prompt).toContain('正确：')
    expect(prompt).toContain('错误：')
    expect(prompt).toContain('引句被改写了')
  })

  it('names the file and quotes the turn', () => {
    const prompt = buildPrompt(turn)
    expect(prompt).toContain('services/billing/handlers/charge.py')
    expect(prompt).toContain(turn.text)
    expect(prompt).not.toContain('评审人已经拒绝过')
  })

  it('lists rejected conclusions as negative examples, capped', () => {
    const examples = Array.from({ length: 10 }, (_value, index) => `被拒结论-${index}`)
    const prompt = buildPrompt(turn, examples.slice(0, 3))
    expect(prompt).toContain('评审人已经拒绝过')
    expect(prompt).toContain('被拒结论-0')
    expect(prompt).not.toContain('被拒结论-5')
  })

  it('feeds the capped examples into the model call', async () => {
    const prompts: string[] = []
    const ask = async (prompt: string): Promise<string> => {
      prompts.push(prompt)
      return '[]'
    }
    await distillCandidates([turn], ask, {
      skipConclusions: ['被拒一', '被拒二', '被拒三'],
      maxRejectedExamples: 2,
    })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('被拒一')
    expect(prompts[0]).toContain('被拒二')
    expect(prompts[0]).not.toContain('被拒三')
  })
})

describe('in-turn deduplication', () => {
  it('drops a near-duplicate of a proposal accepted earlier in the same reply', async () => {
    const turn = { paths: ['services/billing/handlers/charge.py'], text: '重试必须复用同一个 Idempotency-Key，避免重复扣款。' }
    const reply = async (): Promise<string> => JSON.stringify([
      { conclusion: '重试必须复用同一个 Idempotency-Key', evidence: '重试必须复用同一个 Idempotency-Key', confidence: 0.9 },
      { conclusion: '重试时要复用同一个 Idempotency-Key', evidence: '避免重复扣款', confidence: 0.8 },
      { conclusion: '汇率必须从网关读取', evidence: '避免重复扣款', confidence: 0.7 },
    ])
    const outcome = await distillCandidates([turn], reply, { maxPerTurn: 5 })
    expect(outcome.accepted.map(fact => fact.conclusion)).toEqual([
      '重试必须复用同一个 Idempotency-Key',
      '汇率必须从网关读取',
    ])
    expect(outcome.rejected[0]?.reason).toBe('duplicates an accepted proposal in the same turn')
  })

  it('keeps a vague pointer to an accepted proposal: overlap alone cannot see it', async () => {
    const turn = { paths: ['services/billing/handlers/charge.py'], text: '重试必须复用同一个 Idempotency-Key，避免重复扣款。' }
    const reply = async (): Promise<string> => JSON.stringify([
      { conclusion: '给 charge 加重试时必须复用同一个 Idempotency-Key，避免客户端重放导致重复扣款', evidence: '重试必须复用同一个 Idempotency-Key', confidence: 0.9 },
      { conclusion: 'charge 重试复用 Idempotency-Key 的规则已写入评审清单', evidence: '避免重复扣款', confidence: 0.8 },
    ])
    const outcome = await distillCandidates([turn], reply, { maxPerTurn: 5 })
    // Documented limitation: a short reference to a longer claim shares too few tokens to merge.
    expect(outcome.accepted).toHaveLength(2)
    expect(outcome.rejected).toHaveLength(0)
  })
})

describe('distillCandidates with a rejection log', () => {
  it('drops a proposal a reviewer already rejected', async () => {
    const turn = { paths: ['services/billing/handlers/charge.py'], text: '重试必须复用同一个 Idempotency-Key。' }
    const reply = async (): Promise<string> => JSON.stringify([
      { conclusion: '重试必须复用同一个 Idempotency-Key', evidence: '重试必须复用同一个 Idempotency-Key', confidence: 0.9 },
    ])
    const kept = await distillCandidates([turn], reply)
    expect(kept.accepted).toHaveLength(1)

    const skipped = await distillCandidates([turn], reply, { skipConclusions: ['重试必须复用同一个 Idempotency-Key'] })
    expect(skipped.accepted).toHaveLength(0)
    expect(skipped.rejected[0]?.reason).toBe('already rejected by a reviewer')

    // A reviewer rejection also catches a paraphrased restatement of the same claim.
    const paraphrase = await distillCandidates([turn], async () => JSON.stringify([
      { conclusion: '重试时要复用同一个 Idempotency-Key', evidence: '重试必须复用同一个 Idempotency-Key', confidence: 0.9 },
    ]), { skipConclusions: ['重试必须复用同一个 Idempotency-Key 以避免重复扣款'] })
    expect(paraphrase.accepted).toHaveLength(0)
    expect(paraphrase.rejected[0]?.reason).toBe('already rejected by a reviewer')
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
