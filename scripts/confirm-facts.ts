/**
 * Promote distilled candidates to `user-confirmed` after a reviewer read them.
 *
 * Confirmation is a reviewer action, so it only changes the trust level and the update time;
 * the evidence and the claim stay exactly as distilled. Nothing here can admit a fact: the
 * promotion gate still decides what enters the corpus.
 */

import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Fact } from '../packages/experimental/knowledge-brain/src/facts.ts'
import { loadFacts } from '../packages/experimental/knowledge-brain/src/load.ts'

/** One archived rejection: why a candidate must not be distilled again. */
export interface Rejection {
  readonly id: string
  readonly conclusion: string
  readonly reason: string
  readonly at: number
}

/** Result of one confirmation run. */
export interface ConfirmResult {
  readonly confirmed: readonly string[]
  readonly alreadyConfirmed: readonly string[]
  readonly unknown: readonly string[]
  readonly rejected: readonly string[]
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
  rejectIds: readonly string[] = [],
): { result: ConfirmResult; updated: readonly Fact[]; rejected: readonly Fact[] } {
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

  const rejections: Fact[] = []
  for (const id of rejectIds) {
    const fact = byId.get(id)
    if (fact === undefined) {
      unknown.push(id)
      continue
    }
    rejections.push(fact)
  }

  return { result: { confirmed, alreadyConfirmed, unknown, rejected: rejections.map(fact => fact.id) }, updated, rejected: rejections }
}

/**
 * Archive rejected candidates outside the corpus and record why.
 *
 * A rejected candidate is moved out of the fact directory so the gate never sees it again, and a
 * line is appended to the rejection log so distillation can skip the same claim next time.
 * @param rejections - facts the reviewer rejected.
 * @param directory - fact directory holding the documents.
 * @param reason - reviewer-supplied reason archived with each id.
 * @param now - rejection time.
 * @returns the archived ids and the log path.
 */
export function archiveRejections(
  rejections: readonly Fact[],
  directory: string,
  reason: string,
  now: number,
): { archived: readonly string[]; logPath: string } {
  const archiveDirectory = join(directory, 'rejected')
  const logPath = join(directory, 'rejected.jsonl')
  if (rejections.length === 0) return { archived: [], logPath }
  mkdirSync(archiveDirectory, { recursive: true })
  for (const fact of rejections) {
    const source = join(directory, `${fact.id}.md`)
    renameSync(source, join(archiveDirectory, `${fact.id}.md`))
    const record: Rejection = { id: fact.id, conclusion: fact.conclusion, reason, at: now }
    appendFileSync(logPath, `${JSON.stringify(record)}\n`, 'utf8')
  }
  return { archived: rejections.map(fact => fact.id), logPath }
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
  const rejectIds = flag(argv, '--reject', '').split(',').map(id => id.trim()).filter(id => id.length > 0)
  const reason = flag(argv, '--reason', 'rejected by reviewer')
  if (directory.length === 0 || (ids.length === 0 && rejectIds.length === 0)) {
    process.stderr.write('usage: confirm-facts --facts <dir> [--confirm <ids>] [--reject <ids> --reason <text>]\n')
    process.exitCode = 2
    return
  }
  const now = Date.now()
  const loaded = await loadFacts(directory)
  const { result, updated, rejected } = confirmFacts(loaded, ids, now, rejectIds)
  writeFacts(updated, directory)
  const archive = archiveRejections(rejected, directory, reason, now)
  process.stdout.write(
    `confirm-facts: confirmed ${result.confirmed.length}, already ${result.alreadyConfirmed.length}, rejected ${archive.archived.length}, unknown ${result.unknown.length}\n`,
  )
  if (result.unknown.length > 0) process.stdout.write(`  unknown: ${result.unknown.join(', ')}\n`)
  if (archive.archived.length > 0) process.stdout.write(`  archived: ${archive.logPath}\n`)
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) await main()
