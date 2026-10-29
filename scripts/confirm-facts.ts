/**
 * Promote distilled candidates to `user-confirmed` after a reviewer read them.
 *
 * Confirmation is a reviewer action, so it only changes the trust level and the update time;
 * the evidence and the claim stay exactly as distilled. Nothing here can admit a fact: the
 * promotion gate still decides what enters the corpus.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Fact } from '../packages/experimental/knowledge-brain/src/facts.ts'
import { loadFacts } from '../packages/experimental/knowledge-brain/src/load.ts'

/** Result of one confirmation run. */
export interface ConfirmResult {
  readonly confirmed: readonly string[]
  readonly alreadyConfirmed: readonly string[]
  readonly unknown: readonly string[]
}

/**
 * Confirm the listed facts.
 * @param facts - loaded facts to consider.
 * @param ids - ids the reviewer approved.
 * @param now - confirmation time recorded in `updatedAt`.
 * @returns which ids changed, which were already confirmed, and which do not exist.
 */
export function confirmFacts(
  facts: readonly Fact[],
  ids: readonly string[],
  now: number,
): { result: ConfirmResult; updated: readonly Fact[] } {
  const byId = new Map(facts.map(fact => [fact.id, fact]))
  const confirmed: string[] = []
  const alreadyConfirmed: string[] = []
  const unknown: string[] = []
  const updated: Fact[] = []

  for (const id of ids) {
    const fact = byId.get(id)
    if (fact === undefined) {
      unknown.push(id)
      continue
    }
    if (fact.trust === 'user-confirmed') {
      alreadyConfirmed.push(id)
      continue
    }
    confirmed.push(id)
    updated.push({ ...fact, trust: 'user-confirmed', updatedAt: now })
  }

  return { result: { confirmed, alreadyConfirmed, unknown }, updated }
}

/**
 * Render a fact back to its document form, preserving the front-matter contract.
 * @param fact - fact to render.
 * @returns the document text.
 */
export function renderFact(fact: Fact): string {
  const { origin: _origin, ...fields } = fact
  return `---\n${JSON.stringify(fields)}\n---\n\n${fact.conclusion}\n`
}

/**
 * Write facts into their directory.
 * @param facts - facts to persist.
 * @param directory - directory holding the documents.
 * @returns the written paths.
 */
export function writeFacts(facts: readonly Fact[], directory: string): string[] {
  return facts.map((fact) => {
    const file = join(directory, `${fact.id}.md`)
    writeFileSync(file, renderFact(fact), 'utf8')
    return file
  })
}

function flag(argv: readonly string[], name: string, fallback: string): string {
  const index = argv.indexOf(name)
  const value = index >= 0 ? argv[index + 1] : undefined
  return value ?? fallback
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const directory = flag(argv, '--facts', '')
  const ids = flag(argv, '--confirm', '').split(',').map(id => id.trim()).filter(id => id.length > 0)
  if (directory.length === 0 || ids.length === 0) {
    process.stderr.write('usage: confirm-facts --facts <dir> --confirm <id[,id...]>\n')
    process.exitCode = 2
    return
  }
  const { result, updated } = confirmFacts(await loadFacts(directory), ids, Date.now())
  writeFacts(updated, directory)
  process.stdout.write(
    `confirm-facts: confirmed ${result.confirmed.length}, already ${result.alreadyConfirmed.length}, unknown ${result.unknown.length}\n`,
  )
  if (result.unknown.length > 0) process.stdout.write(`  unknown: ${result.unknown.join(', ')}\n`)
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) await main()
