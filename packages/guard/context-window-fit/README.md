---
description: "Context-window fit guard: measures the session history against the capacity its route declares, compacts once, and then annotates or refuses the step instead of letting an oversized route fail the turn."
kind: "package-reference"
---

# @deepseek-ai/dsh-guard-context-window-fit

English | [中文](README.zh.md)

## Summary

Use `dsh-guard-context-window-fit` when a session may outgrow its route — most visibly after switching from a large-window model to a small one, and earlier when an adapter declares a stale window. The guard reads occupancy from the token meter and capacity from the resolved model route; when the history does not fit, it asks the compaction service for one pass and re-measures. A history that still cannot fit is annotated with the shortfall and the ways forward (compact again, switch back to a larger window, start a new session). A route that declares no capacity is never judged, because guessing a window would invent failures.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount it on the host plane beside the token meter and a compaction backend:

```yaml
- id: context-window-fit
  name: '@deepseek-ai/dsh-guard-context-window-fit'
  config:
    reserveTokens: 8192
    strict: false
```

- `reserveTokens` — headroom kept free below the declared capacity, so the answer itself still fits (default `8192`).
- `strict` — refuse the step (`reject`) instead of annotating it when compaction did not bring the history under the window (default `false`, annotate).
- `assumedContextWindow` — capacity to assume for a route that declares none; off by default, and an annotation produced from it says so explicitly.

<a id="understand-the-implementation"></a>
## Understand the implementation

The guard listens on `agent/pre-step` with `prepend: true`, so it observes the decision every other listener built. It resolves the route from the session request header (falling back to the agent's options), reads `context.contextWindow` from the resolved model info, and measures occupancy with `ctx.tokenMeter.measure(...).totalTokens`. When the pair does not fit, it calls the optional `compaction` service once with the `context-overflow` trigger and re-measures. The annotation is appended as a durable logged user message (source.kind is context-window-fit) rather than a transient step input, so the model sees it, replay reconstructs it, and a session UI shows it; a recent-event scan keeps a turn to one notice.

### Source map

- `src/index.ts` — the pure verdict helper, the annotation text, and the pre-step wiring.

<a id="further-exploration"></a>
## Further Exploration

- [`packages/llm/token-meter`](../../llm/token-meter/README.md) — the occupancy measurement this guard reads.
- [`packages/compaction/compaction`](../../compaction/compaction/README.md) — the compaction service it asks once.
- [`packages/llm/llm`](../../llm/llm/README.md) — the route resolution that carries `context.contextWindow`.

<a id="model-experience"></a>
## Model Experience

Indirectly, through one user message appended to an oversized step: it names the measured history, the route capacity, and three ways forward (compact again, switch back to a larger window, start a new session).

#### KV Cache effect

The annotation enters the conversation prefix, so it invalidates the cache from that point on — once per turn, and only for turns that already could not fit the route.
## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The guard judges only routes that declare a capacity; an adapter with no `context.contextWindow` keeps today's behavior, including a provider error on overflow.
- Compaction is requested once per step and only when the service is mounted; with no compaction backend the guard annotates or refuses immediately.
- The annotation is a logged user message, so it stays in the history and replay shows it in place; it does not change the token accounting of the compacted range.

### Dev Note

The verdict is a pure function of two published numbers, so it is unit-tested without an agent loop; the pre-step wiring stays thin on purpose.
