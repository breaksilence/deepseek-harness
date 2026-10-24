---
description: "上下文窗口适配守卫：把会话历史与当前路由声明的容量对比，必要时压缩一次，然后为该 step 追加说明或拒绝，避免超限路由把整轮变成失败。"
kind: "package-reference"
---

# @deepseek-ai/dsh-guard-context-window-fit

[English](README.md) | 中文

## 概述

当会话可能超出其路由容量时使用 `dsh-guard-context-window-fit`——最典型的情形是从大窗口模型切到小窗口模型，以及适配器声明了陈旧的窗口。守卫从 token 计量取占用、从解析后的模型路由取容量；装不下时向压缩服务请求一次压缩并重新测量。压缩后仍装不下的历史会被追加一条说明，写清缺口与三条出路（继续压缩、换回更大窗口、新开会话）。未声明容量的路由一律不判定，因为猜一个窗口只会凭空制造失败。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

与 token 计量、压缩后端一起挂在 host 面：

```yaml
- id: context-window-fit
  name: '@deepseek-ai/dsh-guard-context-window-fit'
  config:
    reserveTokens: 8192
    strict: false
    pressureRatio: 0.8
```

- `reserveTokens` —— 在声明容量之下预留的余量，保证答案本身还装得下（默认 `8192`）。
- `strict` —— 压缩后仍装不下时，拒绝该 step（`reject`）而不是追加说明（默认 `false`，即追加说明）。
- `assumedContextWindow` —— 为未声明容量的路由假定的容量；默认关闭，且由它产生的说明会明确标注这是假定值。
- `pressureRatio` —— 可用预算被消耗到该比例时提前给出**不阻断**的提示（默认 `0.8`；`0` 关闭该档）。

<a id="understand-the-implementation"></a>
## 理解实现

守卫以 `prepend: true` 监听 `agent/pre-step`，因此能看到其它监听器组装出的决定。它从会话请求头（回退到 agent 选项）解析路由，从解析后的模型信息读取 `context.contextWindow`，并用 `ctx.tokenMeter.measure(...).totalTokens` 测量占用。装不下时调用可选的 `compaction` 服务一次（`context-overflow` 触发）并重新测量。守卫分三档：保持沉默、可用预算将尽时的提前提示（`pressureRatio`）、以及它本来要处理的溢出。说明以耐久用户消息落库（source.kind 为 context-window-fit），而不是只作为临时 step 输入：模型能看到、回放能重建、会话界面能展示；近期事件扫描保证一轮只说明一次。

### 源码地图

- `src/index.ts` —— 纯判定函数、说明文案、pre-step 接线。

<a id="further-exploration"></a>
## 进一步探索

- [`packages/llm/token-meter`](../../llm/token-meter/README.zh.md) —— 守卫读取的占用测量。
- [`packages/compaction/compaction`](../../compaction/compaction/README.zh.md) —— 它只请求一次的压缩服务。
- [`packages/llm/llm`](../../llm/llm/README.zh.md) —— 携带 `context.contextWindow` 的路由解析。

<a id="model-experience"></a>
## 模型体验

间接地，通过已记录的用户消息：可用预算将尽时一条提前提示，超限时一条写明测得的占用、路由容量与三条出路（继续压缩、换回更大窗口、新开会话）的说明。

#### KV 缓存影响

说明进入会话前缀，因此从该点起缓存失效——每轮一次，且只发生在本来就装不下该路由的轮次。
## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 守卫只判定声明了容量的路由；适配器未提供 `context.contextWindow` 时保持现状，包括溢出时由提供方报错。
- 每个 step 只请求一次压缩，且仅在压缩服务已挂载时；没有压缩后端时守卫直接追加说明或拒绝。
- 说明是一条已记录的用户消息，因此留在历史里、回放中就地显示；它不改变被压缩区间的 token 记账。

### 开发备注

判定是两个已发布数字的纯函数，因此不需要 agent 循环即可单测；pre-step 接线刻意保持很薄。