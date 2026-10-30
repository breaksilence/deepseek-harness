# Agent Note: Active delivery of knowledge at the request tail

Status: proposed

English | [中文](2026-10-30-active-knowledge-delivery.zh.md)

## Problem

[Facts behind a promotion gate](../../implemented/architecture/2026-10-30-knowledge-brain-facts-and-gate.md) deliver nothing unless a model calls a tool. A model that does not know a constraint exists cannot ask for it: it will retry a charge without an idempotency key, hardcode an exchange rate, or sum money in the client without ever forming the question those facts answer. On eight recorded tasks the same model produced a plan that carried the constraint in 3 of 10 runs without delivery and 9 or 10 of 10 with the index appended, so the constraint is available but unasked for.

Injecting knowledge everywhere is not an option: it breaks the model-visible-logged rule without a session event, and it rewrites the request prefix on routes without in-history system updates.

## Proposal

Append a delivered knowledge block at the end of the request, after the last message, only when a scan finds a fact whose scope matches the current turn and whose topic agreement passes. Emit a session event carrying the delivered ids and spans before the request is sent, so replay reconstructs exactly what the model saw. Nothing is injected when the scan is empty, and a knob disables the whole path.

The block starts with the index line only. The trust report and the body stay behind the tools, because delivery that costs more than an index line has not been shown to change plans more often.

## Evidence for the shape

- Tail placement is the only cache-safe form measured: appending after the prefix kept 1,536 of 1,743 prompt tokens cached (88.1%), while inserting mid-prompt dropped cached tokens to zero.
- The index line is cheap: a scan plus a trust report measured about a hundred tokens, roughly 0.1% of a working context.
- Delivery changes plans: hand-labeled, the constraint appeared in 30% of plans with no knowledge, 90% with the index, and 100% with index plus body; a second judge-free measure (does the answer carry the fact's distinctive phrase) moved from 12.5% to 87.5%.
- Nothing in that evidence separates index-only from index-plus-body: the difference was one or two tasks out of ten.

## Alternatives considered

**Always deliver the full body for a matching fact.** Largest context cost per turn for a benefit the measurements cannot distinguish from the index alone.

**Deliver into the system prompt.** Rewrites the prefix that routes rely on without in-history system updates, and the cache measurement above shows what that costs.

**Let a skill teach the model to ask.** Cheaper and already possible, but the failure mode here is a model that does not know a constraint exists, so instruction alone does not reach it.

## Acceptance criteria

- A turn whose scan finds no matching fact sends a byte-identical request to the one it sends today.
- A turn whose scan finds a match sends the index line after the last message, and nowhere else in the request.
- The session log carries the delivered ids and spans, and replaying that log reproduces the delivered block exactly; a snapshot test fails when the block changes without a log change.
- Killing the switch restores today's byte-identical requests without touching the corpus.
- On the hand-labeled task set, the delivered index raises the share of plans that carry the constraint above the recorded no-delivery baseline, with the arm order shuffled and both judges (hand labels and the phrase check) reported.
- The trust report and the body remain reachable only through the tools; the delivered block grows by no more than one line per delivered fact.

## Risks

A wrong delivery is worse than none: the block sits in the request whether or not it applies, and a model that reads it will follow it. Scope matching cannot see that a fact was superseded yesterday, so a stale fact delivered at the tail would be obeyed with more confidence than one the model asked for.

The session event is a durable contract. If the delivered block cannot be reconstructed byte for byte from the log, replay and snapshot tests stop meaning what they say, and the fallback is to remove the feature rather than to record an approximation.

Context cost is paid on every triggering turn, while the benefit is measured only on tasks where the constraint matters. If the trigger fires on most turns, the cost is continuous and the benefit is not.

## Open questions before implementation

Which turn predicate triggers delivery: any scan hit, or only a turn that touches a path in the fact's scope without naming its topic. The second is the case the tools cannot serve, and it is also the case where a wrong delivery is least visible.

What the kill line is. If delivered blocks fail to change plans in the hand-labeled protocol above, or if the session event cannot be replayed exactly, the feature is removed rather than tuned.
