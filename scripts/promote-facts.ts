/**
 * Promote knowledge facts through a falsifiable replay gate.
 *
 * Inputs:
 *   --facts   directory of fact documents (JSON front matter, see the knowledge-brain package)
 *   --replay  JSONL where each line is `{ "paths": ["repo/relative/file"] }` for one historical turn
 *   --gold    optional JSON object mapping turn index (as a string) to the fact ids that turn needed
 *   --out     optional path for the JSON report
 *   --min-support / --min-precision  promotion thresholds
 *
 * Without `--gold` the gate can measure support and novelty but not precision; in that case every
 * candidate is reported as `blocked` rather than promoted, because precision is the only signal
 * that separates "relevant" from "merely matching".
 *
 * Support counts a turn only when the matching scope is specific (a multi-segment directory, a
 * package, or a concrete file). A broad scope such as `packages/` matches nearly every turn and
 * would otherwise let a generic fact pass on coverage it does not provide.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Fact, parseFactDocument } from '../packages/experimental/knowledge-brain/src/facts.ts'
import { scopeWeight } from '../packages/experimental/knowledge-brain/src/rank.ts'

/**
 * Minimum scope weight for a turn to count as support.
 *
 * A broad scope such as `packages/` matches almost every turn, so counting it would inflate
 * support and let a generic fact pass on coverage it does not actually provide. Only a
 * multi-segment scope or a concrete file counts.
 */
const MIN_SUPPORT_WEIGHT = 5

/** One historical turn used for replay. */
export interface ReplayTurn {
  /** Repo-relative paths the turn touched. */
  readonly paths: readonly string[]
}

/** Promotion decision for one fact. */
export type Decision = 'promote' | 'blocked' | 'reject' | 'unstable'

/** One evaluated candidate. */
export interface Candidate {
  readonly id: string
  readonly support: number
  readonly matchedTurns: readonly number[]
  readonly precision: number | null
  readonly addedTurns: number
  readonly decision: Decision
  readonly reason: string
}

/** One scope claimed by too many promoted facts, which makes the ranking ambiguous. */
export interface SaturatedScope {
  /** Scope declared by several facts. */
  readonly scope: string
  /** Promoted fact ids claiming it. */
  readonly facts: readonly string[]
}

/** Gate output. */
export interface PromotionReport {
  readonly facts: number
  readonly turns: number
  readonly goldProvided: boolean
  readonly minSupport: number
  readonly minPrecision: number
  readonly coverage: number
  readonly candidates: readonly Candidate[]
  /** Scopes claimed by three or more promoted facts; measured to raise wrong deliveries. */
  readonly saturatedScopes: readonly SaturatedScope[]
}

/**
 * Read a replay file of `{ "paths": [...] }` lines.
 * @param path - JSONL file path.
 * @returns Historical turns in file order.
 */
export function readJsonl(path: string): ReplayTurn[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map((line) => {
      const parsed: unknown = JSON.parse(line)
      const record = parsed as { paths?: unknown; files?: unknown }
      const raw = Array.isArray(record.paths) ? record.paths : Array.isArray(record.files) ? record.files : []
      return { paths: raw.filter((entry): entry is string => typeof entry === 'string') }
    })
}

/**
 * Read every fact document in one directory.
 * @param dir - Directory that holds fact documents.
 * @returns Validated facts in directory order.
 */
export function readFacts(dir: string): Fact[] {
  const facts: Fact[] = []
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (!name.isFile() || !name.name.endsWith('.md')) continue
    const path = join(dir, name.name)
    const fact = parseFactDocument(readFileSync(path, 'utf8'), path)
    if (fact !== undefined) facts.push(fact)
  }
  return facts
}

function matches(fact: Fact, turn: ReplayTurn): boolean {
  const scopes = [...fact.appliesTo.packages, ...fact.appliesTo.dirs, ...fact.appliesTo.paths]
  return scopes.some((scope) => {
    if (scopeWeight(scope) < MIN_SUPPORT_WEIGHT) return false
    const prefix = scope.endsWith('/') ? scope : `${scope}/`
    return turn.paths.some(path => path === scope || path.startsWith(prefix))
  })
}

/**
 * Evaluate and rank candidates.
 * @param facts - Validated facts.
 * @param turns - Replay turns.
 * @param gold - Optional per-turn needed fact ids.
 * @param minSupport - Minimum overlapping turns.
 * @param minPrecision - Minimum precision among overlapping turns.
 * @param maxFactsPerScope - Facts allowed to share one scope before further claims are rejected.
 * @returns Report with per-candidate decisions.
 */
export function evaluate(
  facts: readonly Fact[],
  turns: readonly ReplayTurn[],
  gold: Readonly<Record<string, readonly string[]>> | undefined,
  minSupport: number,
  minPrecision: number,
  maxFactsPerScope = 3,
): PromotionReport {
  const evaluated = facts.map((fact) => {
    const matchedTurns = turns.flatMap((turn, index) => (matches(fact, turn) ? [index] : []))
    let precision: number | null = null
    if (gold !== undefined && matchedTurns.length > 0) {
      const hits = matchedTurns.filter(index => (gold[String(index)] ?? []).includes(fact.id)).length
      precision = Number((hits / matchedTurns.length).toFixed(3))
    }
    return { fact, matchedTurns, precision }
  })

  const covered = new Set<number>()
  const ordered = [...evaluated]
    .filter(entry => entry.matchedTurns.length >= minSupport)
    .sort((left, right) => (right.precision ?? 0) - (left.precision ?? 0) || left.fact.id.localeCompare(right.fact.id))

  const candidates: Candidate[] = []
  const owners = new Map<string, string[]>()
  for (const entry of ordered) {
    const added = entry.matchedTurns.filter(index => !covered.has(index))
    if (gold === undefined) {
      candidates.push({
        id: entry.fact.id,
        support: entry.matchedTurns.length,
        matchedTurns: entry.matchedTurns,
        precision: null,
        addedTurns: added.length,
        decision: 'blocked',
        reason: 'no gold labels: precision unknown',
      })
      continue
    }
    if (entry.precision === null || entry.precision < minPrecision) {
      candidates.push({
        id: entry.fact.id,
        support: entry.matchedTurns.length,
        matchedTurns: entry.matchedTurns,
        precision: entry.precision,
        addedTurns: added.length,
        decision: 'reject',
        reason: `precision ${entry.precision ?? 0} below ${minPrecision}`,
      })
      continue
    }
    if (added.length === 0) {
      candidates.push({
        id: entry.fact.id,
        support: entry.matchedTurns.length,
        matchedTurns: entry.matchedTurns,
        precision: entry.precision,
        addedTurns: 0,
        decision: 'reject',
        reason: 'no marginal coverage',
      })
      continue
    }
    const claimed = [...entry.fact.appliesTo.paths, ...entry.fact.appliesTo.dirs, ...entry.fact.appliesTo.packages]
    const saturated = claimed.find(scope => (owners.get(scope) ?? []).length >= maxFactsPerScope)
    if (saturated !== undefined) {
      candidates.push({
        id: entry.fact.id,
        support: entry.matchedTurns.length,
        matchedTurns: entry.matchedTurns,
        precision: entry.precision,
        addedTurns: added.length,
        decision: 'reject',
        reason: `scope saturated: ${saturated} already claimed by ${maxFactsPerScope}`,
      })
      continue
    }
    for (const scope of claimed) {
      const list = owners.get(scope) ?? []
      list.push(entry.fact.id)
      owners.set(scope, list)
    }
    for (const index of entry.matchedTurns) covered.add(index)
    candidates.push({
      id: entry.fact.id,
      support: entry.matchedTurns.length,
      matchedTurns: entry.matchedTurns,
      precision: entry.precision,
      addedTurns: added.length,
      decision: 'promote',
      reason: 'support, precision, and marginal coverage all met',
    })
  }

  const rejected = evaluated.filter(entry => entry.matchedTurns.length < minSupport)
  for (const entry of rejected) {
    candidates.push({
      id: entry.fact.id,
      support: entry.matchedTurns.length,
      matchedTurns: entry.matchedTurns,
      precision: entry.precision,
      addedTurns: 0,
      decision: 'reject',
      reason: `support ${entry.matchedTurns.length} below ${minSupport}`,
    })
  }

  const saturatedScopes = [...owners.entries()]
    .filter(([, owners]) => owners.length >= 3)
    .map(([scope, owners]) => ({ scope, facts: owners }))
    .sort((left, right) => right.facts.length - left.facts.length || left.scope.localeCompare(right.scope))

  return {
    facts: facts.length,
    turns: turns.length,
    goldProvided: gold !== undefined,
    minSupport,
    minPrecision,
    coverage: turns.length === 0 ? 0 : Number((covered.size / turns.length).toFixed(3)),
    candidates,
    saturatedScopes,
  }
}

/**
 * Keep only facts promoted by both replay sets, so an overfit promotion is downgraded.
 * @param primary - Report from the primary replay set.
 * @param secondary - Report from the second, unseen replay set.
 * @returns The primary report with unstable promotions downgraded to `unstable`.
 */
export function requireStability(primary: PromotionReport, secondary: PromotionReport): PromotionReport {
  const stable = new Set(secondary.candidates.filter(entry => entry.decision === 'promote').map(entry => entry.id))
  const candidates = primary.candidates.map((entry) => {
    if (entry.decision !== 'promote') return entry
    if (stable.has(entry.id)) return { ...entry, decision: 'promote' as const, reason: `${entry.reason}; stable across both replay sets` }
    return { ...entry, decision: 'unstable' as const, reason: 'promoted on the primary set only' }
  })
  const covered = new Set<number>()
  for (const entry of candidates) if (entry.decision === 'promote') for (const index of entry.matchedTurns) covered.add(index)
  return {
    ...primary,
    candidates,
    coverage: primary.turns === 0 ? 0 : Number((covered.size / primary.turns).toFixed(3)),
  }
}

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

/** CLI entry. */
function main(argv: readonly string[]): void {
  const factsDir = flag(argv, '--facts')
  const replayPath = flag(argv, '--replay')
  if (factsDir === undefined || replayPath === undefined) {
    process.stderr.write('usage: promote-facts --facts <dir> --replay <jsonl> [--gold <json>] [--out <file>] [--second-replay <jsonl>] [--second-gold <json>] [--max-facts-per-scope 3]\n')
    process.exitCode = 2
    return
  }
  const goldPath = flag(argv, '--gold')
  const outPath = flag(argv, '--out')
  const minSupport = Number(flag(argv, '--min-support') ?? 5)
  const minPrecision = Number(flag(argv, '--min-precision') ?? 0.55)
  const maxFactsPerScope = Number(flag(argv, '--max-facts-per-scope') ?? 3)
  const facts = readFacts(factsDir)
  const gold = goldPath === undefined ? undefined : JSON.parse(readFileSync(goldPath, 'utf8')) as Record<string, readonly string[]>
  let report = evaluate(facts, readJsonl(replayPath), gold, minSupport, minPrecision, maxFactsPerScope)

  const secondReplay = flag(argv, '--second-replay')
  const secondGoldPath = flag(argv, '--second-gold')
  if (secondReplay !== undefined) {
    const secondGold = secondGoldPath === undefined ? undefined : JSON.parse(readFileSync(secondGoldPath, 'utf8')) as Record<string, readonly string[]>
    report = requireStability(report, evaluate(facts, readJsonl(secondReplay), secondGold, minSupport, minPrecision, maxFactsPerScope))
  }

  const serialized = `${JSON.stringify(report, null, 2)}\n`
  if (outPath === undefined) process.stdout.write(serialized)
  else writeFileSync(outPath, serialized, 'utf8')
  const counts: Record<string, number> = {}
  for (const entry of report.candidates) counts[entry.decision] = (counts[entry.decision] ?? 0) + 1
  process.stderr.write(`promote-facts: ${JSON.stringify(counts)}, coverage ${report.coverage}, saturated scopes ${report.saturatedScopes.length}\n`)
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('promote-facts.ts')) main(process.argv.slice(2))
