/**
 * Knowledge brain plugin: exposes scan / doubt / recall over a directory of fact documents.
 *
 * The plugin never injects text into a request on its own. Delivery happens only when the model
 * calls a tool, so a turn without a call keeps its context unchanged.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { type Fact } from './facts.ts'
import { type BrainStore, directoryStore } from './store.ts'
import { rankFacts, type Query } from './rank.ts'
import { tokenize } from './tokens.ts'
import { renderDoubt, renderRecall, renderScan } from './render.ts'

/** Cordis plugin name. */
export const name = 'knowledge-brain'
/** Tools are the only service this plugin needs. */
export const inject = ['tools']

/** Deployment-owned knowledge brain limits. */
export interface Config {
  /** Directory that holds fact documents. Required: the corpus never defaults to the repository. */
  factsDir: string
  /** Minimum score for a delivery; below it the tool abstains. Defaults to 5. */
  floor?: number
  /** Topic tokens a candidate must share when the caller supplies a topic. Defaults to 2. */
  readonly minTopicTokens?: number
  /** Maximum hits returned by one scan. Defaults to 2. */
  maxScan?: number
}

/** Schemastery config for Loader defaults and generated configuration docs. */
export const Config: z<Config> = z.object({
  factsDir: z.string().required(),
  floor: z.number().step(1).min(1).default(5),
  maxScan: z.number().step(1).min(1).max(20).default(2),
})

interface ResolvedConfig {
  readonly factsDir: string
  readonly floor: number
  readonly maxScan: number
  readonly minTopicTokens: number
}

function resolveConfig(config: Config): ResolvedConfig {
  return { factsDir: config.factsDir, floor: config.floor ?? 5, maxScan: config.maxScan ?? 2, minTopicTokens: config.minTopicTokens ?? 2 }
}

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

/** Tokens used for topic agreement; latin words plus CJK bigrams. */
function queryTokens(text: string): readonly string[] {
  return tokenize(text)
}

/**
 * Facts this one contradicts.
 *
 * Conflicts are authored: wording and shared scopes are not evidence of contradiction, so the
 * tools never infer one. A fact declares `conflictsWith`; the link is symmetric.
 * @param fact - Fact under scrutiny.
 * @param facts - Every loaded fact.
 * @returns Declared counterpart facts, in input order.
 */
export function conflictsFor(fact: Fact, facts: readonly Fact[]): readonly Fact[] {
  return facts.filter(candidate => candidate.id !== fact.id
    && (fact.conflictsWith.includes(candidate.id) || candidate.conflictsWith.includes(fact.id)))
}

/**
 * Register the three knowledge tools.
 * @param ctx - Tool registry and prompt sections.
 * @param config - Deployment configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const { factsDir, floor, maxScan, minTopicTokens } = resolved
  applyWithStore(ctx, { store: directoryStore(factsDir), floor, maxScan, minTopicTokens })
}

/** Resolved options for one mounted brain. */
export interface BrainOptions {
  /** Fact source; any backend that implements the store boundary. */
  store: BrainStore
  /** Minimum score for a delivery; below it a scan abstains. */
  floor: number
  /** Maximum hits returned by one scan. */
  maxScan: number
  /** Topic tokens a candidate must share when the caller supplies a topic. */
  minTopicTokens: number
}

/**
 * Register the three knowledge tools over an explicit store.
 * @param ctx - Tool registry.
 * @param options - Resolved store and limits.
 */
export function applyWithStore(ctx: Context, options: BrainOptions): void {
  const { store, floor, maxScan, minTopicTokens } = options
  let facts: readonly Fact[] = []
  let ready: Promise<void> | undefined

  const ensureLoaded = (): Promise<void> => {
    ready ??= store.list().then((loaded) => { facts = loaded })
    return ready
  }

  ctx.tools.register(defineTool({
    name: 'knowledge_scan',
    description: 'Report whether project knowledge exists for a topic, path, symbol or command. Returns a compact index (one line per item) and never item bodies. An empty result is a normal answer.',
    parameters: {
      topic: { type: 'string', description: 'What the current task is about, in a few words.' },
      paths: { type: 'array', items: { type: 'string' }, description: 'Repo-relative paths the turn touches, when known.' },
      symbols: { type: 'array', items: { type: 'string' }, description: 'Identifiers the turn is about, when known.' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      await ensureLoaded()
      const query: Query = {
        paths: args.paths ?? [],
        symbols: args.symbols ?? [],
        commands: [],
        tokens: queryTokens(args.topic ?? ''),
      }
      const hits = rankFacts(facts, query, floor, maxScan, minTopicTokens)
      return renderScan(hits, { now: Date.now() })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'knowledge_doubt',
    description: 'Report how much one knowledge item can be trusted: evidence, exceptions, staleness and conflicting items. Use it before relying on an item for a decision.',
    parameters: {
      id: { type: 'string', required: true, description: 'Fact id returned by knowledge_scan.' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      await ensureLoaded()
      const fact = facts.find(candidate => candidate.id === args.id)
      if (fact === undefined) return `unknown knowledge id: ${args.id}`
      return renderDoubt(fact, conflictsFor(fact, facts), { now: Date.now() })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'knowledge_recall',
    description: 'Return one knowledge item in full: conclusion, applicability, evidence quote and mandatory trust markers. Only recall items the current task actually needs.',
    parameters: {
      id: { type: 'string', required: true, description: 'Fact id returned by knowledge_scan.' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      await ensureLoaded()
      const fact = facts.find(candidate => candidate.id === args.id)
      if (fact === undefined) return `unknown knowledge id: ${args.id}`
      return renderRecall(fact, { now: Date.now() })
    },
  }))
}
