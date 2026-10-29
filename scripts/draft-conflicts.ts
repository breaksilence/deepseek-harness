/**
 * Draft conflict proposals for reviewer confirmation.
 *
 * Facts never self-merge and conflicts are authored, so this script only *proposes*: when two
 * facts on the same scope share most of their topic vocabulary while their conclusions differ,
 * a reviewer should look at the pair. Output is a report; no fact document is modified.
 */

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type Fact } from '../packages/experimental/knowledge-brain/src/facts.ts'
import { loadFacts } from '../packages/experimental/knowledge-brain/src/load.ts'
import { tokenize } from '../packages/experimental/knowledge-brain/src/tokens.ts'

/** One proposed pair a reviewer should read. */
export interface ConflictProposal {
  readonly left: string
  readonly right: string
  readonly sharedScope: string
  readonly overlap: number
}

/** Options for {@link draftConflicts}. */
export interface DraftOptions {
  /** Minimum topic-token overlap (0..1) before a pair is worth a reviewer's attention. */
  readonly minOverlap?: number
}

function scopesOf(fact: Fact): string[] {
  return [...fact.appliesTo.paths, ...fact.appliesTo.dirs, ...fact.appliesTo.packages]
}

/**
 * Overlap coefficient: shared vocabulary relative to the smaller claim. Two conclusions about one
 * rule are usually different lengths, so dividing by the union understates how much they share.
 * @param left - tokens of the first conclusion.
 * @param right - tokens of the second conclusion.
 * @returns the shared share of the smaller token set, 0 when either side is empty.
 */
function overlapCoefficient(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  const smaller = Math.min(left.size, right.size)
  return smaller === 0 ? 0 : shared / smaller
}

/**
 * Propose pairs whose conclusions talk about the same thing on the same scope.
 * @param facts - loaded corpus.
 * @param options - overlap bound.
 * @returns proposals, strongest overlap first.
 */
export function draftConflicts(facts: readonly Fact[], options: DraftOptions = {}): ConflictProposal[] {
  const minOverlap = options.minOverlap ?? 0.3
  const proposals: ConflictProposal[] = []
  for (let left = 0; left < facts.length; left += 1) {
    for (let right = left + 1; right < facts.length; right += 1) {
      const first = facts[left]
      const second = facts[right]
      if (first === undefined || second === undefined) continue
      // Already-declared pairs need no draft.
      if (first.conflictsWith.includes(second.id) || second.conflictsWith.includes(first.id)) continue
      const sharedScope = scopesOf(first).find(scope => scopesOf(second).includes(scope))
      if (sharedScope === undefined) continue
      if (first.conclusion === second.conclusion) continue
      const overlap = overlapCoefficient(new Set(tokenize(first.conclusion)), new Set(tokenize(second.conclusion)))
      if (overlap < minOverlap) continue
      proposals.push({ left: first.id, right: second.id, sharedScope, overlap })
    }
  }
  return proposals.sort((a, b) => b.overlap - a.overlap)
}

/**
 * Render proposals as a reviewable report.
 * @param proposals - pairs to report.
 * @param facts - corpus the pairs came from, used for the conclusion text.
 * @returns the Markdown report.
 */
export function renderReport(proposals: readonly ConflictProposal[], facts: readonly Fact[]): string {
  const byId = new Map(facts.map(fact => [fact.id, fact]))
  const lines = ['# Conflict proposals', '', 'Review each pair, then declare `conflictsWith` on both sides when they truly disagree.', '']
  if (proposals.length === 0) {
    lines.push('No pair shares a scope with overlapping vocabulary; nothing to review.', '')
    return lines.join('\n')
  }
  lines.push('| left | right | shared scope | overlap |', '|---|---|---|---|')
  for (const proposal of proposals) {
    lines.push(`| \`${proposal.left}\` | \`${proposal.right}\` | \`${proposal.sharedScope}\` | ${proposal.overlap.toFixed(2)} |`)
  }
  lines.push('')
  for (const proposal of proposals) {
    lines.push(`## ${proposal.left} vs ${proposal.right}`, '')
    lines.push(`- left: ${byId.get(proposal.left)?.conclusion ?? '(missing)'}`)
    lines.push(`- right: ${byId.get(proposal.right)?.conclusion ?? '(missing)'}`)
    lines.push(`- scope: \`${proposal.sharedScope}\``, '')
  }
  return lines.join('\n')
}

function flag(argv: readonly string[], name: string, fallback: string): string {
  const index = argv.indexOf(name)
  const value = index >= 0 ? argv[index + 1] : undefined
  return value ?? fallback
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const directory = flag(argv, '--facts', '')
  if (directory.length === 0) {
    process.stderr.write('usage: draft-conflicts --facts <dir> [--out <report.md>] [--min-overlap 0.3]\n')
    process.exitCode = 2
    return
  }
  const facts = await loadFacts(directory)
  const proposals = draftConflicts(facts, { minOverlap: Number(flag(argv, '--min-overlap', '0.3')) })
  const report = renderReport(proposals, facts)
  const out = flag(argv, '--out', '')
  if (out.length > 0) writeFileSync(out, report, 'utf8')
  else process.stdout.write(report)
  process.stderr.write(`draft-conflicts: ${proposals.length} proposal(s) from ${facts.length} fact(s)\n`)
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) await main()
