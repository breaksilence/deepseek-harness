---
description: "The image-description group: an image-to-text capability seam and the model-facing tool that lets a text-only route read attached images."
kind: "package-group"
---

# image-description/

English | [中文](README.zh.md)

## Summary

The image-description group gives a session a way to read an attached image its own model cannot accept. One package owns the capability seam — which route reads the image, what instruction it is given, and what refusal names a missing configuration. The other package owns the model-facing tool that turns the placeholder handle a text-only route receives back into an exact stored object and returns text. Together they let any session send an image, and let the model decide when to spend a description on it.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`image-description/`](image-description/README.md) | Resolves the route that reads one image and runs the auxiliary description call | `ctx.imageDescription` |
| [`tool-image-description/`](tool-image-description/README.md) | Model-facing `describe_image` over the seam, keyed by the content-address handle | registers `describe_image` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Attachment storage](../attachment/README.md) — the content-addressed store both packages read.
- [LLM capability group](../llm/README.md) — the model-call seam the description runs on.
- [`docs/subsystems/`](../../docs/subsystems/) — the subsystem index these packages contribute to.
