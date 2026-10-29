/**
 * Propose candidate facts from recorded turns, keeping only claims the turn actually supports.
 *
 * This is the front half of the corpus pipeline: it reads turns, asks a model for candidate
 * facts, and drops every candidate whose evidence quote does not appear verbatim in the turn it
 * came from. Accepted candidates land as `trust: background` documents that still have to pass
 * `promote-facts`, so a distillation error cannot reach a profile on its own.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseFactDocument, type Fact } from '../packages/experimental/knowledge-brain/src/facts.ts'
import { tokenize } from '../packages/experimental/knowledge-brain/src/tokens.ts'

/** One recorded turn: the paths it touched and the text a candidate may be distilled from. */
export interface DistillTurn {
  readonly paths: readonly string[]
  readonly text: string
}

/** Asks a model for a JSON array of candidate facts; injected so tests never reach the network. */
export type CandidateAsker = (prompt: string) => Promise<string>

/** Options for {@link distillCandidates}. */
export interface DistillOptions {
  /** Upper bound on candidates accepted per turn. */
  readonly maxPerTurn?: number
  /** Minimum confidence a candidate must declare. */
  readonly minConfidence?: number
  /** Conclusions already rejected by a reviewer; matching proposals are dropped. */
  readonly skipConclusions?: readonly string[]
  /** Cap on how many rejected conclusions are quoted back to the model as negative examples. */
  readonly maxRejectedExamples?: number
}

/** One distillation result, including why a proposal was dropped. */
export interface DistillOutcome {
  readonly accepted: readonly Fact[]
  readonly rejected: readonly { readonly conclusion: string; readonly reason: string }[]
}

/**
 * Build the distillation prompt for one turn.
 * @param turn - recorded turn.
 * @param rejectedExamples - conclusions a reviewer already rejected, shown so the model does not restate them.
 * @returns the prompt text.
 */
export function buildPrompt(turn: DistillTurn, rejectedExamples: readonly string[] = []): string {
  const avoided = rejectedExamples.length === 0
    ? ''
    : `\n评审人已经拒绝过下面这些结论，不要用同样的意思重复提出：\n${rejectedExamples.map(text => `- ${text}`).join('\n')}\n`
  return `下面是一次开发会话的片段。请提取"以后还想知道的项目知识"，每条包含：
- conclusion：不超过 60 字的结论
- evidence：必须从下面原文里**逐字摘出**的一句话
- confidence：0 到 1

只输出 JSON 数组，没有可提炼的内容就输出 []。
${avoided}
涉及文件：${turn.paths.join(', ') || '(无)'}
原文：
${turn.text}`
}

function frontMatter(fact: Record<string, unknown>): string {
  return `---\n${JSON.stringify(fact)}\n---\n\n${String(fact.conclusion)}\n`
}

/**
 * Distill candidate facts from turns.
 * @param turns - recorded turns in chronological order.
 * @param ask - model call used for each turn.
 * @param options - acceptance bounds.
 * @returns accepted facts and rejected proposals with their reason.
 */
export async function distillCandidates(
  turns: readonly DistillTurn[],
  ask: CandidateAsker,
  options: DistillOptions = {},
): Promise<DistillOutcome> {
  const maxPerTurn = options.maxPerTurn ?? 2
  const minConfidence = options.minConfidence ?? 0.5
  // Exact and near-duplicate matching: a model usually restates a rejected claim differently.
  const rejectedConclusions = options.skipConclusions ?? []
  const rejectedExamples = rejectedConclusions.slice(0, options.maxRejectedExamples ?? 8)
  const skip = rejectedConclusions.map(text => new Set(tokenize(text)))
  const overlaps = (tokens: ReadonlySet<string>, other: ReadonlySet<string>): boolean => {
    let shared = 0
    for (const token of tokens) if (other.has(token)) shared += 1
    const smaller = Math.min(tokens.size, other.size)
    return smaller > 0 && shared / smaller >= 0.6
  }
  const nearDuplicate = (conclusion: string): boolean => {
    const tokens = new Set(tokenize(conclusion))
    if (tokens.size === 0) return false
    return skip.some(rejected => overlaps(tokens, rejected))
  }
  const accepted: Fact[] = []
  const rejected: { conclusion: string; reason: string }[] = []
  let sequence = 0

  for (const turn of turns) {
    const reply = await ask(buildPrompt(turn, rejectedExamples))
    const start = reply.indexOf('[')
    const end = reply.lastIndexOf(']')
    if (start < 0 || end <= start) {
      rejected.push({ conclusion: '(unparsable reply)', reason: 'reply is not a JSON array' })
      continue
    }
    let proposals: unknown
    try {
      proposals = JSON.parse(reply.slice(start, end + 1))
    } catch {
      rejected.push({ conclusion: '(unparsable reply)', reason: 'reply is not a JSON array' })
      continue
    }
    if (!Array.isArray(proposals)) {
      rejected.push({ conclusion: '(unparsable reply)', reason: 'reply is not a JSON array' })
      continue
    }

    let kept = 0
    const acceptedThisTurn: Set<string>[] = []
    for (const proposal of proposals) {
      if (kept >= maxPerTurn) break
      const record = proposal as {
        conclusion?: unknown
        evidence?: unknown
        confidence?: unknown
      }
      const conclusion = typeof record.conclusion === 'string' ? record.conclusion.trim() : ''
      const quote = typeof record.evidence === 'string' ? record.evidence.trim() : ''
      const confidence = typeof record.confidence === 'number' ? record.confidence : Number.NaN
      if (conclusion.length === 0) {
        rejected.push({ conclusion: '(empty)', reason: 'missing conclusion' })
        continue
      }
      if (nearDuplicate(conclusion)) {
        rejected.push({ conclusion, reason: 'already rejected by a reviewer' })
        continue
      }
      const tokens = new Set(tokenize(conclusion))
      if (acceptedThisTurn.some(other => overlaps(tokens, other))) {
        rejected.push({ conclusion, reason: 'duplicates an accepted proposal in the same turn' })
        continue
      }
      // Falsifiability: the quote must exist in the turn, or the claim has no support.
      if (quote.length === 0 || !turn.text.includes(quote)) {
        rejected.push({ conclusion, reason: 'evidence quote not found in the turn' })
        continue
      }
      if (!Number.isFinite(confidence) || confidence < minConfidence) {
        rejected.push({ conclusion, reason: `confidence ${String(record.confidence)} below ${minConfidence}` })
        continue
      }
      if (conclusion.length > 120) {
        rejected.push({ conclusion: conclusion.slice(0, 20), reason: 'conclusion longer than 120 characters' })
        continue
      }
      sequence += 1
      const scope = turn.paths.filter(path => path.includes('/'))
      const document = frontMatter({
        id: `candidate-${sequence}`,
        conclusion,
        appliesTo: { packages: [], dirs: [], paths: [...scope], symbols: [], commands: [] },
        evidence: { source: `session:${turn.paths[0] ?? 'unknown'}`, quote },
        exceptions: '',
        confidence,
        ttlDays: 90,
        updatedAt: Date.now(),
        trust: 'background',
        conflictsWith: [],
      })
      const parsed = parseFactDocument(document, `candidate-${sequence}.md`)
      if (parsed === undefined) {
        rejected.push({ conclusion, reason: 'candidate failed fact validation' })
        continue
      }
      accepted.push(parsed)
      acceptedThisTurn.push(tokens)
      kept += 1
    }
  }

  return { accepted, rejected }
}

/**
 * Write accepted candidates as documents a reviewer can edit before promoting.
 * @param facts - accepted candidates.
 * @param directory - destination directory, created when missing.
 * @returns the written file paths.
 */
export function writeCandidates(facts: readonly Fact[], directory: string): string[] {
  mkdirSync(directory, { recursive: true })
  return facts.map((fact) => {
    const file = join(directory, `${fact.id}.md`)
    writeFileSync(file, frontMatter({ ...fact }), 'utf8')
    return file
  })
}

function flag(argv: readonly string[], name: string, fallback: string): string {
  const index = argv.indexOf(name)
  const value = index >= 0 ? argv[index + 1] : undefined
  return value ?? fallback
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const turnsPath = flag(argv, '--turns', '')
  const outDir = flag(argv, '--out', 'tmp/candidates')
  if (turnsPath.length === 0) {
    process.stderr.write('usage: distill-facts --turns <jsonl> [--out <dir>] [--model <name>]\n')
    process.exitCode = 2
    return
  }
  const { readFileSync: read } = await import('node:fs')
  const { homedir } = await import('node:os')
  const turns = read(turnsPath, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as DistillTurn)
  const credentials = read(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
  const key = /COMPANY_API_KEY:\s*(\S+)/.exec(credentials)?.[1] ?? ''
  const endpoint = flag(argv, '--endpoint', 'https://aisg.qianxin-inc.cn/v1/chat/completions')
  const model = flag(argv, '--model', 'deepseek-v4-flash')
  const ask: CandidateAsker = async (prompt) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, max_tokens: 1200, temperature: 0, messages: [{ role: 'user', content: prompt }] }),
    })
    const body = await response.json() as { choices?: { message?: { content?: string; reasoning_content?: string } }[] }
    const message = body.choices?.[0]?.message ?? {}
    return message.content ?? message.reasoning_content ?? ''
  }
  const rejectedLog = flag(argv, '--skip-rejected', '')
  const skipConclusions = rejectedLog.length === 0
    ? []
    : read(rejectedLog, 'utf8')
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => (JSON.parse(line) as { conclusion?: string }).conclusion ?? '')
  const outcome = await distillCandidates(turns, ask, { skipConclusions })
  const written = writeCandidates(outcome.accepted, outDir)
  process.stdout.write(`distill-facts: ${outcome.accepted.length} accepted, ${outcome.rejected.length} rejected, ${written.length} written to ${outDir}\n`)
  for (const rejection of outcome.rejected) {
    process.stdout.write(`  rejected: ${rejection.conclusion} — ${rejection.reason}\n`)
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main()
}
