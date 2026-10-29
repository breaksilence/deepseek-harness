/**
 * Deterministic renderers for the three knowledge tools.
 *
 * Every renderer is a pure function of validated facts and a clock, so a delivered payload
 * can be reconstructed byte-for-byte from the session log.
 */

import type { Fact } from './facts.ts'
import type { Hit } from './rank.ts'

/** Rendering options shared by the delivery tools. */
export interface RenderOptions {
  /** Current time in milliseconds; supplied by the caller for determinism. */
  readonly now: number
}

/**
 * Decide whether a fact is stale.
 * @param fact - Candidate fact.
 * @param now - Current time in milliseconds.
 * @returns True when the fact exceeded its TTL.
 */
export function isStale(fact: Fact, now: number): boolean {
  return now - fact.updatedAt > fact.ttlDays * 86_400_000
}

/**
 * Render the K0 scan payload: one line per hit, never body text.
 * @param hits - Ranked hits.
 * @param options - Rendering options.
 * @returns Compact index text.
 */
export function renderScan(hits: readonly Hit[], options: RenderOptions): string {
  if (hits.length === 0) return 'no relevant knowledge (abstain)'
  const lines = hits.map((hit) => {
    const scope = hit.fact.appliesTo.packages[0] ?? hit.fact.appliesTo.dirs[0] ?? hit.fact.appliesTo.paths[0] ?? '-'
    const flag = hit.fact.trust === 'background' ? ' [background]' : isStale(hit.fact, options.now) ? ' [stale]' : ''
    return `- ${hit.fact.id}${flag}: ${hit.fact.conclusion} @ ${scope}`
  })
  return lines.join('\n')
}

/**
 * Render the K2 doubt payload: evidence, exceptions, staleness, conflicts.
 * @param fact - Fact under scrutiny.
 * @param conflicts - Facts that contradict it.
 * @param options - Rendering options.
 * @returns Doubt report text.
 */
export function renderDoubt(fact: Fact, conflicts: readonly Fact[], options: RenderOptions): string {
  const lines = [
    `id: ${fact.id}`,
    `confidence: ${fact.confidence.toFixed(2)}`,
    `evidence: ${fact.evidence.source}${fact.evidence.quote.length > 0 ? ` :: ${fact.evidence.quote}` : ''}`,
    `exceptions: ${fact.exceptions.length > 0 ? fact.exceptions : 'none stated'}`,
    `trust: ${fact.trust}`,
  ]
  if (fact.trust === 'background') lines.push('warning: background knowledge, not verified in this repository')
  if (isStale(fact, options.now)) lines.push(`stale: ttl ${fact.ttlDays}d exceeded`)
  if (conflicts.length > 0) {
    lines.push(`conflicts (${conflicts.length}):`)
    for (const conflict of conflicts) lines.push(`  - ${conflict.id}: ${conflict.conclusion}`)
  } else {
    lines.push('conflicts: none')
  }
  return lines.join('\n')
}

/**
 * Render the K3 recall payload: the full four-section body.
 * @param fact - Fact to deliver.
 * @param options - Rendering options.
 * @returns Delivery text with mandatory trust markers.
 */
export function renderRecall(fact: Fact, options: RenderOptions): string {
  const lines = [`conclusion: ${fact.conclusion}`]
  if (fact.exceptions.length > 0) lines.push(`applies when: not (${fact.exceptions})`)
  lines.push(`evidence: ${fact.evidence.source}`)
  if (fact.evidence.quote.length > 0) lines.push(`quote: ${fact.evidence.quote}`)
  lines.push(`confidence: ${fact.confidence.toFixed(2)}`)
  if (fact.trust === 'background') lines.push('marker: [background knowledge — not verified in this repository]')
  if (isStale(fact, options.now)) lines.push(`marker: [stale since ttl ${fact.ttlDays}d]`)
  return lines.join('\n')
}
