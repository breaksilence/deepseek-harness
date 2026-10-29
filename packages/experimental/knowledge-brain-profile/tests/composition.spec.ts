/** The shipped bundle patch must compose into a real Loader and register the three tools. */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as KnowledgeBrain from '@deepseek-ai/dsh-experimental-knowledge-brain'

const root = fileURLToPath(new URL('..', import.meta.url))
const NOW = Date.UTC(2026, 9, 29)

const FACT = {
  id: 'kb-bundle',
  conclusion: '生成文件禁止手改，须用生成器重新生成',
  appliesTo: { dirs: ['scripts/'], paths: ['scripts/gen-tool-catalog.ts'] },
  evidence: { source: 'notes/toolchain', quote: '生成物由生成器重写' },
  exceptions: '',
  confidence: 0.9,
  ttlDays: 90,
  updatedAt: NOW,
  trust: 'verified',
  conflictsWith: [],
}

let booted: Context | undefined
let workDirectory: string | undefined

afterEach(async () => {
  await booted?.fiber.dispose()
  booted = undefined
  if (workDirectory !== undefined) await rm(workDirectory, { recursive: true, force: true })
  workDirectory = undefined
})

function shippedLayer(): Parameters<typeof composeEntries>[0][number] {
  const parsed = yaml.load(readFileSync(join(root, 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema })
  return parsed as Parameters<typeof composeEntries>[0][number]
}

describe('knowledge brain bundle through real composition', () => {
  it('composes its patch into entries that mount the plugin with the shipped config', () => {
    const entries = composeEntries([shippedLayer()])
    const brain = entries.find(entry => entry.name === '@deepseek-ai/dsh-experimental-knowledge-brain')
    expect(brain).toBeDefined()
    expect(brain?.config).toMatchObject({ factsDir: './.dsh/knowledge', floor: 5, maxScan: 2, minTopicTokens: 2 })
  })

  it('boots a Loader from the composed entries and serves a scan', async () => {
    workDirectory = await mkdtemp(join(tmpdir(), 'dsh-knowledge-bundle-'))
    const factsDir = join(workDirectory, 'facts')
    await mkdir(factsDir, { recursive: true })
    await writeFile(join(factsDir, 'kb-bundle.md'), `---\n${JSON.stringify(FACT)}\n---\n\nbody\n`, 'utf8')

    // Compose the shipped layer, then point the mounted plugin at this corpus.
    const composed = composeEntries([shippedLayer()]).map(entry => (
      entry.name === '@deepseek-ai/dsh-experimental-knowledge-brain'
        ? { ...entry, config: { ...(entry.config as Record<string, unknown>), factsDir } }
        : entry
    ))
    // The Loader resolves test doubles through the builtin prefix.
    const entries = [
      { id: 'system-prompt', name: 'cordis:@deepseek-ai/dsh-system-prompt' },
      { id: 'tools', name: 'cordis:@deepseek-ai/dsh-tools' },
      ...composed.map(entry => ({ ...entry, name: `cordis:${entry.name ?? ''}` })),
    ]
    const configPath = join(workDirectory, 'cordis.yml')
    await writeFile(configPath, JSON.stringify(entries), 'utf8')

    const context = new Context()
    context.baseUrl = `${pathToFileURL(workDirectory).href}/`
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    context.loader.builtins['@deepseek-ai/dsh-system-prompt'] = SystemPrompt
    context.loader.builtins['@deepseek-ai/dsh-tools'] = ToolRuntime
    context.loader.builtins['@deepseek-ai/dsh-experimental-knowledge-brain'] = KnowledgeBrain
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()
    booted = context

    const names = context.tools.schemas().map(tool => tool.name)
    expect(names).toContain('knowledge_scan')
    expect(names).toContain('knowledge_doubt')
    expect(names).toContain('knowledge_recall')

    const result = await context.tools.execute({
      name: 'knowledge_scan',
      callId: 'call-1' as never,
      arguments: { topic: '生成文件禁止手改', paths: ['scripts/gen-tool-catalog.ts'] },
      signal: new AbortController().signal,
    })
    expect(result.isError).not.toBe(true)
    const text = result.content.map(block => (block.type === 'text' ? block.text ?? '' : '')).join('\n')
    expect(text).toContain('kb-bundle')
  })
})
