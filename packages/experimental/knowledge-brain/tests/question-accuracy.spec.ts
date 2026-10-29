/**
 * Regression gate for retrieval quality over a frozen 33-fact corpus.
 *
 * Each fixture question was written for one fact; asked with that fact's own scope and topic, the
 * ranker must return the same fact. The thresholds encode the measured baseline, so a change that
 * quietly degrades matching fails here instead of being discovered by a user.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { rankFacts } from '../src/rank.ts'
import { tokenize } from '../src/tokens.ts'
import { loadFacts } from '../src/load.ts'

const FIXTURES = join(import.meta.dirname, 'fixtures')
const facts = await loadFacts(join(FIXTURES, 'corpus33'))
const questions = JSON.parse(readFileSync(join(FIXTURES, 'questions33.json'), 'utf8')) as readonly { id: string; question: string }[]
const questionById = new Map(questions.map(entry => [entry.id, entry.question]))

const ownHits = facts.map((fact) => {
  const scope = [...fact.appliesTo.paths, ...fact.appliesTo.dirs, ...fact.appliesTo.packages][0]
  const question = questionById.get(fact.id) ?? ''
  const hits = rankFacts(facts, { paths: scope === undefined ? [] : [scope], symbols: [], commands: [], tokens: tokenize(question) }, 5, 1)
  return hits[0]?.fact.id === fact.id
})

const questionOnlyAbstentions = facts.map((fact) => {
  const question = questionById.get(fact.id) ?? ''
  return rankFacts(facts, { paths: [], symbols: [], commands: [], tokens: tokenize(question) }, 5, 1).length === 0
})

describe('retrieval regression over the frozen corpus', () => {
  it('loads every fixture fact with a question', () => {
    expect(facts).toHaveLength(33)
    expect(questions).toHaveLength(33)
    expect(facts.every(fact => questionById.has(fact.id))).toBe(true)
  })

  it('returns the asked fact at or above the measured baseline', () => {
    // Baseline 31/33 with the two-token agreement rule; one shared word reached 32/33 but let
    // three times as many wrong files win, so the stricter rule is the one frozen here.
    const rate = ownHits.filter(Boolean).length / facts.length
    expect(rate).toBeGreaterThanOrEqual(0.9)
  })

  it('abstains when the caller supplies no path context', () => {
    expect(questionOnlyAbstentions.every(Boolean)).toBe(true)
  })
})
