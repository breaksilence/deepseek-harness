/**
 * Token extraction shared by the query builder and the scorer.
 *
 * Latin words of four or more characters and CJK character bigrams are both emitted, so a Chinese
 * topic can agree with a Chinese conclusion. One side alone would make the topic-agreement rule
 * either inert (ASCII-only topics) or destructive (CJK tokens that nothing else can match).
 */

const LATIN = /[a-z][a-z0-9_$-]{3,}/g
const CJK_RUN = /[\u4e00-\u9fff]{2,}/g

/**
 * Extract comparison tokens from text.
 * @param text - Free text such as a topic, a conclusion, or an evidence quote.
 * @returns Distinct lower-case latin words and CJK bigrams, in first-seen order.
 */
export function tokenize(text: string): readonly string[] {
  const tokens: string[] = []
  for (const word of text.toLowerCase().match(LATIN) ?? []) tokens.push(word)
  for (const run of text.match(CJK_RUN) ?? []) {
    for (let index = 0; index + 1 < run.length; index += 1) tokens.push(run.slice(index, index + 2))
  }
  return [...new Set(tokens)]
}
