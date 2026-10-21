/**
 * Reject repository-layout drift and scratch residue: a scratch root Git does not
 * ignore, a top-level directory outside the declared layout, an untracked file at
 * the repository root, and a tracked file an ignore rule covers.
 *
 * Run: `tsx scripts/verify-repository-layout.ts`.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')

/** The single scratch root every temporary file belongs in; `.gitignore` must exclude it. */
export const SCRATCH_ROOT = 'tmp'

/**
 * Top-level directories the repository layout declares. A new top-level directory
 * is a layout change reviewed in this set; code otherwise joins
 * `packages/<group>/<pkg>/` and scratch files join {@link SCRATCH_ROOT}.
 */
export const TOP_LEVEL_DIRECTORIES: ReadonlySet<string> = new Set([
  // Git's worktree metadata; never repository content.
  '.git',
  '.agents',
  '.claude',
  '.github',
  'apps',
  'benchmarks',
  'docs',
  'native',
  'packages',
  'patches',
  'python',
  'scripts',
  'snapshots',
  'vendor',
  'website',
])

/**
 * Recorded workspace fixtures reproduce ignored paths on purpose, so the tracked
 * output rule exempts their tree.
 */
const FIXTURE_PREFIX = 'snapshots/'

/**
 * Git's own metadata entry. A normal checkout holds a directory, while a linked
 * worktree holds a file pointing at the common Git directory; neither is content.
 */
const GIT_METADATA = '.git'

/** Working-tree and Git-index state the layout rules read. */
export interface LayoutFacts {
  /** Top-level directory names present in the working tree. */
  directories: readonly string[]
  /** Top-level non-directory entries (files and symlinks) present in the working tree. */
  files: readonly string[]
  /** Names among the top-level entries that Git ignores; directory names carry no slash. */
  ignored: ReadonlySet<string>
  /** Every path Git tracks, repository-relative with `/` separators. */
  tracked: readonly string[]
  /** Tracked paths an ignore rule also matches. */
  trackedIgnored: readonly string[]
  /** Whether Git ignores the scratch root. */
  scratchIgnored: boolean
}

/**
 * List the layout violations of one repository state.
 * @param facts - tracked, ignored, and present top-level state.
 * @returns one actionable message per violation, empty when the layout is clean.
 */
export function findLayoutViolations(facts: LayoutFacts): string[] {
  const errors: string[] = []
  if (facts.tracked.length === 0) {
    errors.push('repository: Git reports no tracked files; an empty corpus is not a clean layout')
  }
  if (!facts.scratchIgnored) {
    errors.push(`${SCRATCH_ROOT}/: the scratch root must be git-ignored so temporary files cannot be committed (add "${SCRATCH_ROOT}/" to .gitignore)`)
  }
  for (const directory of facts.directories) {
    if (facts.ignored.has(directory) || TOP_LEVEL_DIRECTORIES.has(directory)) continue
    errors.push(`${directory}/: a new top-level directory is not part of the layout — put code in packages/<group>/<pkg>/ and temporary files in ${SCRATCH_ROOT}/`)
  }
  const tracked = new Set(facts.tracked)
  for (const file of facts.files) {
    if (file === GIT_METADATA || facts.ignored.has(file) || tracked.has(file)) continue
    errors.push(`${file}: untracked file at the repository root — temporary or draft files belong in ${SCRATCH_ROOT}/`)
  }
  for (const path of facts.trackedIgnored) {
    if (path.startsWith(FIXTURE_PREFIX)) continue
    errors.push(`${path}: a tracked file matches an ignore rule — generated or scratch output must not be committed (run pnpm run clean; only recorded fixtures under ${FIXTURE_PREFIX} are exempt)`)
  }
  return errors
}

/**
 * Read the layout facts of one repository.
 * @param repositoryRoot - absolute root of a Git work tree to inspect.
 * @returns the top-level entries, their ignore state, and every tracked path.
 */
export function readLayoutFacts(repositoryRoot: string): LayoutFacts {
  const tracked = splitRecords(git(repositoryRoot, ['ls-files', '-z']))
  const trackedIgnored = splitRecords(git(repositoryRoot, ['ls-files', '-ci', '--exclude-standard', '-z']))
  const entries = readdirSync(repositoryRoot, { withFileTypes: true })
  const directories = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  const files = entries.filter(entry => !entry.isDirectory()).map(entry => entry.name).sort()
  // Directory probes carry a trailing slash so directory-only patterns match, and
  // the scratch probe stays present whether or not the directory exists yet.
  const ignored = new Set(ignoredProbes(repositoryRoot, [
    `${SCRATCH_ROOT}/`,
    ...directories.map(name => `${name}/`),
    ...files,
  ]))
  return {
    directories,
    files,
    ignored,
    tracked,
    trackedIgnored,
    scratchIgnored: ignored.has(SCRATCH_ROOT),
  }
}

function git(repositoryRoot: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', repositoryRoot, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 })
}

/** Split a NUL-delimited Git path stream, dropping the trailing empty record. */
function splitRecords(output: string): string[] {
  return output.split('\0').filter(record => record !== '')
}

/**
 * Report which probes an ignore rule matches.
 * @param repositoryRoot - Git work tree the probes are relative to.
 * @param probes - repository-relative paths; a directory ends with `/`.
 * @returns the matching probes without the trailing slash, empty when none match.
 */
function ignoredProbes(repositoryRoot: string, probes: readonly string[]): string[] {
  const result = spawnSync('git', ['-C', repositoryRoot, 'check-ignore', '-z', '--stdin'], {
    input: `${probes.join('\0')}\0`,
    encoding: 'utf8',
  })
  if (result.error !== undefined) throw result.error
  // Exit code 1 is Git's "no probe matched", not a failure.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git check-ignore failed with ${String(result.status)}: ${result.stderr}`)
  }
  return splitRecords(result.stdout).map(path => path.replace(/\/+$/, ''))
}

/** Run the repository layout gate. */
export function main(): void {
  const violations = findLayoutViolations(readLayoutFacts(root))
  if (violations.length === 0) {
    console.log('verify-repository-layout: top-level layout, scratch root, and tracked output are clean.')
    return
  }
  console.error('verify-repository-layout: repository layout violations found:')
  for (const violation of violations) console.error(`  ${violation}`)
  process.exitCode = 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
