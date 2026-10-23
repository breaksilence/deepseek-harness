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
```

- `reserveTokens` —— 在声明容量之下预留的余量，保证答案本身还装得下（默认 `8192`）。
- `strict` —— 压缩后仍装不下时，拒绝该 step（`reject`）而不是追加说明（默认 `false`，即追加说明）。

<a id="understand-the-implementation"></a>
## 理解实现

守卫以 `prepend: true` 监听 `agent/pre-step`，因此能看到其它监听器组装出的决定。它从会话请求头（回退到 agent 选项）解析路由，从解析后的模型信息读取 `context.contextWindow`，并用 `ctx.tokenMeter.measure(...).totalTokens` 测量占用。装不下时调用可选的 `compaction` 服务一次（`context-overflow` 触发）并重新测量。它自己的说明由固定开头句识别，因此多 step 的一轮只说明一次。

### 源码地图

- `src/index.ts` —— 纯判定函数、说明文案、pre-step 接线。

<a id="further-exploration"></a>
## 进一步探索

- [`packages/llm/token-meter`](../../llm/token-meter/README.zh.md) —— 守卫读取的占用测量。
- [`packages/compaction/compaction`](../../compaction/compaction/README.zh.md) —— 它只请求一次的压缩服务。
- [`packages/llm/llm`](../../llm/llm/README.zh.md) —— 携带 `context.contextWindow` 的路由解析。

<a id="model-experience"></a>
## 模型体验

间接地，通过在超限 step 上追加一条用户消息：写明测得的占用、路由容量与三条出路（继续压缩、换回更大窗口、新开会话）。

#### KV 缓存影响

说明进入会话前缀，因此从该点起缓存失效——每轮一次，且只发生在本来就装不下该路由的轮次。
## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 守卫只判定声明了容量的路由；适配器未提供 `context.contextWindow` 时保持现状，包括溢出时由提供方报错。
- 每个 step 只请求一次压缩，且仅在压缩服务已挂载时；没有压缩后端时守卫直接追加说明或拒绝。
- 说明对模型可见但不存储新状态，回放时它作为该轮消息的一部分出现。

### 开发备注

判定是两个已发布数字的纯函数，因此不需要 agent 循环即可单测；pre-step 接线刻意保持很薄。