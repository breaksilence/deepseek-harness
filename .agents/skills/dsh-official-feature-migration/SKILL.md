---
name: dsh-official-feature-migration
description: Use when bringing official DeepSeek Harness work into this extended fork — an upstream sync or merge-forward, a cherry-pick, or a "port feature X from official" request — to decide whether the capability is worth migrating, whether official already provides it, what this fork's extension adds, and how to redesign on our own seams instead of copying upstream code.
---

# Migrating official capabilities into the extended fork

The unit of migration is a capability this fork's users, models, or operators can observe, not an upstream diff. A port that adds a second implementation of an already-served capability is a regression: it costs every future sync and leaves two owners for one behavior. Moving the capability is the outcome; rewriting, fusing, or adopting upstream unchanged are equally acceptable routes to it.

## Decide before porting

Answer these in order and record the answers in the change. A migration whose answers stall at the first two entries is not worth starting.

1. What capability is missing, and who observes the gap: a product surface, a model-facing tool, an operator contract, or a persistence guarantee?
2. Does this fork already provide it by another design? Search our packages for the seam and the behavior, not for upstream's names.
3. Does the upstream base this fork tracks already contain it? A merge-forward may deliver it with no port at all; check the synced revision before writing code.
4. What does the fork lose by not taking it, and what does keeping our own version cost at each future sync?
5. Which extension goal does it serve? A capability taken only because upstream has it earns no place here.

Write a rejection as a decision too: state the gap that stays open and the sync cost that will follow.

## Specify the capability, not the diff

Name the capability seam — Service Definition, Service Provider, and Consumer — the observable behavior for each audience, and the acceptance evidence. Upstream file paths, commits, and patches are references for understanding the behavior; they never define the specification. When upstream's implementation and this fork's seams disagree about configuration, events, persistence, or UI presentation, the capability description decides, not the upstream code.

## When official already supports it

Compare semantics, not code, then choose one route and delete the alternative:

- **Adopt and re-express our delta.** Take official's implementation and re-add this fork's additions on documented extension points.
- **Keep ours and take official's semantics.** Adopt upstream's behavior, tests, and documentation while keeping the implementation our seams already have.
- **Fuse.** Redesign both into one implementation that serves the combined semantics.

Two implementations of one capability, one behind a flag "for now", is the failure this standard exists to prevent. A divergence kept after this decision must name the fork requirement that justifies its sync cost.

## When the port conflicts with our design

Redesign the implementation on our seams instead of transporting upstream's structure: move behavior onto documented extension points, express variation as validated `Config` fields, keep model-visible inputs reconstructable from the session log, and adapt the upstream caller to our contracts rather than adding a shim around both. Rewriting a small surface is cheaper than maintaining two shapes.

Reject as hard migration: verbatim file or directory copies; wholesale cherry-picks of upstream commits; dual code paths behind flags without an owner and a removal condition; "temporary" compatibility layers; upstream types restated under new names while the original stays; conflict resolution by re-applying a recorded patch instead of re-deriving the change on current seams.

## Land the capability

A migration is complete when the capability works through this fork's seams and the superseded implementation is gone in the same change. That means behavior-level tests (not upstream's implementation tests), a keyless recorded-session snapshot when the behavior is model- or product-visible, updated package README and JSDoc contracts with the owning subsystems page, and an [Agent Note](../../notes/README.md) whenever the decision was not obvious — which route was taken, what was given up, and how it was verified.

Report the assessment beside the change using this shape, and keep it short enough to review:

| Question | Answer |
|---|---|
| Capability and observers | seam, behavior, audience |
| Fork status before | missing / partial (name the divergence) / already present |
| Upstream status | absent, or the revision and behavior that provides it |
| Route | adopt + re-express / keep ours / fuse / not migrating |
| Old implementation | deleted here, or the requirement that keeps it |
| Verification | tests, snapshot, and docs updated |

The root [AGENTS.md](../../../AGENTS.md) owns the standing order this standard serves; [docs/architecture.md](../../../docs/architecture.md) owns the extension points and seams it redistributes behavior onto.
