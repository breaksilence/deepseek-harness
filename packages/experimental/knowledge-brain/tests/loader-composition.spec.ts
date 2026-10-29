/** REAL-composition test: the knowledge tools through a Loader-booted cordis.yml. */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as KnowledgeBrain from '../src/index.ts'

const NOW = Date.now()

const FACT = {
  id: 'kb-1',
  conclusion: '生成文件禁止手改，须用生成器重新生成',
  appliesTo: { dirs: ['scripts/'], paths: ['scripts/gen-tool-catalog.ts'] },
  evidence: { source: 'notes/toolchain', quote: '生成物由生成器重写' },
  exceptions: '',
  confidence: 0.9,
  ttlDays: 90,
  updatedAt: NOW,
  trust: 'verified',
  conflictsWith: ['kb-conflict'],
}

const FACT_CONFLICT = {
  ...FACT,
  id: 'kb-conflict',
  conflictsWith: [],
  conclusion: '生成文件可以直接手改，编辑后即可生效',
  evidence: { source: 'notes/legacy', quote: '可手改' },
}

const FACT_BACKGROUND = {
  ...FACT,
  id: 'kb-bg',
  conclusion: '外部论文报告称分块越小召回越好',
  appliesTo: { dirs: ['docs/'] },
  evidence: { source: 'papers/chunking', quote: 'smaller chunks improve recall' },
  exceptions: '长文档摘要场景除外',
  trust: 'background',
  conflictsWith: [],
}

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-brain-'))
  const factsDir = join(root, 'facts')
  await writeFile(join(root, 'facts.md'), 'placeholder\n', 'utf8').catch(() => undefined)
  const { mkdir } = await import('node:fs/promises')
  await mkdir(factsDir, { recursive: true })
  await writeFile(join(factsDir, 'kb-1.md'), `---\n${JSON.stringify(FACT)}\n---\n\nbody\n`, 'utf8')
  await writeFile(join(factsDir, 'kb-conflict.md'), `---\n${JSON.stringify(FACT_CONFLICT)}\n---\n\nbody\n`, 'utf8')
  await writeFile(join(factsDir, 'kb-bg.md'), `---\n${JSON.stringify(FACT_BACKGROUND)}\n---\n\nbody\n`, 'utf8')

  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-experimental-knowledge-brain', KnowledgeBrain],
  ])
  const config = [
    "- name: 'cordis:@deepseek-ai/dsh-system-prompt'",
    "- name: 'cordis:@deepseek-ai/dsh-tools'",
    "- name: 'cordis:@deepseek-ai/dsh-experimental-knowledge-brain'",
    '  config:',
    `    factsDir: ${JSON.stringify(factsDir)}`,
    '    floor: 5',
    '    maxScan: 5',
    '',
  ].join('\n')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, config, 'utf8')

  const booted = new Context()
  booted.baseUrl = `${pathToFileURL(root).href}/`
  await booted.plugin(Loader)
  booted.loader.builtins.include = Include
  for (const [specifier, plugin] of modules) booted.loader.builtins[specifier] = plugin
  await booted.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await booted.loader.await()
  return booted
}

function textOf(content: readonly { type: string; text?: string }[]): string {
  return content.map(block => (block.type === 'text' ? block.text ?? '' : '')).join('\n')
}

describe('knowledge brain through real Loader composition', () => {
  it('scans, doubts, recalls, and unregisters on disposal', async () => {
    context = await boot()
    const call = (name: string, args: Record<string, unknown>) => context!.tools.execute({
      name,
      callId: ToolCallId(name),
      arguments: args,
      signal: new AbortController().signal,
    })

    const scan = await call('knowledge_scan', { topic: '生成物禁止手改', paths: ['scripts/gen-tool-catalog.ts'] })
    expect(scan.isError).not.toBe(true)
    const scanText = textOf(scan.content)
    const topicOnly = await call('knowledge_scan', { topic: '生成物' })
    expect(textOf(topicOnly.content)).toContain('no relevant knowledge')
    expect(scanText).toContain('kb-1')
    expect(scanText).toContain('生成文件禁止手改')
    expect(scanText).not.toContain('quote:')

    const doubt = await call('knowledge_doubt', { id: 'kb-1' })
    expect(textOf(doubt.content)).toContain('conflicts (1)')
    expect(textOf(doubt.content)).toContain('kb-conflict')
    const backgroundDoubt = await call('knowledge_doubt', { id: 'kb-bg' })
    expect(textOf(backgroundDoubt.content)).toContain('conflicts: none')
    expect(textOf(doubt.content)).toContain('evidence: notes/toolchain')

    const recall = await call('knowledge_recall', { id: 'kb-1' })
    expect(textOf(recall.content)).toContain('conclusion: 生成文件禁止手改')
    expect(textOf(recall.content)).toContain('quote: 生成物由生成器重写')

    const background = await call('knowledge_recall', { id: 'kb-bg' })
    expect(textOf(background.content)).toContain('[background knowledge')

    const missing = await call('knowledge_recall', { id: 'kb-missing' })
    expect(textOf(missing.content)).toContain('unknown knowledge id: kb-missing')

    const entry = [...context.loader.entries()]
      .find(candidate => candidate.options.name === 'cordis:@deepseek-ai/dsh-experimental-knowledge-brain')
    await entry!.fiber!.dispose()
    expect(context.tools.schemas().some(tool => tool.name === 'knowledge_scan')).toBe(false)
  })
})

describe('configuration defaults', () => {
  it('defaults floor and maxScan when only the corpus is configured', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-knowledge-defaults-'))
    const factsDir = join(dir, 'facts')
    await mkdir(factsDir)
    await writeFile(join(factsDir, 'kb-1.md'), `---\n${JSON.stringify(FACT)}\n---\nbody\n`, 'utf8')
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-experimental-knowledge-brain', KnowledgeBrain],
    ])
    const config = [
      "- name: 'cordis:@deepseek-ai/dsh-system-prompt'",
      "- name: 'cordis:@deepseek-ai/dsh-tools'",
      "- name: 'cordis:@deepseek-ai/dsh-experimental-knowledge-brain'",
      '  config:',
      `    factsDir: ${JSON.stringify(factsDir)}`,
      '',
    ].join('\n')
    const configPath = join(dir, 'cordis.yml')
    await writeFile(configPath, config, 'utf8')
    const booted = new Context()
    booted.baseUrl = `${pathToFileURL(dir).href}/`
    await booted.plugin(Loader)
    booted.loader.builtins.include = Include
    for (const [specifier, plugin] of modules) booted.loader.builtins[specifier] = plugin
    await booted.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await booted.loader.await()
    const result = await booted.tools.execute({
      name: 'knowledge_scan',
      callId: ToolCallId('defaults'),
      arguments: { topic: 'x', paths: ['scripts/gen-tool-catalog.ts'] },
      signal: new AbortController().signal,
    })
    expect(textOf(result.content)).toContain('kb-1')
    await booted.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  })
})
