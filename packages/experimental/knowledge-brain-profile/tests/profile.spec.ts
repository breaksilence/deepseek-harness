/** The experimental knowledge bundle must declare one parseable layer that mounts the plugin. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

interface BundleManifest {
  private?: boolean
  publishConfig?: { access?: string }
  dependencies?: Record<string, string>
  dsh?: { bundle?: { patch?: string } }
}

interface PatchEntry {
  id?: string
  insert?: { id?: string; name?: string; config?: Record<string, unknown> }[]
}

const root = fileURLToPath(new URL('..', import.meta.url))

function manifest(): BundleManifest {
  return JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as BundleManifest
}

function patches(): PatchEntry[] {
  const declared = manifest().dsh?.bundle?.patch
  if (declared === undefined) throw new Error('bundle patch is not declared')
  const parsed = yaml.load(readFileSync(resolve(root, declared), 'utf8'), { schema: entryListSchema })
  return parsed as PatchEntry[]
}

describe('knowledge brain profile bundle', () => {
  it('publishes one parseable layer that depends on the plugin', () => {
    const declared = manifest()
    expect(declared.private).toBeUndefined()
    expect(declared.publishConfig?.access).toBe('public')
    expect(declared.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(declared.dependencies).toMatchObject({
      '@deepseek-ai/dsh-experimental-knowledge-brain': 'workspace:*',
    })
    expect(Array.isArray(patches())).toBe(true)
  })

  it('mounts the plugin with a facts directory and the shipped thresholds', () => {
    const inserted = patches().flatMap(entry => entry.insert ?? [])
    const brain = inserted.find(entry => entry.id === 'knowledge-brain')
    expect(brain).toBeDefined()
    expect(brain?.name).toBe('@deepseek-ai/dsh-experimental-knowledge-brain')
    expect(brain?.config).toMatchObject({
      factsDir: './.dsh/knowledge',
      floor: 5,
      maxScan: 2,
      minTopicTokens: 2,
    })
  })

  it('adds nothing that would deliver knowledge without a tool call', () => {
    // The bundle may only insert the plugin; any other patch would change composition silently.
    expect(patches()).toHaveLength(1)
    expect(patches()[0]?.insert).toHaveLength(1)
  })
})
