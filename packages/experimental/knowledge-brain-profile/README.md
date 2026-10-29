# @deepseek-ai/dsh-experimental-knowledge-brain-profile

English | [中文](README.zh.md)

## Summary

`dsh-experimental-knowledge-brain-profile` mounts [knowledge-brain](../knowledge-brain/README.md) with one bundle, so a profile gains three knowledge tools and a facts directory without hand-editing its composition. The plugin stays inert until a model calls a tool, so a turn that never asks keeps its request unchanged. The bundle ships switched off; enable it from the Plugins page or add it to an initialized profile.

Experimental bundle that mounts [knowledge-brain](../knowledge-brain) into a profile. The plugin stays inert until a model calls one of its tools, so this layer adds no request content on a turn that never asks.

```sh
dsh plugin install @deepseek-ai/dsh-experimental-knowledge-brain-profile
```

## What it configures

| Config | Value | Meaning |
| --- | --- | --- |
| `factsDir` | `./.dsh/knowledge` | Directory of fact documents, relative to the profile workspace |
| `floor` | `5` | Minimum score for a fact to be admitted |
| `maxScan` | `2` | Index entries returned by `knowledge_scan` |
| `minTopicTokens` | `2` | Shared topic tokens required before delivery |

Point `factsDir` at facts produced by `scripts/promote-facts.ts`, or author them directly. A directory that does not exist yields no facts and no deliveries; it is not an error, because a profile that has not built knowledge yet should still start.

## Model Experience

- **Model:** three tools appear (`knowledge_scan`, `knowledge_doubt`, `knowledge_recall`) and nothing else changes; a turn that never calls them sends exactly the request it sent before.
- **Tokens:** 0 on a silent turn. A scan costs ≈50 tokens on a hit; a doubt report ≈50 more; a recall body ≈60.
- **KV cache:** no effect. Nothing is injected, so the request prefix and tail are unchanged.

## Known Limitations and Deferred Work

- The bundle only mounts the plugin. It does not build facts, promote them, or notice when a directory is stale; run the promotion script first and re-run it when sessions accumulate.
- A model that never asks receives no knowledge. Automatic delivery is deferred: it needs a session event to satisfy the model-visible-logged rule, and the measured benefit applies only once something asks.
- Conflicts are authored (`conflictsWith`), never inferred, so a stale fact that contradicts a newer one is visible only if someone declared it.
