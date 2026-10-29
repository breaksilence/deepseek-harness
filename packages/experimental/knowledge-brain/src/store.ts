/**
 * Storage boundary for knowledge facts.
 *
 * A brain is portable when its state lives behind one interface: the directory implementation
 * reads fact documents from disk, and the memory implementation serves an in-process array.
 * Future backends (SQLite, remote) implement the same interface without touching the tools.
 */

import { type Fact } from './facts.ts'
import { loadFacts } from './load.ts'

/** Where a brain reads its facts from. */
export interface BrainStore {
  /**
   * Load every fact.
   * @returns Validated facts, ordered by id.
   */
  list(): Promise<readonly Fact[]>
}

/**
 * Read facts from a directory tree of fact documents.
 * @param dir - Directory that holds fact documents.
 * @returns A store backed by that directory.
 */
export function directoryStore(dir: string): BrainStore {
  return { list: () => loadFacts(dir) }
}

/**
 * Serve facts from an in-memory array.
 * @param facts - Already validated facts.
 * @returns A store backed by that array.
 */
export function memoryStore(facts: readonly Fact[]): BrainStore {
  const ordered = [...facts].sort((left, right) => left.id.localeCompare(right.id))
  return { list: () => Promise.resolve(ordered) }
}
