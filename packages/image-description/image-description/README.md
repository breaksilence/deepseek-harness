---
description: "Image-description capability seam: reads one stored image through the session's own route or the configured vision route, with a typed refusal naming what is missing."
kind: "package-reference"
---

# @deepseek-ai/dsh-image-description

English | [中文](README.zh.md)

## Summary

Use `dsh-image-description` when a session may need to read an image its own model cannot accept. The seam owns one question and one answer: which route reads this image. It asks the session's current route first, uses it when that route declares image input; otherwise it uses the deployment's configured vision route; otherwise it refuses with a message that names which of the two is missing. The auxiliary model call, its output bound, and the default instruction belong to this package; the description is returned to the caller, never written into the conversation.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin on the host plane and let a consumer (for example `@deepseek-ai/dsh-tool-image-description`) call `ctx.imageDescription.describe(...)`.

```yaml
- id: image-description
  name: '@deepseek-ai/dsh-image-description'
  config:
    visionProvider: deepseek-official
    visionModel: deepseek-v4-flash-vision-exp
```

- `visionProvider` / `visionModel` state the fallback route together; omitting both leaves the seam able to serve only sessions whose own model reads images.
- `maxOutputTokens` bounds one description (default `1024`).
- `prompt` replaces the default instruction sent with every image.
- A settings owner may call `configureVisionModel(selection)` at runtime so a user choice applies without remounting the composition.

<a id="understand-the-implementation"></a>
## Understand the implementation

The plugin is a service: it registers `ctx.imageDescription` and resolves the fallback route from its own config at load. `describe` resolves the route, builds one user message carrying the image block and the instruction, calls `ctx.llm.prepareCall(...)` for that route, and assembles the streamed text. An unresolvable route counts as not image-capable, so the fallback or the refusal owns the outcome instead of a resolution error escaping.

### Source map

- `src/index.ts` — service definition, route resolution policy, auxiliary call, typed refusal.

<a id="further-exploration"></a>
## Further Exploration

- [`packages/image-description/tool-image-description`](../tool-image-description/README.md) — the model-facing consumer.
- [`packages/attachment/attachment`](../../attachment/attachment/README.md) — the store holding the image being read.
- [`packages/llm/llm`](../../llm/llm/README.md) — the model-call seam the description runs on.

<a id="model-experience"></a>
## Model Experience

The seam adds no model-facing text of its own; the description reaches the conversation only through a consumer's tool result.

### Auxiliary vision request

#### What the model sees

One user message carrying the image block and the instruction, delivered only to the vision route. The conversation's own route never sees it.

#### Token effect

One auxiliary request per described image, bounded by `maxOutputTokens`; nothing is appended to the session surface.

#### KV Cache effect

The auxiliary request carries no conversation prefix, so it neither reads nor invalidates the cache.
<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- The fallback route is a deployment `Config`, not a settings namespace; a settings owner applies it by calling `configureVisionModel`.
- Every description is a fresh model call: no caching, so the same image described twice costs twice.
- Images are read from the attachment store; local files outside the store are not a source for this seam.

### Dev Note

The consumer owns presentation: the seam and the tool return text, and nothing is appended to the session surface.
