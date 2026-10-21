---
description: "Model-facing describe_image tool: reads one attached image as text through the image-description seam, so a text-only route can still learn what an image contains."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-image-description

English | [中文](README.zh.md)

## Summary

Use `dsh-tool-image-description` to give a text-only model a way to read an attached image. When a route cannot accept images, the llm content projection replaces each occurrence with a deterministic placeholder carrying `attachment sha256:<prefix>`; this tool takes that handle, resolves the exact stored object, and asks the `imageDescription` seam for text. The tool owns argument checking and the model-facing result. Route choice, fallback, and the refusal wording belong to the seam.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount it beside `@deepseek-ai/dsh-image-description` and any attachment store:

```yaml
- id: tool-image-description
  name: '@deepseek-ai/dsh-tool-image-description'
```

The model calls `describe_image({ attachment, prompt? })`:

- `attachment` — the handle from an image placeholder: the full `sha256:` digest or its leading hex prefix (at least eight digits). A prefix matching more than one object fails with the candidates named.
- `prompt` — what to extract from the image; omitted uses the seam's default instruction.

<a id="understand-the-implementation"></a>
## Understand the implementation

The plugin registers one tool in the mounting scope. On a call it resolves the attachment through `ctx.attachments.resolveImageByContentAddress`, reads the session's current route from the request header, and delegates to `ctx.imageDescription.describe`. The returned description is presented verbatim with the route that produced it; the tool stores nothing and appends no session event.

### Source map

- `src/index.ts` — tool definition, argument schema, attachment resolution, delegation, presented result.

<a id="further-exploration"></a>
## Further Exploration

- [`packages/image-description/image-description`](../image-description/README.md) — the seam this tool consumes.
- [`packages/attachment/attachment`](../../attachment/attachment/README.md) — the store and its content-addressed lookup.
- [`packages/fs/tool-fs`](../../fs/tool-fs/README.md) — `read_image`, the strict tool for routes that do accept images.

<a id="model-experience"></a>
## Model Experience

None, as the tool presents one text result and the tool definition already owns its schema and description.

#### KV Cache effect

The tool adds no system-prompt section and no history prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only the attachment store is a source; a bare local path is not accepted. `read_image` remains the tool for images already reachable on the filesystem.
- Each call is one auxiliary vision request; the tool does not cache descriptions.
- The tool does not switch the session's model, so a text-only session keeps its route and receives text.

### Dev Note

The consumer owns presentation: the seam and the tool return text, and nothing is appended to the session surface.
