/** Store boundary: directory and memory backends serve the same validated facts. */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Fact } from '../src/facts.ts'
import { directoryStore, memoryStore } from '../src/store.ts'

const NOW = 1_800_000_000_000

function fact(id: string, dirs: readonly string[]): Fact {
  return {
    id,
    conclusion: `结论 ${id}`,
    appliesTo: { packages: [], dirs, paths: [], symbols: [], commands: [] },
    evidence: { source: 'notes/x', quote: 'q' },
    exceptions: '',
    confidence: 0.9,
    ttlDays: 90,
    updatedAt: NOW,
    trust: 'verified',
    conflictsWith: [],
    origin: `${id}.md`,
  }
}

async function writeFact(path: string, value: Fact): Promise<void> {
  await writeFile(path, `---\n${JSON.stringify(value)}\n---\n\nbody\n`, 'utf8')
}

let dir: string | undefined

afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

describe('memoryStore', () => {
  it('serves facts ordered by id', async () => {
    const store = memoryStore([fact('kb-b', ['scripts/tools/']), fact('kb-a', ['scripts/tools/'])])
    const facts = await store.list()
    expect(facts.map(entry => entry.id)).toEqual(['kb-a', 'kb-b'])
  })
})

describe('directoryStore', () => {
  it('serves the same facts a memory store built from that directory would', async () => {
    dir = await mkdtemp(join(tmpdir(), 'kb-store-'))
    const factsDir = join(dir, 'facts')
    await mkdir(factsDir)
    await writeFact(join(factsDir, 'kb-b.md'), fact('kb-b', ['scripts/tools/']))
    await writeFact(join(factsDir, 'kb-a.md'), fact('kb-a', ['docs/guide/']))

    const fromDirectory = await directoryStore(factsDir).list()
    const fromMemory = await memoryStore(fromDirectory).list()
    expect(fromDirectory.map(entry => entry.id)).toEqual(['kb-a', 'kb-b'])
    expect(fromMemory).toEqual(fromDirectory)
  })

  it('drops markdown without front matter', async () => {
    dir = await mkdtemp(join(tmpdir(), 'kb-store-plain-'))
    await writeFile(join(dir, 'plain.md'), '# plain\n', 'utf8')
    expect(await directoryStore(dir).list()).toEqual([])
  })
})
