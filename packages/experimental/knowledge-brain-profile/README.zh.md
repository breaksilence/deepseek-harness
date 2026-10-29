# @deepseek-ai/dsh-experimental-knowledge-brain-profile

[English](README.md) | 中文

## 概述

`dsh-experimental-knowledge-brain-profile` 用一个 bundle 挂载 [knowledge-brain](../knowledge-brain/README.zh.md)，profile 因此获得三个知识工具和一个事实目录，不必手改组合。插件在模型调用工具之前保持静止，没提问的轮次请求完全不变。该 bundle 出厂处于关闭状态；请在插件页面启用，或把它加进已初始化的 profile。

实验性 bundle，把 [knowledge-brain](../knowledge-brain) 挂进 profile。插件在模型调用它的工具之前完全静止，因此这一层不会给"没有提问"的轮次添加任何请求内容。

```sh
dsh plugin install @deepseek-ai/dsh-experimental-knowledge-brain-profile
```

## 它配置了什么

| 配置 | 取值 | 含义 |
| --- | --- | --- |
| `factsDir` | `./.dsh/knowledge` | 事实文档目录，相对 profile 工作区 |
| `floor` | `5` | 事实被接纳的最低分 |
| `maxScan` | `2` | `knowledge_scan` 返回的索引条数 |
| `minTopicTokens` | `2` | 交付前要求共享的话题词数 |

把 `factsDir` 指向 `scripts/promote-facts.ts` 产出的事实目录，或者直接手写。目录不存在时得到零条事实、零次交付，且不报错——还没攒出知识的 profile 仍然应当能启动。

## 模型体验

- **模型侧**：多出三个工具（`knowledge_scan`、`knowledge_doubt`、`knowledge_recall`），其他什么都不变；没调用它们的轮次发出的请求与之前完全一致。
- **Token**：静默轮次为 0；命中一次扫描约 50 tokens，再读怀疑报告约 50，读正文约 60。
- **KV 缓存**：无影响。没有任何注入，请求前缀与尾部都不变。

## 已知限制与后续工作

- 本 bundle 只负责挂载插件，不负责生产事实、执行晋升或发现目录过期；先跑晋升脚本，会话积累后再跑一次。
- 从不提问的模型得不到知识。自动投递被推迟：它需要新增会话事件才能满足"模型可见即被记录"，而实测收益只在"有人提问"之后成立。
- 冲突是作者声明的（`conflictsWith`），从不推断；因此若某条过期事实与更新的冲突而无人声明，看的人不会知道。
