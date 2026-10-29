/**
 * Coverage redundancy is not uselessness.
 *
 * The promotion gate matches by scope prefix, so two facts on one file always serve the same
 * turns: the second adds no coverage and is rejected. Retrieval still finds both, because
 * delivery also requires topic agreement. This spec pins that split so the fixture corpus cannot
 * quietly change what the two reported bases mean.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { evaluate, readFacts } from '../../../../scripts/promote-facts.ts'
import { rankFacts } from '../src/rank.ts'
import { tokenize } from '../src/tokens.ts'

const fixtures = 'packages/experimental/knowledge-brain/tests/fixtures'

function load() {
  const facts = readFacts(`${fixtures}/corpus33`)
  const turns = readFileSync(`${fixtures}/replay33.jsonl`, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as { paths: readonly string[] })
  const gold = JSON.parse(readFileSync(`${fixtures}/gold33.json`, 'utf8')) as Record<string, readonly string[]>
  const questions = JSON.parse(readFileSync(`${fixtures}/questions33.json`, 'utf8')) as { id: string; question: string }[]
  return { facts, turns, gold, questions }
}

describe('promotion redundancy on the frozen corpus', () => {
  it('admits 22 of 33 and rejects the rest for coverage reasons only', () => {
    const { facts, turns, gold } = load()
    const report = evaluate(facts, turns, gold, 1, 0.5)
    const promoted = report.candidates.filter(candidate => candidate.decision === 'promote')
    const rejected = report.candidates.filter(candidate => candidate.decision !== 'promote')

    expect(facts).toHaveLength(33)
    expect(promoted).toHaveLength(22)
    expect(rejected).toHaveLength(11)
    for (const candidate of rejected) {
      // Both reasons are properties of the coverage arithmetic, never of the claim's content.
      expect(candidate.reason === 'no marginal coverage' || candidate.reason.startsWith('precision')).toBe(true)
    }
  })

  it('still retrieves a rejected fact when its own file and topic are given', () => {
    const { facts, questions } = load()
    const byId = new Map(questions.map(entry => [entry.id, entry.question]))
    const rejected = ['m1-007']
    for (const id of rejected) {
      const fact = facts.find(candidate => candidate.id === id)
      expect(fact).toBeDefined()
      if (fact === undefined) continue
      const scope = [...fact.appliesTo.paths, ...fact.appliesTo.dirs, ...fact.appliesTo.packages][0]
      const hits = rankFacts(
        facts,
        {
          paths: scope === undefined ? [] : [scope],
          symbols: [],
          commands: [],
          tokens: tokenize(byId.get(id) ?? ''),
        },
        5,
        3,
      )
      expect(hits.map(hit => hit.fact.id)).toContain(id)
    }
  })

  it('keeps a shared scope from exceeding the saturation bound', () => {
    const { facts, turns, gold } = load()
    const report = evaluate(facts, turns, gold, 1, 0.5, 3)
    const byId = new Map(facts.map(fact => [fact.id, fact]))
    const byScope = new Map<string, number>()
    for (const candidate of report.candidates.filter(entry => entry.decision === 'promote')) {
      const fact = byId.get(candidate.id)
      if (fact === undefined) continue
      const scope = [...fact.appliesTo.paths, ...fact.appliesTo.dirs][0]
      if (scope === undefined) continue
      byScope.set(scope, (byScope.get(scope) ?? 0) + 1)
    }
    for (const count of byScope.values()) expect(count).toBeLessThanOrEqual(3)
  })
})
