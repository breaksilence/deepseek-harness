/**
 * Freeze the corpus measurements into a baseline, then compare later runs against it.
 *
 * The useful question after months is not "what is the number today" but "did anything get
 * worse". This script records the promotion count, coverage, and question accuracy for a corpus,
 * and `--check` fails when a later run drops below the recorded value by more than its tolerance.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { type Fact } from '../packages/experimental/knowledge-brain/src/facts.ts'
import { rankFacts } from '../packages/experimental/knowledge-brain/src/rank.ts'
import { tokenize } from '../packages/experimental/knowledge-brain/src/tokens.ts'
import { fileURLToPath } from 'node:url'
import { evaluate, readFacts } from './promote-facts.ts'

/** Measurements recorded for one corpus. */
export interface Baseline {
  readonly facts: number
  readonly promoted: number
  readonly coverage: number
  /** Question accuracy over the facts the promotion gate admitted: the end-to-end pipeline. */
  readonly pipelineAccuracy: number
  /** Question accuracy over every fact: the retrieval ceiling, independent of admission. */
  readonly retrievalAccuracy: number
  /** Paraphrased questions over admitted facts. */
  readonly pipelineParaphrase: number
  /** Paraphrased questions over every fact. */
  readonly retrievalParaphrase: number
  /** Allowed downward drift before `--check` fails. */
  readonly tolerance: number
  /** Recorded when the baseline was written. */
  readonly recordedAt: string
}

/** One measurement computed from the corpus and its question sets. */
export type Measurement = Omit<Baseline, 'tolerance' | 'recordedAt'>

/** A drift the baseline rejects. */
export interface Drift {
  readonly field: keyof Measurement
  readonly baseline: number
  readonly current: number
}

function loadQuestions(path: string): readonly { id: string; question: string }[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as readonly (string | { id: string; question: string })[]
  return parsed.map((entry, index) => (typeof entry === 'string'
    ? { id: String(index), question: entry }
    : entry))
}

function accuracyOf(
  facts: readonly Fact[],
  questions: readonly { id: string; question: string }[],
  minTopicTokens: number,
): number {
  const byId = new Map(facts.map(fact => [fact.id, fact]))
  let hit = 0
  let asked = 0
  for (const entry of questions) {
    const fact = byId.get(entry.id)
    if (fact === undefined) continue
    asked += 1
    const scope = [...fact.appliesTo.paths, ...fact.appliesTo.dirs, ...fact.appliesTo.packages][0]
    const hits = rankFacts(
      facts,
      { paths: scope === undefined ? [] : [scope], symbols: [], commands: [], tokens: tokenize(entry.question) },
      5,
      1,
      minTopicTokens,
    )
    if (hits[0]?.fact.id === fact.id) hit += 1
  }
  return asked === 0 ? 0 : Number((hit / asked).toFixed(3))
}

/**
 * Measure a corpus.
 * @param options - corpus directory, question sets, promotion inputs, and topic threshold.
 * @returns the measurement.
 */
export function measure(options: {
  readonly factsDir: string
  readonly replayPath: string
  readonly goldPath: string
  readonly questionsPath: string
  readonly paraphrasedPath: string
  readonly minTopicTokens?: number
}): Measurement {
  const facts = readFacts(options.factsDir)
  const replay = readFileSync(options.replayPath, 'utf8').split('\n').filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as { paths: readonly string[] })
  const gold = JSON.parse(readFileSync(options.goldPath, 'utf8')) as Record<string, readonly string[]>
  const report = evaluate(facts, replay, gold, 1, 0.5)
  const promotedIds = new Set(report.candidates.filter(candidate => candidate.decision === 'promote').map(candidate => candidate.id))
  const promoted = facts.filter(fact => promotedIds.has(fact.id))
  const minTopicTokens = options.minTopicTokens ?? 2
  const questions = loadQuestions(options.questionsPath)
  const paraphrased = loadQuestions(options.paraphrasedPath)
  return {
    facts: facts.length,
    promoted: promoted.length,
    coverage: Number(report.coverage.toFixed(3)),
    pipelineAccuracy: accuracyOf(promoted, questions, minTopicTokens),
    retrievalAccuracy: accuracyOf(facts, questions, minTopicTokens),
    pipelineParaphrase: accuracyOf(promoted, paraphrased, minTopicTokens),
    retrievalParaphrase: accuracyOf(facts, paraphrased, minTopicTokens),
  }
}

/**
 * Compare a measurement against a baseline.
 * @param baseline - recorded values.
 * @param current - today's measurement.
 * @returns the regressions; empty when within tolerance.
 */
export function compare(baseline: Baseline, current: Measurement): readonly Drift[] {
  const drifts: Drift[] = []
  const numeric: readonly (keyof Measurement)[] = [
    'facts', 'promoted', 'coverage',
    'pipelineAccuracy', 'retrievalAccuracy', 'pipelineParaphrase', 'retrievalParaphrase',
  ]
  for (const field of numeric) {
    // Counts must not shrink at all; rates may drift down by the recorded tolerance.
    const allowed = field === 'facts' || field === 'promoted' ? 0 : baseline.tolerance
    if (current[field] < baseline[field] - allowed) {
      drifts.push({ field, baseline: baseline[field], current: current[field] })
    }
  }
  return drifts
}

/**
 * Render a measurement as a baseline document.
 * @param measurement - today's numbers.
 * @param tolerance - allowed downward drift for rates.
 * @param now - recording time.
 * @returns the baseline.
 */
export function toBaseline(measurement: Measurement, tolerance: number, now: Date): Baseline {
  return { ...measurement, tolerance, recordedAt: now.toISOString() }
}

function flag(argv: readonly string[], name: string, fallback: string): string {
  const index = argv.indexOf(name)
  const value = index >= 0 ? argv[index + 1] : undefined
  return value ?? fallback
}

function main(): void {
  const argv = process.argv.slice(2)
  const fixtures = flag(argv, '--fixtures', 'packages/experimental/knowledge-brain/tests/fixtures')
  const baselinePath = flag(argv, '--baseline', `${fixtures}/baseline.json`)
  const options = {
    factsDir: `${fixtures}/corpus33`,
    replayPath: `${fixtures}/replay33.jsonl`,
    goldPath: `${fixtures}/gold33.json`,
    questionsPath: `${fixtures}/questions33.json`,
    paraphrasedPath: `${fixtures}/questions33-paraphrased.json`,
    minTopicTokens: Number(flag(argv, '--min-topic-tokens', '2')),
  }
  const current = measure(options)

  if (argv.includes('--write')) {
    const baseline = toBaseline(current, Number(flag(argv, '--tolerance', '0.05')), new Date())
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')
    process.stdout.write(`knowledge-baseline: recorded ${baselinePath} ${JSON.stringify(current)}\n`)
    return
  }

  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline
  const drifts = compare(baseline, current)
  if (drifts.length === 0) {
    process.stdout.write(`knowledge-baseline: ok ${JSON.stringify(current)}\n`)
    return
  }
  for (const drift of drifts) {
    process.stdout.write(`knowledge-baseline: ${drift.field} dropped ${drift.baseline} -> ${drift.current}\n`)
  }
  process.exitCode = 1
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) main()
