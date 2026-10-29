/**
 * Fact file loading and validation for the knowledge brain.
 *
 * A fact file is a Markdown document whose front matter is a single JSON object between
 * `---` fences. The body is the human-readable elaboration and is never delivered to a model.
 */

/** Where a fact applies. Empty arrays are allowed; every present entry must be repo-relative. */
export interface FactScope {
  /** Package directories, e.g. `packages/compaction/compaction-basic`. */
  readonly packages: readonly string[]
  /** Directory prefixes, e.g. `scripts/`. */
  readonly dirs: readonly string[]
  /** Exact repo-relative files. */
  readonly paths: readonly string[]
  /** Identifiers the fact is about. */
  readonly symbols: readonly string[]
  /** Commands the fact is about. */
  readonly commands: readonly string[]
}

/** How far a fact may travel. `background` never reaches an automatic delivery path. */
export type FactTrust = 'verified' | 'user-confirmed' | 'background'

/** A validated knowledge item. */
export interface Fact {
  /** Stable identifier used by every tool. */
  readonly id: string
  /** One executable statement, at most 60 characters. */
  readonly conclusion: string
  /** Trigger scope used for matching and for display. */
  readonly appliesTo: FactScope
  /** Evidence pointer and a verbatim quote from the source. */
  readonly evidence: { readonly source: string; readonly quote: string }
  /** Conditions under which the conclusion does not hold; empty when unconditional. */
  readonly exceptions: string
  /** Author confidence in `[0, 1]`. */
  readonly confidence: number
  /** Days after which the fact is considered stale. */
  readonly ttlDays: number
  /** Last review time in milliseconds since the epoch; drives staleness. */
  readonly updatedAt: number
  /** Origin trust level. */
  readonly trust: FactTrust
  /** Facts this one contradicts, authored rather than inferred from wording. */
  readonly conflictsWith: readonly string[]
  /** File the fact was loaded from, for diagnostics. */
  readonly origin: string
}

const TRUST: readonly FactTrust[] = ['verified', 'user-confirmed', 'background']

function fail(origin: string, message: string): never {
  throw new Error(`${origin}: ${message}`)
}

function strings(value: unknown, origin: string, field: string): readonly string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail(origin, `${field} must be an array`)
  return value.map((entry) => {
    if (typeof entry !== 'string' || entry.length === 0) fail(origin, `${field} entries must be non-empty strings`)
    return entry
  })
}

function scope(raw: unknown, origin: string): FactScope {
  const value = (raw ?? {}) as Record<string, unknown>
  return {
    packages: strings(value.packages, origin, 'appliesTo.packages'),
    dirs: strings(value.dirs, origin, 'appliesTo.dirs'),
    paths: strings(value.paths, origin, 'appliesTo.paths'),
    symbols: strings(value.symbols, origin, 'appliesTo.symbols'),
    commands: strings(value.commands, origin, 'appliesTo.commands'),
  }
}

/**
 * Validate one parsed front-matter object.
 * @param raw - Parsed front matter.
 * @param origin - File path used in messages.
 * @returns The validated fact.
 */
export function validateFact(raw: unknown, origin: string): Fact {
  if (raw === null || typeof raw !== 'object') fail(origin, 'front matter must be a JSON object')
  const value = raw as Record<string, unknown>
  const id = value.id
  if (typeof id !== 'string' || id.length === 0) fail(origin, 'id is required')
  const conclusion = value.conclusion
  if (typeof conclusion !== 'string' || conclusion.trim().length === 0) fail(origin, 'conclusion is required')
  if (conclusion.length > 120) fail(origin, 'conclusion must be at most 120 characters')
  const evidence = value.evidence
  if (evidence === null || typeof evidence !== 'object') fail(origin, 'evidence is required')
  const evidenceValue = evidence as Record<string, unknown>
  if (typeof evidenceValue.source !== 'string' || evidenceValue.source.length === 0) {
    fail(origin, 'evidence.source is required')
  }
  const exceptions = value.exceptions === undefined ? '' : value.exceptions
  if (typeof exceptions !== 'string') fail(origin, 'exceptions must be a string')
  const confidence = value.confidence
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) fail(origin, 'confidence must be within [0, 1]')
  const ttlDays = value.ttlDays
  if (typeof ttlDays !== 'number' || !Number.isFinite(ttlDays) || ttlDays <= 0) fail(origin, 'ttlDays must be positive')
  const updatedAt = value.updatedAt
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt <= 0) {
    fail(origin, 'updatedAt must be an epoch-millisecond timestamp')
  }
  const trust = value.trust
  if (typeof trust !== 'string' || !TRUST.includes(trust as FactTrust)) {
    fail(origin, `trust must be one of ${TRUST.join(', ')}`)
  }
  return {
    id,
    conclusion: conclusion.trim(),
    appliesTo: scope(value.appliesTo, origin),
    evidence: {
      source: evidenceValue.source,
      quote: typeof evidenceValue.quote === 'string' ? evidenceValue.quote : '',
    },
    exceptions,
    confidence,
    ttlDays,
    updatedAt,
    trust: trust as FactTrust,
    conflictsWith: strings(value.conflictsWith, origin, 'conflictsWith'),
    origin,
  }
}

/**
 * Parse one fact document.
 * @param text - Whole file contents.
 * @param origin - File path used in messages.
 * @returns The validated fact, or `undefined` when the document carries no front matter.
 */
export function parseFactDocument(text: string, origin: string): Fact | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  const frontMatter = match?.[1]
  if (frontMatter === undefined) return undefined
  let front: unknown
  try {
    front = JSON.parse(frontMatter)
  } catch {
    fail(origin, 'front matter must be JSON')
  }
  return validateFact(front, origin)
}

/**
 * Parse many documents, skipping ones without front matter.
 * @param documents - File contents paired with their paths.
 * @returns Validated facts in input order.
 */
export function parseFactDocuments(documents: readonly { readonly text: string; readonly origin: string }[]): readonly Fact[] {
  const facts: Fact[] = []
  for (const document of documents) {
    const fact = parseFactDocument(document.text, document.origin)
    if (fact !== undefined) facts.push(fact)
  }
  return facts
}
