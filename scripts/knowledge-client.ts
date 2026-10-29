/**
 * Reference client for the knowledge brain, independent of any harness.
 *
 * A client owns three duties: ask with the signals it actually has, decide how far to read, and
 * record what it delivered. This file implements them once so other clients (a CLI, an editor,
 * another agent runtime) can copy the protocol instead of re-deriving it.
 */

import { type Fact } from '../packages/experimental/knowledge-brain/src/facts.ts'
import { rankFacts, type Query } from '../packages/experimental/knowledge-brain/src/rank.ts'
import { renderDoubt, renderRecall, renderScan } from '../packages/experimental/knowledge-brain/src/render.ts'
import { readFacts } from './promote-facts.ts'

/** One stage of one delivery. */
export interface DeliveryStage {
  /** Protocol stage: `k0` index, `k2` trust report, `k3` full item. */
  readonly stage: 'k0' | 'k2' | 'k3'
  /** Fact the stage is about; absent for the index of an abstention. */
  readonly factId?: string
  /** Exact text the model would read. */
  readonly text: string
  /** Approximate token cost of that text. */
  readonly tokens: number
}

/** Everything one delivery produced, including the abstention case. */
export interface Delivery {
  /** Query the client sent. */
  readonly query: Query
  /** `true` when no fact reached the floor. */
  readonly abstained: boolean
  /** Ordered stages; empty when abstained. */
  readonly stages: readonly DeliveryStage[]
  /** Total token cost across stages. */
  readonly tokens: number
}

/**
 * Ask the brain, then read as far as the answer requires.
 *
 * The client stops at the index unless a hit exists; a hit earns a trust report and one full item,
 * because trusting an item without its evidence is how wrong knowledge gets used.
 * @param facts - Loaded facts.
 * @param query - Turn signals.
 * @param floor - Minimum score for delivery.
 * @param maxScan - Maximum index lines.
 * @param now - Clock used for staleness.
 * @returns The staged delivery.
 */
export function deliver(
  facts: readonly Fact[],
  query: Query,
  floor: number,
  maxScan: number,
  now: number,
): Delivery {
  const hits = rankFacts(facts, query, floor, maxScan)
  if (hits.length === 0) return { query, abstained: true, stages: [], tokens: 0 }
  const stages: DeliveryStage[] = [{ stage: 'k0', text: renderScan(hits, { now }), tokens: tokensOf(renderScan(hits, { now })) }]
  const top = hits[0]
  if (top !== undefined) {
    const doubt = renderDoubt(top.fact, conflictsFor(top.fact, facts), { now })
    stages.push({ stage: 'k2', factId: top.fact.id, text: doubt, tokens: tokensOf(doubt) })
    const recall = renderRecall(top.fact, { now })
    stages.push({ stage: 'k3', factId: top.fact.id, text: recall, tokens: tokensOf(recall) })
  }
  return { query, abstained: false, stages, tokens: stages.reduce((sum, entry) => sum + entry.tokens, 0) }
}

/** Declared conflicts, symmetrically. */
function conflictsFor(fact: Fact, facts: readonly Fact[]): readonly Fact[] {
  return facts.filter(candidate => candidate.id !== fact.id
    && (fact.conflictsWith.includes(candidate.id) || candidate.conflictsWith.includes(fact.id)))
}

/**
 * Approximate the token cost of one payload.
 * @param text - Payload text.
 * @returns Ceiling of characters divided by four.
 */
export function tokensOf(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Span record a client must persist for every delivery. */
export interface SpanRecord {
  /** Epoch milliseconds. */
  readonly at: number
  /** Fact directory the delivery used. */
  readonly corpus: string
  /** Repo-relative paths the turn touched. */
  readonly paths: readonly string[]
  /** Whether the client abstained. */
  readonly abstained: boolean
  /** Delivered fact ids, in stage order, without duplicates. */
  readonly delivered: readonly string[]
  /** Total tokens. */
  readonly tokens: number
}

/**
 * Build the span record for one delivery.
 * @param delivery - Delivery result.
 * @param corpus - Corpus identifier.
 * @param at - Timestamp in epoch milliseconds.
 * @returns Record ready to append to a span log.
 */
export function spanFor(delivery: Delivery, corpus: string, at: number): SpanRecord {
  return {
    at,
    corpus,
    paths: delivery.query.paths,
    abstained: delivery.abstained,
    delivered: [...new Set(delivery.stages.flatMap(stage => (stage.factId === undefined ? [] : [stage.factId])))],
    tokens: delivery.tokens,
  }
}

function list(argv: readonly string[], name: string, fallback: string): string {
  const index = argv.indexOf(name)
  const value = index >= 0 ? argv[index + 1] : undefined
  return value !== undefined ? value : fallback
}

/** CLI entry. */
function main(argv: readonly string[]): void {
  const factsDir = list(argv, '--facts', 'packages/experimental/knowledge-brain/tests/fixtures/corpus')
  const paths = list(argv, '--paths', '').split(',').map(entry => entry.trim()).filter(entry => entry.length > 0)
  const symbols = list(argv, '--symbols', '').split(',').map(entry => entry.trim()).filter(entry => entry.length > 0)
  const topic = list(argv, '--topic', '')
  const facts = readFacts(factsDir)
  const query: Query = { paths, symbols, commands: [], tokens: topic.toLowerCase().match(/[a-z][a-z0-9_$-]{3,}/g) ?? [] }
  const now = Date.now()
  const delivery = deliver(facts, query, 5, 2, now)
  for (const stage of delivery.stages) process.stdout.write(`--- ${stage.stage.toUpperCase()}${stage.factId === undefined ? '' : ` (${stage.factId})`} ---\n${stage.text}\n`)
  const span = spanFor(delivery, factsDir, now)
  process.stdout.write(`\nspan: ${JSON.stringify(span)}\n`)
  if (delivery.abstained) process.stdout.write('abstained: no fact reached the floor\n')
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('knowledge-client.ts')) main(process.argv.slice(2))
