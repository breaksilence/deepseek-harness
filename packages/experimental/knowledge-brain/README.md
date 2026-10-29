---
description: "On-demand project knowledge tools: scan, doubt, and recall over validated fact documents."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-knowledge-brain

English | [中文](README.zh.md)

## Summary

Give a model three ways to consult distilled project knowledge without loading it into context: `knowledge_scan` reports whether anything is known, `knowledge_doubt` reports how far one item can be trusted, and `knowledge_recall` returns one item in full. Nothing is delivered automatically, so a turn that never calls a tool keeps its request unchanged.

## Table of Contents

- [Use this package](#use-this-package)
- [Produce and promote a corpus](#produce-and-promote-a-corpus)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this function plugin after the tool registry and point `factsDir` at a directory of fact documents. The corpus never defaults to the repository, so an empty configuration yields an empty knowledge set rather than unexpected delivery.

```yaml
- name: '@deepseek-ai/dsh-experimental-knowledge-brain'
  config:
    factsDir: .agents/facts
    floor: 5
    maxScan: 2
    minTopicTokens: 2
```

A fact document carries JSON front matter between `---` fences and a Markdown body that is never delivered:

```markdown
---
{"id":"kb-0001","conclusion":"生成文件禁止手改，须用生成器重新生成。","appliesTo":{"dirs":["scripts/"],"paths":["scripts/gen-tool-catalog.ts"]},"evidence":{"source":"notes/toolchain","quote":"生成物由生成器重写"},"exceptions":"首次创建生成器本身时除外","confidence":0.9,"ttlDays":90,"updatedAt":1793000000000,"trust":"verified"}
---

Free-form elaboration.
```

`trust: background` items may be recalled but are always marked as unverified in this repository. Items past their TTL are marked stale rather than hidden.

-----

<a id="produce-and-promote-a-corpus"></a>
## Produce and promote a corpus

Facts come from observed work, not from imagination. The loop is: capture a turn or a note, distil it into the four fields below, then let the promotion gate decide whether it may be delivered.

1. **Distil.** One fact states one executable conclusion, its trigger scope, an evidence pointer with a verbatim quote, and the conditions under which it does not hold.
2. **Scope it narrowly.** A broad scope such as `packages/` matches nearly every turn and hijacks delivery. A multi-segment directory, a package, or a concrete file counts as support; a single-segment directory does not.
3. **Promote.** Run the replay gate over historical turns:

```sh
node --import tsx/esm scripts/promote-facts.ts \
  --facts <facts-dir> --replay <replay.jsonl> --gold <gold.json> \
  --min-support 5 --min-precision 0.55 --out promotion.json
```

The gate promotes a fact only when support, precision, and **marginal coverage** all pass. Without `--gold` every candidate is reported blocked, because matching is not evidence of need.

4. **Review.** Facts live in version control, so review is a pull request: a fact that loses its evidence or its scope must not merge.

The protocol has two reference clients: this plugin (model-initiated tool calls) and `scripts/knowledge-client.ts`, which stages the same delivery for any other runtime and prints the span record a client must persist. `scripts/verify-knowledge-brain.ts` runs the promotion gate, one delivery end to end, and (with `--questions`) question-to-fact accuracy: one generated question per promoted fact, asked with that fact's own scope path, must return the same fact. Passing `--paraphrased` with a second question set measures the same thing after the questions were reworded, which is the cost side of the topic-agreement rule. `--min-question` (default 0.8) and `--min-paraphrase` (default 0.85) set the failure thresholds, so a corpus records its own baseline rather than inheriting the fixture’s. The frozen 33-fact corpus and both question sets live under `tests/fixtures/`. Two bases are reported: retrieval over all 33 facts (93.9%), and retrieval over the 22 facts that survive a one-turn-per-scope replay (90.9%); the second is the end-to-end pipeline, the first is the retrieval ceiling. The baseline records both as `retrievalAccuracy` and `pipelineAccuracy`, so a loss in either is visible separately. The gap between them is coverage redundancy, not uselessness: the gate matches by scope prefix, so two facts on one file serve the same turns and the second adds no coverage, while retrieval still returns both because delivery also requires topic agreement.

Two commands reproduce the two bases:

```sh
# retrieval ceiling: all 33 facts, no promotion filter
pnpm exec vitest run packages/experimental/knowledge-brain/tests/question-accuracy.spec.ts

# end-to-end: promotion gate, delivery, then both question sets
pnpm exec tsx scripts/verify-knowledge-brain.ts \
  --facts packages/experimental/knowledge-brain/tests/fixtures/corpus33 \
  --replay packages/experimental/knowledge-brain/tests/fixtures/replay33.jsonl \
  --gold packages/experimental/knowledge-brain/tests/fixtures/gold33.json \
  --questions packages/experimental/knowledge-brain/tests/fixtures/questions33.json \
  --paraphrased packages/experimental/knowledge-brain/tests/fixtures/questions33-paraphrased.json
```


Measured operating points on two real replay sets (843 turns and 198 unseen turns). Labels come from the distillation corpus, so admission policy changes only which facts exist:

| Policy | `floor` | need recall | delivery precision | correct silence |
|---|---|---|---|---|
| default (support ≥5, precision ≥0.55) | 5 | 66.7% / 70.3% | 76.3% / 78.1% | 62.0% / 53.8% |
| **quality (support ≥2, precision ≥0.80)** | 5 | 64.8% / 72.7% | **91.9% / 96.2%** | **94.6% / 88.5%** |
| quality | 7 | 55.5% / 59.3% | 98.3% / 100% | 100% / 100% |

Recall is bounded by corpus coverage, not by the floor, and error attribution on the quality corpus found 22 coverage misses against 3 ranking misses: raising `floor` buys silence and costs recall monotonically.

A 17-turn hand check of delivered items measured precision at 23.5% strict (52.9% counting a same-subsystem delivery as useful) against 76.5% for the path proxy, so every precision figure here is a labelled upper bound, not ground truth. Admission has two documented policies: the default requires support ≥5 and precision ≥0.55; a rare-but-precise policy (`--min-support 2 --min-precision 0.80`) admitted four more facts on the same replay sets and raised precision from 76.8%/77.1% to 94.3%/95.7% and correct silence from 65.1%/61.5% to 95.3%/88.5% at equal recall (58.8%/62.8%).

### Review loop

Distillation proposes; a reviewer decides; the gate admits. Each step is a separate command so a mistake in one cannot leak into the corpus:

```sh
pnpm run distill-facts -- --turns turns.jsonl --out candidates
pnpm exec tsx scripts/confirm-facts.ts --facts candidates --confirm candidate-1,candidate-2
pnpm exec tsx scripts/confirm-facts.ts --facts candidates --reject candidate-3 --reason "already covered"
pnpm run distill-facts -- --turns turns.jsonl --out candidates --skip-rejected candidates/rejected.jsonl
pnpm exec tsx scripts/draft-conflicts.ts --facts candidates --out conflict-report.md
```

In that sequence distillation proposes, a reviewer confirms or rejects, later distillation skips what was rejected, and conflict drafting stays a proposal. Distillation drops a proposal that restates an accepted one within the same reply, and a proposal that restates a rejected claim. Both checks compare vocabulary, so a short pointer to a longer claim ("the rule above is in the checklist") is not merged; the promotion gate then rejects it as coverage-redundant, which keeps the corpus clean at the cost of one extra candidate reaching review. `rejected/` is a reserved directory name: the loader skips it, so a rejected claim cannot re-enter the corpus even if its document is left in the tree. Confirmation only changes `trust` and `updatedAt`; the claim and its evidence are never rewritten.

### Drift gate

`distill-facts --report <path>` writes the run statistics a reviewer has to keep up with: candidates per turn, the share of proposals dropped, and why. `pnpm run verify-knowledge-baseline -- --distill-report <path>` records those two rates alongside the corpus measurements; without a report they stay null, so the committed baseline never depends on a model call.

`pnpm run verify-knowledge-baseline` re-measures the frozen corpus and compares against `tests/fixtures/baseline.json`: fact and promoted counts may not shrink at all, and rates may drift down by the recorded tolerance (0.05) only. A regression prints which number fell from what to what instead of relying on someone remembering the old value.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`src/facts.ts`](src/facts.ts) validates every field and fails loudly, so a broken document cannot silently shrink the corpus. [`src/load.ts`](src/load.ts) reads one directory tree and sorts by id. [`src/rank.ts`](src/rank.ts) admits a fact only when the query names one of its packages, directories, paths, symbols, or commands; text overlap is only a tiebreaker. [`src/render.ts`](src/render.ts) renders all three payloads as pure functions of facts and a clock, so a delivered payload is reconstructable from the session log. [`src/index.ts`](src/index.ts) registers the three tools and loads the corpus lazily on first use.

Facts come from a `BrainStore`: the directory backend reads fact documents, and the memory backend serves an array, so a caller can mount the same tools over another backend without touching the tool layer. The plugin registers no session event and no automatic injection; delivery exists only as ordinary tool calls and results.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Context and compaction design notes](../../../docs/architecture.md)
- [Adding a tool](../../../docs/cookbook/adding-a-tool.md)

-----

<a id="model-experience"></a>
## Model Experience

### Knowledge tools

#### What the model sees

The generated tool catalog owns the exact schemas and descriptions of `knowledge_scan`, `knowledge_doubt`, and `knowledge_recall`. A scan returns one line per candidate item; doubt returns evidence, exceptions, trust level, staleness, and conflicts; recall returns conclusion, applicability, evidence quote, and mandatory markers.

#### Token effect

Three fixed tool schemas cost a constant per-request amount while mounted. A scan is bounded by `maxScan` lines; recall is bounded by one item. No knowledge text enters a request unless the model calls a tool.

#### KV Cache effect

Unchanged tool schemas retain their existing prefix. A scan or recall appends its arguments and bounded result to ordinary tool history; no earlier request content is rewritten.

## Known Limitations and Deferred Work

Measured rejections, recorded so the same ideas are not re-proposed without new evidence:

| Idea | Measurement |
|---|---|
| Weight edited paths above merely read paths | 0.670 vs 0.669 recall; reverted |
| Show one candidate, or abstain, when scores are close | correct answers 5 → 3 → 0 across 3 / 1 / 0 candidates |
| Print an "ambiguous candidates" warning line | correct 1 → 0 and wrong 3 → 4; removed |
| Expand the pool without the promotion gate | 92.0% recall with hand-picked facts vs 97.0% through the gate |
- **Topic agreement requires two shared tokens.** When a caller supplies a topic, the fact must share at least two tokens (latin words or CJK bigrams) with it, or all of them when fewer were supplied. One shared word was too common to discriminate: with one required token an unrelated file still produced 9 wrong winners out of 33; two required tokens cut that to 3 for a 3-point recall loss (97.0% → 93.9%). Bigram overlap remains coarse, so this filters gross mistakes rather than proving relevance. Configuring `minTopicTokens: 1` restores 97.0% recall but returns to 9 of 33 wrong winners under an unrelated file; the default of 2 measured 93.9% recall and 3 of 33.
- **A question without path context matches nothing.** Admission requires a scope, symbol, or command match, so a pure natural-language question yields an abstention even when the corpus contains the answer. Callers must pass the paths or identifiers they are working with; matching on question wording alone was measured to double deliveries while halving precision.

<a id="known-limitations-and-deferred-work"></a>

- **No automatic delivery** — knowledge is never injected; a turn that does not call a tool sees nothing.
- **Lexical and scope matching only** — synonyms and paraphrases that name no scope are not matched; embeddings are deliberately absent.
- **Conflicts are authored, never inferred.** A fact declares `conflictsWith`; sharing a scope or opposite wording is not treated as evidence of contradiction, because a sampled review of inferred pairs found zero true contradictions. Authoring the link is a review responsibility.
- **Corpus freshness is caller-owned** — `updatedAt` must be maintained when an item is reviewed; the plugin only reports staleness.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The default-off policy is deliberate: measured delivery precision without a relevance floor was 22%, so the corpus must be promoted through a replay gate before it is mounted in a shipped profile.

</details>
