/** Distillation keeps only claims the turn supports, and never bypasses the promotion gate. */

import { describe, expect, it } from 'vitest'
import { distillCandidates, writeCandidates, type DistillTurn } from './distill-facts.ts'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const turn: DistillTurn = {
  paths: ['services/billing/handlers/charge.py'],
  text: '重试必须复用同一个 Idempotency-Key，否则会重复扣款。我们改成这样，并在入口校验。',
}

function reply(proposals: unknown): () => Promise<string> {
  return async () => JSON.stringify(proposals)
}

describe('distillCandidates', () => {
  it('accepts a proposal whose quote appears in the turn', async () => {
    const outcome = await distillCandidates([turn], reply([
      { conclusion: '重试必须复用同一个 Idempotency-Key', evidence: '重试必须复用同一个 Idempotency-Key', confidence: 0.9 },
    ]))
    expect(outcome.accepted).toHaveLength(1)
    expect(outcome.accepted[0]?.conclusion).toBe('重试必须复用同一个 Idempotency-Key')
    expect(outcome.accepted[0]?.trust).toBe('background')
    expect(outcome.accepted[0]?.appliesTo.paths).toEqual(['services/billing/handlers/charge.py'])
    expect(outcome.rejected).toHaveLength(0)
  })

  it('drops a proposal whose quote is not in the turn', async () => {
    const outcome = await distillCandidates([turn], reply([
      { conclusion: '必须在入口校验签名', evidence: '必须在入口校验签名', confidence: 0.9 },
    ]))
    expect(outcome.accepted).toHaveLength(0)
    expect(outcome.rejected[0]?.reason).toContain('evidence quote not found')
  })

  it('drops low-confidence, empty, over-long, and unparsable proposals', async () => {
    const low = await distillCandidates([turn], reply([
      { conclusion: '低置信结论', evidence: '重试必须复用同一个', confidence: 0.2 },
    ]), { minConfidence: 0.5 })
    expect(low.accepted).toHaveLength(0)
    expect(low.rejected[0]?.reason).toContain('below 0.5')

    const empty = await distillCandidates([turn], reply([{ evidence: '重试必须复用同一个', confidence: 0.9 }]))
    expect(empty.rejected[0]?.reason).toBe('missing conclusion')

    const tooLong = await distillCandidates([turn], reply([
      { conclusion: 'x'.repeat(121), evidence: '重试必须复用同一个', confidence: 0.9 },
    ]))
    expect(tooLong.rejected[0]?.reason).toContain('longer than 120 characters')

    const broken = await distillCandidates([turn], async () => 'not json at all')
    expect(broken.accepted).toHaveLength(0)
    expect(broken.rejected[0]?.reason).toBe('reply is not a JSON array')
  })

  it('caps accepted candidates per turn and tolerates a non-array reply', async () => {
    const outcome = await distillCandidates([turn], reply([
      { conclusion: '结论一', evidence: '重试必须复用同一个', confidence: 0.9 },
      { conclusion: '结论二', evidence: '否则会重复扣款', confidence: 0.9 },
      { conclusion: '结论三', evidence: '并在入口校验', confidence: 0.9 },
    ]), { maxPerTurn: 2 })
    expect(outcome.accepted).toHaveLength(2)

    const object = await distillCandidates([turn], async () => '{"a":1}')
    expect(object.rejected[0]?.reason).toBe('reply is not a JSON array')
  })
})

describe('writeCandidates', () => {
  it('writes reviewable documents into the target directory', async () => {
    const outcome = await distillCandidates([turn], reply([
      { conclusion: '重试必须复用同一个 Idempotency-Key', evidence: '重试必须复用同一个 Idempotency-Key', confidence: 0.9 },
    ]))
    const directory = mkdtempSync(join(tmpdir(), 'dsh-distill-'))
    try {
      const written = writeCandidates(outcome.accepted, join(directory, 'candidates'))
      expect(written).toHaveLength(1)
      expect(readdirSync(join(directory, 'candidates'))).toHaveLength(1)
      const text = readFileSync(written[0]!, 'utf8')
      expect(text.startsWith('---\n')).toBe(true)
      expect(text).toContain('"trust":"background"')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
