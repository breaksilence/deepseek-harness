/**
 * One-command acceptance check for the knowledge brain.
 *
 * Runs the promotion gate over a replay set, then prints what a model would see for the turns
 * that received knowledge, and fails when the corpus delivers nothing or fails its thresholds.
 *
 * Defaults target the package fixtures so the check runs on a clean checkout:
 *   pnpm run verify-knowledge-brain
 *
 * Override any input for a real corpus:
 *   pnpm run verify-knowledge-brain -- --facts <dir> --replay <jsonl> --gold <json>
 *
 * Thresholds are flags (`--min-question`, `--min-paraphrase`) so a stricter or looser corpus
 * records its own baseline instead of inheriting the fixture's.
 *
 * With `--questions <json>` it also measures question-to-fact accuracy: one generated question per
 * promoted fact, asked with that fact's own scope path, must return the same fact.
 */

import { readFileSync } from 'node:fs'
import { rankFacts } from '../packages/experimental/knowledge-brain/src/rank.ts'
import { renderDoubt, renderRecall, renderScan } from '../packages/experimental/knowledge-brain/src/render.ts'
import { tokenize } from '../packages/experimental/knowledge-brain/src/tokens.ts'
import { evaluate, readFacts, readJsonl } from './promote-facts.ts'

const FIXTURES = 'packages/experimental/knowledge-brain/tests/fixtures'

function flag(argv: readonly string[], name: string, fallback: string): string {
  const index = argv.indexOf(name)
  const value = index >= 0 ? argv[index + 1] : undefined
  return value !== undefined ? value : fallback
}

/** CLI entry. */
function main(argv: readonly string[]): void {
  const factsDir = flag(argv, '--facts', `${FIXTURES}/corpus`)
  const replayPath = flag(argv, '--replay', `${FIXTURES}/replay.jsonl`)
  const goldPath = flag(argv, '--gold', `${FIXTURES}/gold.json`)
  const facts = readFacts(factsDir)
  const turns = readJsonl(replayPath)
  const gold = JSON.parse(readFileSync(goldPath, 'utf8')) as Record<string, readonly string[]>
  const now = Date.now()

  const report = evaluate(facts, turns, gold, 1, 0.5)
  const promoted = report.candidates.filter(candidate => candidate.decision === 'promote')
  const rejected = report.candidates.filter(candidate => candidate.decision !== 'promote')

  process.stdout.write('=== knowledge-brain acceptance ===\n')
  process.stdout.write(`facts: ${report.facts} | turns: ${report.turns} | promoted: ${promoted.length} | rejected: ${rejected.length}\n`)
  process.stdout.write(`coverage: ${report.coverage}\n`)
  for (const candidate of promoted) {
    process.stdout.write(`  promote ${candidate.id} precision=${candidate.precision} support=${candidate.support} added=${candidate.addedTurns}\n`)
  }
  for (const candidate of rejected) {
    process.stdout.write(`  ${candidate.decision} ${candidate.id}: ${candidate.reason}\n`)
  }

  const samples = turns.flatMap((turn, index) => {
    const hits = rankFacts(facts, { paths: turn.paths, symbols: [], commands: [], tokens: [] }, 5, 3)
    return hits.length === 0 ? [] : [{ index, turn, hits }]
  })
  process.stdout.write(`\nturns receiving knowledge: ${samples.length} / ${turns.length}\n`)

  // Labels come from the distillation corpus, never from what this run admitted: a corpus that
  // admits fewer facts must not be rewarded with an easier denominator.
  let needed = 0
  let hits = 0
  let quiet = 0
  let silent = 0
  let spoke = 0
  let falseSpeak = 0
  const byIndex = new Map(samples.map(entry => [entry.index, entry.hits[0]?.fact.id]))
  turns.forEach((_turn, index) => {
    const goldIds = gold[String(index)] ?? []
    const topId = byIndex.get(index)
    if (goldIds.length > 0) {
      needed += 1
      if (topId !== undefined && goldIds.includes(topId)) hits += 1
    } else {
      quiet += 1
      if (topId === undefined) silent += 1
    }
    if (topId !== undefined) {
      spoke += 1
      if (!goldIds.includes(topId)) falseSpeak += 1
    }
  })
  const ratio = (numerator: number, denominator: number): string => (denominator === 0 ? 'n/a' : `${Math.round((numerator / denominator) * 1000) / 10}%`)
  process.stdout.write(`need recall: ${ratio(hits, needed)} (${hits}/${needed}) | delivery precision: ${ratio(spoke - falseSpeak, spoke)} | correct silence: ${ratio(silent, quiet)} (${silent}/${quiet})\n`)

  const example = samples[0]
  const top = example?.hits[0]?.fact
  if (example !== undefined && top !== undefined) {
    process.stdout.write(`\n--- turn #${example.index} paths=${JSON.stringify(example.turn.paths)} ---\n`)
    process.stdout.write(`K0 scan:\n${renderScan(example.hits, { now })}\n`)
    process.stdout.write(`K2 doubt:\n${renderDoubt(top, [], { now })}\n`)
    process.stdout.write(`K3 recall:\n${renderRecall(top, { now })}\n`)
  }

  const measureQuestions = (questionsPath: string): { hit: number; total: number } | undefined => {
    if (questionsPath.length === 0) return undefined
    const questions = JSON.parse(readFileSync(questionsPath, 'utf8')) as readonly (string | { id: string; question: string })[]
    // Questions are generated in corpus order, so align by position over the loaded facts, not
    // over the promotion report (whose candidate order differs).
    const promotedIds = new Set(promoted.map(entry => entry.id))
    const byId = new Map(questions.flatMap(entry => (typeof entry === 'string' ? [] : [[entry.id, entry.question] as const])))
    const answers = facts.flatMap((fact, index) => {
      if (!promotedIds.has(fact.id)) return []
      const question = byId.get(fact.id) ?? (typeof questions[index] === 'string' ? questions[index] : undefined)
      if (question === undefined) return []
      const scope = [...fact.appliesTo.paths, ...fact.appliesTo.dirs, ...fact.appliesTo.packages][0]
      const query = { paths: scope === undefined ? [] : [scope], symbols: [], commands: [], tokens: tokenize(question) }
      const hits = rankFacts(facts, query, 5, 1)
      return [hits[0]?.fact.id === fact.id]
    })
    return { hit: answers.filter(Boolean).length, total: answers.length }
  }

  const minQuestion = Number(flag(argv, '--min-question', '0.8'))
  const minParaphrase = Number(flag(argv, '--min-paraphrase', '0.85'))
  const questionHit = measureQuestions(flag(argv, '--questions', ''))
  if (questionHit !== undefined) {
    process.stdout.write(`question accuracy: ${ratio(questionHit.hit, questionHit.total)} (${questionHit.hit}/${questionHit.total})\n`)
  }
  const paraphraseHit = measureQuestions(flag(argv, '--paraphrased', ''))
  if (paraphraseHit !== undefined) {
    process.stdout.write(`paraphrase accuracy: ${ratio(paraphraseHit.hit, paraphraseHit.total)} (${paraphraseHit.hit}/${paraphraseHit.total})\n`)
  }

  const failure = promoted.length === 0
    ? 'no fact passed promotion'
    : samples.length === 0
      ? 'no turn received knowledge'
      : report.coverage === 0
        ? 'coverage is zero'
        : questionHit !== undefined && questionHit.hit / questionHit.total < minQuestion
          ? `question accuracy below ${minQuestion}`
          : paraphraseHit !== undefined && paraphraseHit.hit / paraphraseHit.total < minParaphrase
            ? `paraphrase accuracy below ${minParaphrase}`
            : undefined
  if (failure !== undefined) {
    process.stderr.write(`verify-knowledge-brain: ${failure}\n`)
    process.exitCode = 1
    return
  }
  process.stdout.write(`\nverify-knowledge-brain: ok (${promoted.length} promoted, ${samples.length}/${turns.length} turns served, ${facts.length} facts loaded)\n`)
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('verify-knowledge-brain.ts')) main(process.argv.slice(2))
