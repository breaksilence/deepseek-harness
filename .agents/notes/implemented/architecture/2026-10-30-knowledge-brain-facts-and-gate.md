# Agent Note: Facts as documents behind a promotion gate

Status: implemented

English | [中文](2026-10-30-knowledge-brain-facts-and-gate.zh.md)

## Problem

A coding agent re-learns the same project constraints in every session. Holding those constraints in context is unaffordable and holding them in a vector index is unauditable: nothing in the pipeline says why a claim is trustworthy, when it expires, or who decided it applies. A feature that quietly injects such claims also breaks the rule that everything model-visible is reconstructable from the session log.

## Decision

Knowledge is a directory of fact documents, and delivery is three tools a model may call. Nothing is injected, so a turn that never asks keeps its request unchanged and no session event is needed.

A fact is JSON front matter with a conclusion, a scope, evidence carrying a verbatim quote, exceptions, confidence, TTL, trust, and authored `conflictsWith`. Loading validates every field and fails loudly rather than shrinking the corpus silently.

Admission is a gate over recorded turns, not an opinion. `scripts/promote-facts.ts` promotes a fact only when support, precision, marginal coverage, and scope saturation pass, and keeps only what survives a second replay set. Matching requires a structural hit on a specific scope and, at delivery, at least two shared topic tokens; a broad single-segment directory never counts as support.

The corpus is therefore built in four separated steps: distillation proposes, a reviewer confirms or rejects, the gate admits, and a bundle mounts what was admitted. Each step is a script with its own tests, so an error in one cannot silently reach a profile.

Delivery is staged: an index line for the file scope, an optional trust report, and the body last. Measured on a frozen corpus, a scan plus a trust report costs about a hundred tokens and a turn that asks nothing costs zero.

## Alternatives considered

**Inject relevant facts into every request.** Measured as the only cache-safe form at the tail, and appending the index there does change plans, but it needs a session event for the model-visible-logged rule and the value is unproven for turns where nothing asks. Deferred, not rejected.

**Index facts in a vector store.** Unauditable provenance and no natural place for evidence, exceptions, or expiry; synonym matching was measured as unnecessary once scope matching exists.

**Merge conflicting facts automatically.** Two facts that disagree are the signal; a merger would erase it.

## Consequences

Retrieval is honest about its limits: with the correct path and a faithful question, 93.9% of a frozen 33-fact corpus returns the asked fact, and a turn with no path context abstains for every fact. A stricter topic rule trades recall for precision (97.0% to 93.9%) and cuts wrong deliveries under an unrelated file from nine to three.

Coverage redundancy is a property of the gate, not of a fact: two facts on one file serve the same turns, so only one is admitted, while retrieval still returns both. The baseline records that split as separate numbers so a future loss is attributed to the right cause.

Distillation over raw session text is the weak link: a reasoning model spends the output budget before it writes its answer, so a small budget yields unparsable replies. Raising the budget from 1200 to 3200 tokens took the measured yield over eight recorded turns from 0.25 to 1.0 candidates per turn, and the run report now carries the token cost of a pass.

A distillation pass states its own cost rather than leaving it implied. Over eight recorded turns, one candidate per turn cost about 1,190 completion tokens at a per-turn cap of one, 1,615 at the default cap of two, and 1,460 at three, so the cap is a rate-versus-coverage choice a caller makes with numbers in hand instead of a default nobody measured.

The measurement method outranks the numbers. A keyword judge read "do not sum on the client" as summing on the client, and a judge that quoted its evidence could not tell a restated rule from an adopted one. Conclusions that depend on a judge are therefore reported with that judge's accuracy, and value claims rest on mechanical measures or hand labels.
