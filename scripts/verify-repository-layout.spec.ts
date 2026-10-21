/** Repository layout and scratch discipline gate. */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  findLayoutViolations,
  readLayoutFacts,
  TOP_LEVEL_DIRECTORIES,
  type LayoutFacts,
} from './verify-repository-layout.ts'

const repositoryRoot = resolve(import.meta.dirname, '..')
const fixtureRoots: string[] = []

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function git(root: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function write(root: string, path: string, content = '# fixture\n'): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), content)
}

/**
 * Build a fixture repository whose layout mirrors the real one.
 * @returns the absolute fixture root.
 */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-repository-layout-'))
  fixtureRoots.push(root)
  git(root, ['init', '--quiet'])
  write(root, '.gitignore', 'tmp/\nnode_modules/\nlib/\n')
  write(root, 'AGENTS.md')
  write(root, 'packages/core/probe/package.json', '{ "name": "probe" }\n')
  write(root, 'docs/development.md')
  git(root, ['add', '--all'])
  return root
}

function facts(overrides: Partial<LayoutFacts> = {}): LayoutFacts {
  return {
    directories: [],
    files: [],
    ignored: new Set(),
    tracked: ['AGENTS.md'],
    trackedIgnored: [],
    scratchIgnored: true,
    ...overrides,
  }
}

const scratchMessage = 'tmp/: the scratch root must be git-ignored so temporary files cannot be committed (add "tmp/" to .gitignore)'

describe('repository layout rules', () => {
  it('accepts the declared layout with an ignored scratch root', () => {
    expect(findLayoutViolations(facts({
      directories: ['packages', 'docs'],
      files: ['AGENTS.md'],
      ignored: new Set(['tmp']),
    }))).toEqual([])
  })

  it.each(['tools', 'src', 'temp', '.tmp'])('rejects undeclared top-level directory %s', (directory) => {
    expect(findLayoutViolations(facts({ directories: [directory] }))).toEqual([
      `${directory}/: a new top-level directory is not part of the layout — put code in packages/<group>/<pkg>/ and temporary files in tmp/`,
    ])
  })

  it.each([...TOP_LEVEL_DIRECTORIES])('admits declared directory %s', (directory) => {
    expect(findLayoutViolations(facts({ directories: [directory] }))).toEqual([])
  })

  it('admits Git metadata whether it is a checkout directory or a linked-worktree file', () => {
    expect(findLayoutViolations(facts({ directories: ['.git'] }))).toEqual([])
    expect(findLayoutViolations(facts({ files: ['.git'] }))).toEqual([])
  })

  it('admits an ignored top-level directory as local state', () => {
    expect(findLayoutViolations(facts({
      directories: ['node_modules'],
      ignored: new Set(['node_modules', 'tmp']),
    }))).toEqual([])
  })

  it('rejects an untracked file at the repository root', () => {
    expect(findLayoutViolations(facts({ files: ['scratch.sql'] }))).toEqual([
      'scratch.sql: untracked file at the repository root — temporary or draft files belong in tmp/',
    ])
  })

  it('reports only the untracked root entries', () => {
    expect(findLayoutViolations(facts({ files: ['scratch.sql', 'AGENTS.md'] }))).toHaveLength(1)
  })

  it('admits an ignored root file as local state', () => {
    expect(findLayoutViolations(facts({
      files: ['.env'],
      ignored: new Set(['tmp', '.env']),
    }))).toEqual([])
  })

  it('rejects a scratch root Git does not ignore', () => {
    expect(findLayoutViolations(facts({ scratchIgnored: false }))).toEqual([scratchMessage])
  })

  it('rejects tracked generated output', () => {
    expect(findLayoutViolations(facts({ trackedIgnored: ['packages/core/probe/lib/index.js'] }))).toEqual([
      'packages/core/probe/lib/index.js: a tracked file matches an ignore rule — generated or scratch output must not be committed (run pnpm run clean; only recorded fixtures under snapshots/ are exempt)',
    ])
  })

  it('exempts recorded fixtures that reproduce ignored paths', () => {
    expect(findLayoutViolations(facts({
      trackedIgnored: ['snapshots/session/worktree/workspace.expected/app.local'],
    }))).toEqual([])
  })

  it('rejects an empty tracked corpus', () => {
    expect(findLayoutViolations(facts({ tracked: [] }))).toEqual([
      'repository: Git reports no tracked files; an empty corpus is not a clean layout',
    ])
  })
})

describe('reading layout facts', () => {
  // Git subprocesses dominate these cases; keep the detection boundary tests real
  // without racing the default per-test budget.
  const timeout = 30_000

  it('reports tracked paths, ignored probes, and the scratch root', () => {
    const actual = readLayoutFacts(fixture())
    expect(actual.tracked).toContain('packages/core/probe/package.json')
    expect(actual.directories).toEqual(['.git', 'docs', 'packages'])
    expect(actual.files).toEqual(['.gitignore', 'AGENTS.md'])
    expect(actual.ignored.has('tmp')).toBe(true)
    expect(actual.ignored.has('.git')).toBe(false)
    expect(findLayoutViolations(actual)).toEqual([])
  }, timeout)

  it('reads an absent scratch root as ignored', () => {
    expect(readLayoutFacts(fixture()).scratchIgnored).toBe(true)
  }, timeout)

  it('reports residue outside the scratch root', () => {
    const root = fixture()
    write(root, 'tools/notes.md')
    write(root, 'scratch.sql')
    expect(findLayoutViolations(readLayoutFacts(root))).toEqual([
      'tools/: a new top-level directory is not part of the layout — put code in packages/<group>/<pkg>/ and temporary files in tmp/',
      'scratch.sql: untracked file at the repository root — temporary or draft files belong in tmp/',
    ])
  }, timeout)

  it('reports a scratch directory Git does not ignore', () => {
    const root = fixture()
    write(root, '.gitignore', 'node_modules/\n')
    git(root, ['add', '--all'])
    expect(findLayoutViolations(readLayoutFacts(root))).toEqual([scratchMessage])
  }, timeout)

  it('reports tracked generated output while exempting a recorded fixture', () => {
    const root = fixture()
    write(root, 'packages/core/probe/lib/index.js')
    git(root, ['add', '--all', '--force'])
    expect(findLayoutViolations(readLayoutFacts(root))).toHaveLength(1)
    write(root, 'snapshots/web/case/workspace.expected/lib/index.js')
    git(root, ['add', '--all', '--force'])
    expect(findLayoutViolations(readLayoutFacts(root))).toHaveLength(1)
  }, timeout)
})

describe('the repository itself', () => {
  it('satisfies every layout rule', () => {
    expect(findLayoutViolations(readLayoutFacts(repositoryRoot))).toEqual([])
  }, 30_000)
})
