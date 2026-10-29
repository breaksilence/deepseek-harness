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
  pipelineAccuracy: 0.909,
  retrievalAccuracy: 0.939,
  pipelineParaphrase: 0.909,
  retrievalParaphrase: 0.909,
  candidateYield: null,
  distillDropRate: null,
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
    expect(strict.pipelineAccuracy).toBeLessThanOrEqual(measurement.pipelineAccuracy)
    expect(strict.retrievalAccuracy).toBeLessThanOrEqual(measurement.retrievalAccuracy)
  })
})

describe('compare', () => {
  it('accepts an identical run', () => {
    expect(compare(baseline, measurement)).toEqual([])
  })

  it('accepts drift within tolerance and rejects more', () => {
    expect(compare(baseline, { ...measurement, pipelineAccuracy: 0.87 })).toEqual([])
    const drifts = compare(baseline, { ...measurement, pipelineAccuracy: 0.8 })
    expect(drifts).toHaveLength(1)
    expect(drifts[0]).toMatchObject({ field: 'pipelineAccuracy', baseline: 0.909, current: 0.8 })

    // The retrieval ceiling is tracked separately, so a pipeline-only loss is visible as one drift.
    expect(compare(baseline, { ...measurement, retrievalAccuracy: 0.8 })[0]).toMatchObject({ field: 'retrievalAccuracy' })
  })

  it('rejects any shrink in the fact or promoted counts', () => {
    expect(compare(baseline, { ...measurement, facts: 32 })[0]).toMatchObject({ field: 'facts' })
    expect(compare(baseline, { ...measurement, promoted: 20 })[0]).toMatchObject({ field: 'promoted' })
  })

  it('compares distillation rates when both runs supplied a report', () => {
    const withReport: Measurement = { ...measurement, candidateYield: 1.2, distillDropRate: 0.25 }
    const recorded: Baseline = { ...withReport, tolerance: 0.05, recordedAt: baseline.recordedAt }
    // The tolerance is absolute, so a yield may fall by it (1.20 -> 1.16) but not more.
    expect(compare(recorded, { ...withReport, candidateYield: 1.16 })).toEqual([])
    expect(compare(recorded, { ...withReport, candidateYield: 0.9 })[0]).toMatchObject({ field: 'candidateYield' })
    expect(compare(recorded, { ...withReport, distillDropRate: 0.1 })[0]).toMatchObject({ field: 'distillDropRate' })
    // A run without a report cannot be compared against one that had it.
    expect(compare(recorded, { ...measurement, candidateYield: null })).toEqual([])
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
