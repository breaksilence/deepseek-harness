---
description: "图片描述能力接缝：优先用会话自身的路由读图，其次用配置的视觉路由，两者都不满足时给出说明缺哪一项的类型化拒绝。"
kind: "package-reference"
---

# @deepseek-ai/dsh-image-description

[English](README.md) | 中文

## 概述

当会话需要读取自身模型无法接受的图片时使用 `dsh-image-description`。该接缝只负责一个问题和一个答案：由哪条路由来读这张图。它先问会话当前路由，若该路由声明了图片输入就直接使用；否则使用部署配置的视觉路由；两者都不满足时，拒绝并说明缺的是哪一项。辅助模型调用、输出上限与默认指令属于本包；描述结果返回给调用方，从不写入会话。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在 host 面挂载该插件，由消费方（例如 `@deepseek-ai/dsh-tool-image-description`）调用 `ctx.imageDescription.describe(...)`。

```yaml
- id: image-description
  name: '@deepseek-ai/dsh-image-description'
  config:
    visionProvider: deepseek-official
    visionModel: deepseek-v4-flash-vision-exp
```

- `visionProvider` / `visionModel` 必须成对声明后备路由；两者都省略时，本接缝只能服务自身模型可读图的会话。
- `maxOutputTokens` 限制单次描述的产出长度（默认 `1024`）。
- `prompt` 替换随每张图发送的默认指令。
- 设置归属方可在运行时调用 `configureVisionModel(selection)`，让用户选择无需重挂组合即可生效。

<a id="understand-the-implementation"></a>
## 理解实现

这是一个服务插件：注册 `ctx.imageDescription`，并在加载时从自身配置解析后备路由。`describe` 先解析路由，再构造一条携带图片块与指令的用户消息，用 `ctx.llm.prepareCall(...)` 为该路由发起调用，并组装流式文本。无法解析的路由按"不可读图"处理，因此结果由后备路由或拒绝逻辑决定，而不是让解析错误直接逃逸。

### 源码地图

- `src/index.ts` —— 服务定义、路由解析策略、辅助调用、类型化拒绝。

<a id="further-exploration"></a>
## 进一步探索

- [`packages/image-description/tool-image-description`](../tool-image-description/README.zh.md) —— 面向模型的消费方。
- [`packages/attachment/attachment`](../../attachment/attachment/README.zh.md) —— 存放被读取图片的存储。
- [`packages/llm/llm`](../../llm/llm/README.zh.md) —— 描述调用所依赖的模型调用接缝。

<a id="model-experience"></a>
## 模型体验

无，因为本接缝只把描述文本返回给消费方，自身不贡献任何模型上下文。

#### KV 缓存影响

辅助请求不携带会话前缀，既不读取也不失效缓存。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- 后备路由是部署级 `Config`，不是设置命名空间；设置归属方需显式调用 `configureVisionModel` 应用。
- 每次描述都是一次新的模型调用：没有缓存，同一张图描述两次就计费两次。
- 图片只从附件存储读取；存储之外的本地文件不是本接缝的来源。

### 开发备注

呈现由消费方负责：接缝与工具只返回文本，不向会话表面追加任何内容。
