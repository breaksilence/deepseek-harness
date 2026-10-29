/**
 * Deterministic matching and ranking for knowledge facts.
 *
 * Matching is scope-first: a fact is a candidate only when the query names one of its
 * packages, directories, paths, symbols, or commands. A broad scope such as `packages/`
 * scores far below a specific package or an exact path, so a generic fact cannot win a turn
 * merely because it names a large directory.
 */

import type { Fact } from './facts.ts'
import { tokenize } from './tokens.ts'

/** Signals extracted from a user turn. */
export interface Query {
  /** Repo-relative paths mentioned or touched by the turn. */
  readonly paths: readonly string[]
  /** Identifiers mentioned by the turn. */
  readonly symbols: readonly string[]
  /** Commands mentioned by the turn. */
  readonly commands: readonly string[]
  /** Free-text tokens used only as a tiebreaker. */
  readonly tokens: readonly string[]
}

/** One ranked candidate. */
export interface Hit {
  /** The matched fact. */
  readonly fact: Fact
  /** Weighted score; higher is better. */
  readonly score: number
}

const PATH_WEIGHT = 8
const SCOPE_WEIGHT = 5
const BROAD_SCOPE_WEIGHT = 1
const SYMBOL_WEIGHT = 3
const COMMAND_WEIGHT = 5
const TOKEN_WEIGHT = 1

/**
 * Weight one declared scope by its specificity.
 * @param scope - Declared directory, package, or path.
 * @returns Weight used when the scope matches the turn.
 */
export function scopeWeight(scope: string): number {
  const trimmed = scope.replace(/\/$/, '')
  if (/\.[a-z]+$/.test(trimmed)) return PATH_WEIGHT
  const segments = trimmed.split('/').filter(Boolean)
  return segments.length <= 1 ? BROAD_SCOPE_WEIGHT : SCOPE_WEIGHT
}

function scopeMatches(scope: string, paths: readonly string[]): boolean {
  const prefix = scope.endsWith('/') ? scope : `${scope}/`
  return paths.some(path => path === scope || path.startsWith(prefix))
}

/**
 * Score one fact against a query.
 * @param fact - Candidate fact.
 * @param query - Turn signals.
 * @param minTopicTokens - Shared topic tokens a fact must have when the caller supplies topics.
 * @returns Weighted score; zero means not a candidate.
 */
export function scoreFact(fact: Fact, query: Query, minTopicTokens = 2): number {
  let score = 0
  let structural = false
  const seen = new Set<string>()
  for (const scope of [...fact.appliesTo.packages, ...fact.appliesTo.dirs, ...fact.appliesTo.paths]) {
    if (seen.has(scope)) continue
    if (!scopeMatches(scope, query.paths)) continue
    structural = true
    seen.add(scope)
    score += scopeWeight(scope)
  }
  const symbolSet = new Set(query.symbols.map(symbol => symbol.toLowerCase()))
  for (const symbol of fact.appliesTo.symbols) {
    if (!symbolSet.has(symbol.toLowerCase())) continue
    structural = true
    score += SYMBOL_WEIGHT
  }
  const commandSet = new Set(query.commands)
  for (const command of fact.appliesTo.commands) {
    if (!commandSet.has(command)) continue
    structural = true
    score += COMMAND_WEIGHT
  }
  const tokenSet = new Set(query.tokens.map(token => token.toLowerCase()))
  let tokenOverlap = 0
  for (const token of tokenize(`${fact.conclusion} ${fact.evidence.quote}`)) {
    if (!tokenSet.has(token)) continue
    tokenOverlap += 1
    score += TOKEN_WEIGHT
  }
  // Topic overlap never admits a fact on its own. When the caller supplies topics the fact must
  // share two of them (or all of them, if fewer were supplied): one shared word is common enough
  // that a wrong file still won, and raising the bar cut those wins threefold for a 3-point
  // recall loss.
  if (!structural) return 0
  const required = Math.min(minTopicTokens, tokenSet.size)
  if (tokenSet.size > 0 && tokenOverlap < required) return 0
  return score
}

/**
 * Rank facts for a turn.
 * @param facts - Candidate facts.
 * @param query - Turn signals.
 * @param floor - Minimum score; below it the turn resolves to an abstention.
 * @param limit - Maximum number of hits.
 * @param minTopicTokens - Shared topic tokens a fact must have when the caller supplies topics.
 * @returns Ranked hits, possibly empty.
 */
export function rankFacts(
  facts: readonly Fact[],
  query: Query,
  floor: number,
  limit: number,
  minTopicTokens = 2,
): readonly Hit[] {
  const hits: Hit[] = []
  for (const fact of facts) {
    const score = scoreFact(fact, query, minTopicTokens)
    if (score < floor) continue
    hits.push({ fact, score })
  }
  hits.sort((left, right) => right.score - left.score || left.fact.id.localeCompare(right.fact.id))
  return hits.slice(0, limit)
}
