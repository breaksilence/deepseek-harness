/**
 * Load fact documents from a directory tree.
 *
 * Reading is confined to one directory; every `.md` file is parsed and validated so a broken
 * fact fails loudly at load time instead of silently shrinking the corpus.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type Fact, parseFactDocument } from './facts.ts'

/** Directory name reserved for facts a reviewer rejected; its documents never join the corpus. */
const REJECTED_DIRECTORY = 'rejected'

async function collect(dir: string, acc: string[]): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === REJECTED_DIRECTORY) continue
      await collect(path, acc)
    } else if (entry.name.endsWith('.md')) acc.push(path)
  }
  return acc
}

/**
 * Load every fact under a directory.
 * @param dir - Directory that holds fact documents.
 * @returns Validated facts sorted by id.
 */
export async function loadFacts(dir: string): Promise<readonly Fact[]> {
  const paths = await collect(dir, [])
  const facts: Fact[] = []
  for (const path of paths) {
    const text = await readFile(path, 'utf8')
    const fact = parseFactDocument(text, path)
    if (fact !== undefined) facts.push(fact)
  }
  facts.sort((left, right) => left.id.localeCompare(right.id))
  return facts
}
