/** The frozen baseline must catch drift, and must not fail for measurement noise. */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compare, measure, toBaseline, type Baseline, type Measurement } from './knowledge-baseline.ts'

const fixtures = 'packages/experimental/knowledge-brain/tests/fixtures'

const measurement: Measurement = {
  facts: 33,
  promoted: 22,
  coverage: 0.758,
  questionAccuracy: 0.909,
  paraphraseAccuracy: 0.909,
}

const baseline: Baseline = { ...measurement, tolerance: 0.05, recordedAt: '2026-10-29T13:04:34.041Z' }

describe('measure', () => {
  it('reproduces the recorded numbers from the frozen fixtures', () => {
    const current = measure({
      factsDir: `${fixtures}/corpus33`,
      replayPath: `${fixtures}/replay33.jsonl`,
      goldPath: `${fixtures}/gold33.json`,
      questionsPath: `${fixtures}/questions33.json`,
      paraphrasedPath: `${fixtures}/questions33-paraphrased.json`,
    })
    expect(current).toEqual(measurement)
  })

  it('measures a stricter topic threshold as a different number', () => {
    const strict = measure({
      factsDir: `${fixtures}/corpus33`,
      replayPath: `${fixtures}/replay33.jsonl`,
      goldPath: `${fixtures}/gold33.json`,
      questionsPath: `${fixtures}/questions33.json`,
      paraphrasedPath: `${fixtures}/questions33-paraphrased.json`,
      minTopicTokens: 3,
    })
    expect(strict.facts).toBe(33)
    // A stricter topic rule can only hold or lose recall, never gain it.
    expect(strict.questionAccuracy).toBeLessThanOrEqual(measurement.questionAccuracy)
  })
})

describe('compare', () => {
  it('accepts an identical run', () => {
    expect(compare(baseline, measurement)).toEqual([])
  })

  it('accepts drift within tolerance and rejects more', () => {
    expect(compare(baseline, { ...measurement, questionAccuracy: 0.87 })).toEqual([])
    const drifts = compare(baseline, { ...measurement, questionAccuracy: 0.8 })
    expect(drifts).toHaveLength(1)
    expect(drifts[0]).toMatchObject({ field: 'questionAccuracy', baseline: 0.909, current: 0.8 })
  })

  it('rejects any shrink in the fact or promoted counts', () => {
    expect(compare(baseline, { ...measurement, facts: 32 })[0]).toMatchObject({ field: 'facts' })
    expect(compare(baseline, { ...measurement, promoted: 20 })[0]).toMatchObject({ field: 'promoted' })
  })

  it('records a baseline document and round-trips it', () => {
    const recorded = toBaseline(measurement, 0.05, new Date('2026-10-29T13:04:34.041Z'))
    expect(recorded).toEqual(baseline)
    const directory = mkdtempSync(join(tmpdir(), 'dsh-baseline-'))
    try {
      const path = join(directory, 'baseline.json')
      writeFileSync(path, `${JSON.stringify(recorded, null, 2)}\n`, 'utf8')
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(baseline)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
