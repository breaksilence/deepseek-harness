/** Unit tests for fact validation, matching, ranking, and rendering. */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type Fact, parseFactDocument, parseFactDocuments, validateFact } from '../src/facts.ts'
import { loadFacts } from '../src/load.ts'
import { rankFacts, scoreFact } from '../src/rank.ts'
import { isStale, renderDoubt, renderRecall, renderScan } from '../src/render.ts'

const NOW = 1_800_000_000_000
const DAY = 86_400_000

function fact(overrides: Partial<Fact> = {}): Fact {
  return {
    id: 'kb-1',
    conclusion: '生成文件禁止手改',
    appliesTo: { packages: [], dirs: ['scripts/'], paths: ['scripts/gen.ts'], symbols: [], commands: [] },
    evidence: { source: 'notes/gen', quote: '由生成器重写' },
    exceptions: '',
    confidence: 0.9,
    ttlDays: 90,
    updatedAt: NOW,
    trust: 'verified',
    conflictsWith: [],
    origin: 'kb-1.md',
    ...overrides,
  }
}

const front = (value: unknown): string => `---\n${JSON.stringify(value)}\n---\n\nbody text\n`

const validFront = {
  id: 'kb-1',
  conclusion: '生成文件禁止手改',
  appliesTo: { dirs: ['scripts/'] },
  evidence: { source: 'notes/gen', quote: '由生成器重写' },
  exceptions: '',
  confidence: 0.9,
  ttlDays: 90,
  updatedAt: NOW,
  trust: 'verified',
  conflictsWith: [],
}

describe('fact validation', () => {
  it('accepts a complete fact document', () => {
    const parsed = parseFactDocument(front(validFront), 'kb-1.md')
    expect(parsed?.id).toBe('kb-1')
    expect(parsed?.appliesTo.dirs).toEqual(['scripts/'])
  })

  it('returns undefined without front matter', () => {
    expect(parseFactDocument('# plain note\n', 'note.md')).toBeUndefined()
  })

  it('fails loudly on non-JSON front matter', () => {
    expect(() => parseFactDocument('---\nnot json\n---\n', 'bad.md')).toThrow(/front matter must be JSON/)
  })

  it.each([
    ['id', { ...validFront, id: '' }],
    ['conclusion', { ...validFront, conclusion: '' }],
    ['evidence', { ...validFront, evidence: undefined }],
    ['confidence', { ...validFront, confidence: 1.5 }],
    ['ttlDays', { ...validFront, ttlDays: 0 }],
    ['updatedAt', { ...validFront, updatedAt: 0 }],
    ['trust', { ...validFront, trust: 'unknown' }],
    ['appliesTo', { ...validFront, appliesTo: { dirs: 'scripts/' } }],
  ])('rejects an invalid %s', (_field, value) => {
    expect(() => validateFact(value, 'bad.md')).toThrow()
  })

  it('rejects a conclusion longer than 120 characters', () => {
    expect(() => validateFact({ ...validFront, conclusion: 'x'.repeat(121) }, 'long.md')).toThrow(/at most 120/)
  })

  it('parses documents in order and skips plain files', () => {
    const facts = parseFactDocuments([
      { text: front(validFront), origin: 'a.md' },
      { text: 'plain', origin: 'b.md' },
    ])
    expect(facts.map(entry => entry.id)).toEqual(['kb-1'])
  })
})

describe('loadFacts', () => {
  let dir: string | undefined

  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  })

  it('loads nested fact documents sorted by id', async () => {
    dir = await mkdtemp(join(tmpdir(), 'knowledge-brain-'))
    await mkdir(join(dir, 'nested'))
    await writeFile(join(dir, 'a.md'), front({ ...validFront, id: 'kb-2' }), 'utf8')
    await writeFile(join(dir, 'nested', 'b.md'), front({ ...validFront, id: 'kb-1' }), 'utf8')
    await writeFile(join(dir, 'skip.txt'), 'not markdown', 'utf8')
    const facts = await loadFacts(dir)
    expect(facts.map(entry => entry.id)).toEqual(['kb-1', 'kb-2'])
  })
})

describe('ranking', () => {
  it('scores scope matches above text overlap', () => {
    const scoped = scoreFact(fact(), { paths: ['scripts/gen.ts'], symbols: [], commands: [], tokens: [] })
    const textOnly = scoreFact(fact(), { paths: [], symbols: [], commands: [], tokens: ['生成文件'] })
    expect(scoped).toBeGreaterThan(textOnly)
  })

  it('abstains below the floor', () => {
    const hits = rankFacts([fact()], { paths: [], symbols: [], commands: [], tokens: [] }, 5, 5)
    expect(hits).toEqual([])
  })

  it('returns ranked hits and respects the limit', () => {
    const facts = [fact({ id: 'kb-1' }), fact({ id: 'kb-2', conclusion: '第二条' })]
    const hits = rankFacts(facts, { paths: ['scripts/gen.ts'], symbols: [], commands: [], tokens: [] }, 5, 1)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.fact.id).toBe('kb-1')
  })
})

describe('rendering', () => {
  it('reports abstention for an empty scan', () => {
    expect(renderScan([], { now: NOW })).toBe('no relevant knowledge (abstain)')
  })

  it('flags background and stale entries in the scan index', () => {
    const background = fact({ id: 'kb-bg', trust: 'background' })
    const stale = fact({ id: 'kb-old', updatedAt: NOW - 200 * DAY })
    const text = renderScan([{ fact: background, score: 9 }, { fact: stale, score: 8 }], { now: NOW })
    expect(text).toContain('[background]')
    expect(text).toContain('[stale]')
  })

  it('marks staleness from ttl and review time', () => {
    expect(isStale(fact(), NOW)).toBe(false)
    expect(isStale(fact({ updatedAt: NOW - 200 * DAY }), NOW)).toBe(true)
  })

  it('lists conflicts and trust warnings when doubting', () => {
    const left = fact({ id: 'kb-1' })
    const right = fact({ id: 'kb-2', conclusion: '不禁止手改' })
    const text = renderDoubt(left, [right], { now: NOW })
    expect(text).toContain('conflicts (1)')
    expect(text).toContain('kb-2')
  })

  it('warns about background knowledge and staleness on recall', () => {
    const text = renderRecall(fact({ trust: 'background', updatedAt: NOW - 200 * DAY }), { now: NOW })
    expect(text).toContain('[background knowledge')
    expect(text).toContain('[stale since ttl')
    expect(text).toContain('evidence: notes/gen')
  })
})
