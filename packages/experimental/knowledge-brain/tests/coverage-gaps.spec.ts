/** Coverage-completing cases for optional fields, scoring paths, and rendering branches. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { conflictsFor } from '../src/index.ts'
import { loadFacts } from '../src/load.ts'
import { tokenize } from '../src/tokens.ts'
import { type Fact, parseFactDocument, validateFact } from '../src/facts.ts'
import { rankFacts, scopeWeight, scoreFact } from '../src/rank.ts'
import { isStale, renderDoubt, renderRecall, renderScan } from '../src/render.ts'

const NOW = 1_800_000_000_000
const DAY = 86_400_000

const base = {
  id: 'kb-1',
  conclusion: '结论',
  evidence: { source: 'notes/x', quote: '原文' },
  confidence: 0.9,
  ttlDays: 90,
  updatedAt: NOW,
  trust: 'verified',
  conflictsWith: [],
}

function fact(overrides: Partial<Fact> = {}): Fact {
  return {
    id: 'kb-1',
    conclusion: '结论',
    appliesTo: { packages: [], dirs: [], paths: [], symbols: [], commands: [] },
    evidence: { source: 'notes/x', quote: '原文' },
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

describe('fact validation defaults', () => {
  it('defaults every absent optional field', () => {
    const parsed = validateFact({ ...base, evidence: { source: 'notes/x' } }, 'minimal.md')
    expect(parsed.appliesTo.dirs).toEqual([])
    expect(parsed.exceptions).toBe('')
  })

  it('rejects an empty evidence source', () => {
    expect(() => validateFact({ ...base, evidence: { source: '', quote: '' } }, 'x.md')).toThrow(/evidence\.source/)
  })

  it('rejects a non-string exceptions value', () => {
    expect(() => validateFact({ ...base, exceptions: 3 }, 'x.md')).toThrow(/exceptions must be a string/)
  })

  it('rejects a non-array appliesTo entry list', () => {
    expect(() => validateFact({ ...base, appliesTo: { paths: [1] } }, 'x.md')).toThrow(/paths entries/)
  })

  it('rejects a non-object front matter', () => {
    expect(() => validateFact('nope', 'x.md')).toThrow(/JSON object/)
  })

  it('parses a document that has front matter with no trailing newline', () => {
    const parsed = parseFactDocument(`---\n${JSON.stringify(base)}\n---`, 'noeol.md')
    expect(parsed?.id).toBe('kb-1')
  })
})

describe('scoring paths', () => {
  it('scores command and symbol matches', () => {
    const target = fact({ appliesTo: { packages: [], dirs: [], paths: [], symbols: ['maxMembers'], commands: ['pnpm run gen'] } })
    const query = { paths: [], symbols: ['MaxMembers'], commands: ['pnpm run gen'], tokens: [] }
    expect(scoreFact(target, query)).toBeGreaterThan(0)
  })

  it('matches a package scope by prefix', () => {
    const target = fact({ appliesTo: { packages: ['packages/core/tools'], dirs: [], paths: [], symbols: [], commands: [] } })
    const query = { paths: ['packages/core/tools/src/index.ts'], symbols: [], commands: [], tokens: [] }
    expect(scoreFact(target, query)).toBeGreaterThan(0)
  })

  it('matches a directory scope without a trailing slash', () => {
    const target = fact({ appliesTo: { packages: [], dirs: ['scripts'], paths: [], symbols: [], commands: [] } })
    expect(scoreFact(target, { paths: ['scripts/get.ts'], symbols: [], commands: [], tokens: [] })).toBeGreaterThan(0)
  })

  it('breaks ties by id and honours the limit', () => {
    const first = fact({ id: 'kb-a', appliesTo: { packages: [], dirs: [], paths: ['scripts/get.ts'], symbols: [], commands: [] } })
    const second = fact({ id: 'kb-b', appliesTo: { packages: [], dirs: [], paths: ['scripts/get.ts'], symbols: [], commands: [] } })
    const hits = rankFacts([second, first], { paths: ['scripts/get.ts'], symbols: [], commands: [], tokens: [] }, 5, 1)
    expect(hits.map(hit => hit.fact.id)).toEqual(['kb-a'])
  })
})

describe('rendering branches', () => {
  it('omits the scope suffix when no scope is declared', () => {
    const text = renderScan([{ fact: fact(), score: 9 }], { now: NOW })
    expect(text).toContain('@ -')
  })

  it('renders a duty note without a quote and without exceptions', () => {
    const text = renderDoubt(fact(), [], { now: NOW })
    expect(text).toContain('exceptions: none stated')
    expect(text).toContain('evidence: notes/x')
  })

  it('renders recall without exceptions and without a quote', () => {
    const text = renderRecall(fact({ evidence: { source: 'notes/x', quote: '' } }), { now: NOW })
    expect(text).not.toContain('applies when')
    expect(text).not.toContain('quote:')
  })

  it('renders recall with exceptions', () => {
    const text = renderRecall(fact({ exceptions: '首次创建时' }), { now: NOW })
    expect(text).toContain('applies when: not (首次创建时)')
  })

  it('reports a background item as not stale when fresh', () => {
    expect(isStale(fact({ trust: 'background' }), NOW)).toBe(false)
    expect(renderDoubt(fact({ trust: 'background' }), [], { now: NOW })).toContain('background knowledge')
  })

  it('marks staleness in the scan index only when it is not background', () => {
    const stale = fact({ updatedAt: NOW - 200 * DAY })
    expect(renderScan([{ fact: stale, score: 9 }], { now: NOW })).toContain('[stale]')
  })
})

describe('remaining scoring branches', () => {
  it('matches an exact declared path', () => {
    const target = fact({ appliesTo: { packages: [], dirs: [], paths: ['scripts/gen.ts'], symbols: [], commands: [] } })
    expect(scoreFact(target, { paths: ['scripts/gen.ts'], symbols: [], commands: [], tokens: [] })).toBeGreaterThan(0)
  })

  it('scores symbol and command matches independently', () => {
    const symbolsOnly = fact({ appliesTo: { packages: [], dirs: [], paths: [], symbols: ['maxMembers'], commands: [] } })
    const commandsOnly = fact({ appliesTo: { packages: [], dirs: [], paths: [], symbols: [], commands: ['pnpm run gen'] } })
    expect(scoreFact(symbolsOnly, { paths: [], symbols: ['maxMembers'], commands: [], tokens: [] })).toBe(3)
    expect(scoreFact(commandsOnly, { paths: [], symbols: [], commands: ['pnpm run gen'], tokens: [] })).toBe(5)
  })

  it('adds token overlap from the conclusion and quote', () => {
    const target = fact({ conclusion: 'generated files must be rebuilt', evidence: { source: 'n', quote: 'regenerate catalog' }, appliesTo: { packages: [], dirs: [], paths: ['scripts/gen.ts'], symbols: [], commands: [] } })
    expect(scoreFact(target, { paths: ['scripts/gen.ts'], symbols: [], commands: [], tokens: ['generated', 'regenerate'] })).toBe(10)
  })
})

describe('remaining rendering branches', () => {
  it('renders evidence quote and exceptions when present', () => {
    const text = renderDoubt(fact({ exceptions: '首次除外', evidence: { source: 'notes/x', quote: '原文' } }), [], { now: NOW })
    expect(text).toContain(':: 原文')
    expect(text).toContain('exceptions: 首次除外')
  })

  it('renders the stale marker when doubting an expired fact', () => {
    const text = renderDoubt(fact({ updatedAt: NOW - 200 * DAY }), [], { now: NOW })
    expect(text).toContain('stale: ttl 90d exceeded')
  })
})

describe('loadFacts edge cases', () => {
  it('loads a tree that also contains plain markdown', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'knowledge-brain-plain-'))
    try {
      await writeFile(join(dir, 'plain.md'), '# no front matter\n', 'utf8')
      await writeFile(join(dir, 'fact.md'), `---\n${JSON.stringify(base)}\n---\nbody\n`, 'utf8')
      const facts = await loadFacts(dir)
      expect(facts.map(fact => fact.id)).toEqual(['kb-1'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('scope equality branches', () => {
  it('matches a package by exact equality', () => {
    const target = fact({ appliesTo: { packages: ['packages/core/tools'], dirs: [], paths: [], symbols: [], commands: [] } })
    expect(scoreFact(target, { paths: ['packages/core/tools'], symbols: [], commands: [], tokens: [] })).toBe(5)
  })
})

describe('negative scoring branches', () => {
  it('exercises symbol and command non-matches', () => {
    const target = fact({ appliesTo: { packages: [], dirs: [], paths: [], symbols: ['alpha'], commands: ['pnpm run a'] } })
    expect(scoreFact(target, { paths: [], symbols: ['beta'], commands: ['pnpm run b'], tokens: [] })).toBe(0)
  })

  it('renders doubt without a quote', () => {
    const text = renderDoubt(fact({ evidence: { source: 'notes/x', quote: '' } }), [], { now: NOW })
    expect(text).toContain('evidence: notes/x')
    expect(text).not.toContain('::')
  })
})

describe('package prefix rejection', () => {
  it('does not match an unrelated package path', () => {
    const target = fact({ appliesTo: { packages: ['packages/core/tools'], dirs: [], paths: [], symbols: [], commands: [] } })
    expect(scoreFact(target, { paths: ['packages/other/x.ts'], symbols: [], commands: [], tokens: [] })).toBe(0)
  })
})

describe('scope specificity', () => {
  it('weights a broad scope below a specific one', () => {
    expect(scopeWeight('packages/')).toBe(1)
    expect(scopeWeight('packages/core/tools')).toBe(5)
    expect(scopeWeight('scripts/gen.ts')).toBe(8)
  })

  it('keeps a broad-scope fact below the default floor', () => {
    const broad = fact({ appliesTo: { packages: [], dirs: ['packages/'], paths: [], symbols: [], commands: [] } })
    const hits = rankFacts([broad], { paths: ['packages/core/tools/src/index.ts'], symbols: [], commands: [], tokens: [] }, 5, 5)
    expect(hits).toEqual([])
  })

  it('prefers a specific match over a broad one in the same turn', () => {
    const broad = fact({ id: 'kb-broad', appliesTo: { packages: [], dirs: ['packages/'], paths: [], symbols: [], commands: [] } })
    const specific = fact({ id: 'kb-specific', appliesTo: { packages: [], dirs: [], paths: ['packages/core/tools/src/index.ts'], symbols: [], commands: [] } })
    const hits = rankFacts([broad, specific], { paths: ['packages/core/tools/src/index.ts'], symbols: [], commands: [], tokens: [] }, 5, 2)
    expect(hits.map(hit => hit.fact.id)).toEqual(['kb-specific'])
  })
})

describe('scope deduplication', () => {
  it('deduplicates a scope declared in two lists', () => {
    const duplicate = fact({ appliesTo: { packages: ['packages/core/tools'], dirs: [], paths: ['packages/core/tools'], symbols: [], commands: [] } })
    const score = scoreFact(duplicate, { paths: ['packages/core/tools/src/index.ts'], symbols: [], commands: [], tokens: [] })
    expect(score).toBe(5)
  })
})

describe('authored conflicts', () => {
  it('does not infer a conflict from wording', () => {
    const facts = [
      fact({ id: 'kb-a', conclusion: '生成文件禁止手改', appliesTo: { packages: [], dirs: [], paths: ['scripts/gen.ts'], symbols: [], commands: [] } }),
      fact({ id: 'kb-b', conclusion: '生成文件可以直接手改', appliesTo: { packages: [], dirs: [], paths: ['scripts/gen.ts'], symbols: [], commands: [] } }),
    ]
    expect(conflictsFor(facts[0]!, facts)).toEqual([])
  })

  it('reports an authored conflict in both directions', () => {
    const facts = [
      fact({ id: 'kb-a', conflictsWith: ['kb-b'] }),
      fact({ id: 'kb-b' }),
    ]
    expect(conflictsFor(facts[0]!, facts).map(entry => entry.id)).toEqual(['kb-b'])
    expect(conflictsFor(facts[1]!, facts).map(entry => entry.id)).toEqual(['kb-a'])
  })
})

describe('structural admission', () => {
  it('never admits a fact on topic overlap alone', () => {
    const target = fact({ conclusion: 'generated files need regeneration', evidence: { source: 'n', quote: '' }, appliesTo: { packages: [], dirs: [], paths: ['scripts/gen.ts'], symbols: [], commands: [] } })
    expect(scoreFact(target, { paths: [], symbols: [], commands: [], tokens: ['generated'] })).toBe(0)
    expect(scoreFact(target, { paths: ['scripts/gen.ts'], symbols: [], commands: [], tokens: ['generated'] })).toBe(9)
  })

  it('admits a symbol match without any path', () => {
    const target = fact({ appliesTo: { packages: [], dirs: [], paths: [], symbols: ['maxMembers'], commands: [] } })
    expect(scoreFact(target, { paths: [], symbols: ['maxMembers'], commands: [], tokens: [] })).toBe(3)
  })
})

describe('topic agreement', () => {
  it('requires one topic overlap when the caller supplies topics', () => {
    const target = fact({ conclusion: 'generated files need regeneration', evidence: { source: 'n', quote: '' }, appliesTo: { packages: [], dirs: [], paths: ['scripts/gen.ts'], symbols: [], commands: [] } })
    expect(scoreFact(target, { paths: ['scripts/gen.ts'], symbols: [], commands: [], tokens: ['unrelatedtopic'] })).toBe(0)
    expect(scoreFact(target, { paths: ['scripts/gen.ts'], symbols: [], commands: [], tokens: ['regeneration'] })).toBe(9)
  })

  it('does not require topics when the caller supplies none', () => {
    const target = fact({ appliesTo: { packages: [], dirs: [], paths: ['scripts/gen.ts'], symbols: [], commands: [] } })
    expect(scoreFact(target, { paths: ['scripts/gen.ts'], symbols: [], commands: [], tokens: [] })).toBe(8)
  })
})

describe('CJK topic agreement', () => {
  it('admits a Chinese topic that shares bigrams with the conclusion', () => {
    const target = fact({ conclusion: '生成文件禁止手改，须用生成器', evidence: { source: 'n', quote: '' }, appliesTo: { packages: [], dirs: [], paths: ['scripts/gen.ts'], symbols: [], commands: [] } })
    expect(scoreFact(target, { paths: ['scripts/gen.ts'], symbols: [], commands: [], tokens: tokenize('生成文件能手改吗') })).toBeGreaterThan(8)
  })

  it('vetoes an unrelated Chinese topic', () => {
    const target = fact({ conclusion: '生成文件禁止手改，须用生成器', evidence: { source: 'n', quote: '' }, appliesTo: { packages: [], dirs: [], paths: ['scripts/gen.ts'], symbols: [], commands: [] } })
    expect(scoreFact(target, { paths: ['scripts/gen.ts'], symbols: [], commands: [], tokens: tokenize('沙箱拒绝原因结构化怎么落地') })).toBe(0)
  })
})

describe('configurable topic requirement', () => {
  it('honours a configured topic-token requirement', () => {
    const target = fact({ conclusion: 'generated files must be regenerated', evidence: { source: 'n', quote: '' }, appliesTo: { packages: [], dirs: [], paths: ['scripts/gen.ts'], symbols: [], commands: [] } })
    const query = { paths: ['scripts/gen.ts'], symbols: [], commands: [], tokens: ['generated', 'unrelatedword'] }
    expect(scoreFact(target, query, 1)).toBeGreaterThan(8)
    expect(scoreFact(target, query, 2)).toBe(0)
  })

  it('passes the requirement through rankFacts', () => {
    const target = fact({ conclusion: 'generated files must be regenerated', evidence: { source: 'n', quote: '' }, appliesTo: { packages: [], dirs: [], paths: ['scripts/gen.ts'], symbols: [], commands: [] } })
    const query = { paths: ['scripts/gen.ts'], symbols: [], commands: [], tokens: ['generated', 'unrelatedword'] }
    expect(rankFacts([target], query, 5, 1, 2)).toEqual([])
    expect(rankFacts([target], query, 5, 1, 1)).toHaveLength(1)
  })
})
