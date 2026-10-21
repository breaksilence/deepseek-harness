---
description: "面向模型的 describe_image 工具：通过图片描述接缝把已附图片读成文本，让纯文本路由也能知道图片内容。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-image-description

[English](README.md) | 中文

## 概述

当模型路由无法接受图片时，用 `dsh-tool-image-description` 给它一条读图通路。llm 内容投影会把每个图片出现替换成携带 `attachment sha256:<前缀>` 的确定性占位符；本工具接收该句柄，解析出确切对象，再向 `imageDescription` 接缝索取文本。工具只负责参数检查与面向模型的结果；路由选择、后备与拒绝措辞归接缝所有。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

与 `@deepseek-ai/dsh-image-description` 及任一带附件的存储一起挂载：

```yaml
- id: tool-image-description
  name: '@deepseek-ai/dsh-tool-image-description'
```

模型调用 `describe_image({ attachment, prompt? })`：

- `attachment` —— 来自图片占位符的句柄：完整的 `sha256:` 摘要或其十六进制前缀（至少 8 位）。前缀命中多个对象时会失败并列出候选。
- `prompt` —— 想从图中提取什么；省略时使用接缝的默认指令。

<a id="understand-the-implementation"></a>
## 理解实现

插件在挂载作用域注册一个工具。调用时通过 `ctx.attachments.resolveImageByContentAddress` 解析附件，从请求头读取会话当前路由，然后委托 `ctx.imageDescription.describe`。返回的描述原样呈现，并标注是哪个路由产生的；工具不存储任何东西，也不追加会话事件。

### 源码地图

- `src/index.ts` —— 工具定义、参数模式、附件解析、委托、呈现结果。

<a id="further-exploration"></a>
## 进一步探索

- [`packages/image-description/image-description`](../image-description/README.zh.md) —— 本工具消费的接缝。
- [`packages/attachment/attachment`](../../attachment/attachment/README.zh.md) —— 附件存储与其内容寻址查找。
- [`packages/fs/tool-fs`](../../fs/tool-fs/README.zh.md) —— `read_image`，供真正支持图片的路由使用。

<a id="model-experience"></a>
## 模型体验

无，因为工具只呈现一条文本结果，其 schema 与描述已由工具定义本身持有。

#### KV 缓存影响

不新增系统提示段落，也不改历史前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- 只接受附件存储作为来源，不接受裸本地路径；已可在文件系统访问的图片仍走 `read_image`。
- 每次调用都是一次辅助视觉请求；工具不缓存描述。
- 工具不切换会话模型，纯文本会话保持原路由并收到文本。

### 开发备注

呈现由消费方负责：接缝与工具只返回文本，不向会话表面追加任何内容。
