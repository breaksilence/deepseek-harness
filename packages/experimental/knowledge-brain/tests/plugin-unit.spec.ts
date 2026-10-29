/** Unit coverage for the plugin entry: config defaults and tool execution bodies. */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'

const NOW = Date.now()
const FACT = {
  id: 'kb-1',
  conclusion: '生成文件禁止手改',
  appliesTo: { dirs: ['scripts/'], paths: ['scripts/gen.ts'] },
  evidence: { source: 'notes/x', quote: 'q' },
  exceptions: '',
  confidence: 0.9,
  ttlDays: 90,
  updatedAt: NOW,
  trust: 'verified',
}

interface Captured {
  name: string
  execute: (args: Record<string, unknown>) => Promise<string>
}

function fakeContext(): { ctx: Context; captured: Captured[] } {
  const captured: Captured[] = []
  const ctx = {
    tools: {
      register: (definition: { name: string; execute: (args: Record<string, unknown>, exec: unknown) => Promise<string> }) => {
        captured.push({ name: definition.name, execute: args => definition.execute(args, {}) })
        return () => undefined
      },
    },
  } as unknown as Context
  return { ctx, captured }
}

let dir: string | undefined

afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

async function corpus(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'kb-unit-'))
  const factsDir = join(dir, 'facts')
  await mkdir(factsDir)
  await writeFile(join(factsDir, 'kb-1.md'), `---\n${JSON.stringify(FACT)}\n---\nbody\n`, 'utf8')
  return factsDir
}

describe('plugin entry', () => {
  it('defaults floor and maxScan when they are omitted', async () => {
    const factsDir = await corpus()
    const { ctx, captured } = fakeContext()
    apply(ctx, { factsDir })
    expect(captured.map(entry => entry.name)).toEqual(['knowledge_scan', 'knowledge_doubt', 'knowledge_recall'])
    const scan = captured.find(entry => entry.name === 'knowledge_scan')!
    expect(await scan.execute({ topic: 'x', paths: ['scripts/gen.ts'] })).toContain('kb-1')
    expect(await scan.execute({})).toContain('no relevant knowledge')
  })

  it('honours explicit floor and maxScan', async () => {
    const factsDir = await corpus()
    const { ctx, captured } = fakeContext()
    apply(ctx, { factsDir, floor: 99, maxScan: 20 })
    const scan = captured.find(entry => entry.name === 'knowledge_scan')!
    expect(await scan.execute({ paths: ['scripts/gen.ts'] })).toContain('no relevant knowledge')
  })

  it('reports unknown ids from both read tools', async () => {
    const factsDir = await corpus()
    const { ctx, captured } = fakeContext()
    apply(ctx, { factsDir })
    const doubt = captured.find(entry => entry.name === 'knowledge_doubt')!
    const recall = captured.find(entry => entry.name === 'knowledge_recall')!
    expect(await doubt.execute({ id: 'missing' })).toContain('unknown knowledge id: missing')
    expect(await recall.execute({ id: 'missing' })).toContain('unknown knowledge id: missing')
    expect(await recall.execute({ id: 'kb-1' })).toContain('conclusion: 生成文件禁止手改')
    expect(await doubt.execute({ id: 'kb-1' })).toContain('conflicts: none')
  })
})
