---
description: "图片描述分组：一个图片转文本的能力接缝，以及让纯文本路由也能读图的面向模型工具。"
kind: "package-group"
---

# image-description/

[English](README.md) | 中文

## 概述

图片描述分组让会话能够读取自身模型无法接受的已附图片。其中一个包负责能力接缝：由哪条路由读图、给它什么指令、缺少配置时如何拒绝并说明缺的是哪一项。另一个包负责面向模型的工具：把纯文本路由收到的占位句柄还原成确切的存储对象，并返回文本。两者合起来，任何会话都可以发送图片，而由模型自己决定何时花一次描述。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)

-----

<a id="packages"></a>
## 包

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`image-description/`](image-description/README.zh.md) | 解析读取单张图片的路由并发起辅助描述调用 | `ctx.imageDescription` |
| [`tool-image-description/`](tool-image-description/README.zh.md) | 基于接缝的面向模型 `describe_image`，以内容地址句柄为参数 | 注册 `describe_image` |

-----

<a id="related-documentation"></a>
## 相关文档

- [附件存储](../attachment/README.zh.md) —— 两个包共同读取的内容寻址存储。
- [LLM 能力分组](../llm/README.zh.md) —— 描述调用所依赖的模型调用接缝。
- [`docs/subsystems/`](../../docs/subsystems/) —— 这些包贡献的子系统索引。
