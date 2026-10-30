---
description: "按需查阅项目知识的三个工具：扫描、质疑、召回，数据源为经过校验的事实文档。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-knowledge-brain

[English](README.md) | 中文

## 概述

给模型三种按需查阅项目知识的方式，而不把知识塞进上下文：`knowledge_scan` 回答“有没有相关知识”，`knowledge_doubt` 回答“这一条能信到什么程度”，`knowledge_recall` 返回一条完整事实。系统从不自动投递，因此没有调用工具的轮次，其请求内容完全不变。

## 目录

- [使用方式](#use-this-package)
- [产出与晋升语料](#produce-and-promote-a-corpus)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用方式

在工具注册之后挂载这个函数式插件，并把 `factsDir` 指向事实文档目录。语料**不会**默认取仓库路径，因此空配置得到空知识集，而不是意外投递。

```yaml
- name: '@deepseek-ai/dsh-experimental-knowledge-brain'
  config:
    factsDir: .agents/facts
    floor: 5
    maxScan: 2
    minTopicTokens: 2
```

一条事实文档由 `---` 包围的 JSON 前置元数据与 Markdown 正文组成，正文不会投递给模型：

```markdown
---
{"id":"kb-0001","conclusion":"生成文件禁止手改，须用生成器重新生成。","appliesTo":{"dirs":["scripts/"],"paths":["scripts/gen-tool-catalog.ts"]},"evidence":{"source":"notes/toolchain","quote":"生成物由生成器重写"},"exceptions":"首次创建生成器本身时除外","confidence":0.9,"ttlDays":90,"updatedAt":1793000000000,"trust":"verified"}
---

Free-form elaboration.
```

`trust: background` 的条目可以被召回，但一定会标注“未在本仓库验证”。超过 TTL 的条目会被标记为过期，而不是被隐藏。

-----

<a id="produce-and-promote-a-corpus"></a>
## 产出与晋升语料

事实来自真实工作，而不是想象。闭环是：捕捉一次轮次或一条笔记 → 提炼成下面的四段 → 由晋升门决定它是否可以投递。

1. **提炼**：一条事实只讲一个可执行结论，并带上触发作用域、证据指针与原文引用、以及不成立的条件。
2. **作用域要窄**：像 `packages/` 这样的宽作用域几乎每个轮次都会命中，会劫持投递。多段目录、包、具体文件才算支撑；单段目录不算。
3. **晋升**：用历史轮次回放运行晋升门：

```sh
node --import tsx/esm scripts/promote-facts.ts \
  --facts <facts-dir> --replay <replay.jsonl> --gold <gold.json> \
  --min-support 5 --min-precision 0.55 --out promotion.json
```

只有 support、precision、**边际覆盖**三者同时达标才晋升。没有 `--gold` 时所有候选都被标记为 blocked——匹配到不等于被需要。

4. **评审**：语料放在版本控制里，评审就是一次 PR：丢失证据或作用域的事实不允许合入。

协议有两个参考客户端：本插件（由模型发起工具调用）与 `scripts/knowledge-client.ts`（为任何运行时做同样的分段投递，并打印客户端必须持久化的 span）；`scripts/verify-knowledge-brain.ts` 把晋升门、一次端到端投递，以及（配合 `--questions`）"问题→事实"准确率一起跑通：每条晋升事实配一个生成的问题，用它自己的作用域路径提问，必须返回同一条事实。再加上 `--paraphrased` 会加载第二份"同义改写"问题集，量化话题一致性规则的代价侧。`--min-question`（默认 0.8）与 `--min-paraphrase`（默认 0.85）用于设置失败阈值，让每份语料记录自己的基线而不是继承夹具的。冻结的 33 条语料与两份问题集都在 `tests/fixtures/` 下。报告两个口径：对全部 33 条事实的检索（93.9%），以及只对"一条事实一个轮次"回放能晋升的 22 条事实的检索（90.9%）；后者是端到端链路，前者是检索上限。基线把两个口径分别记为 `retrievalAccuracy` 与 `pipelineAccuracy`，任一退化都能单独看出来。两者的差是覆盖冗余，而不是没用：晋升门按作用域前缀匹配，同一文件上的两条事实服务同一批轮次，第二条不增加覆盖；检索仍然能返回两条，因为交付还要求话题一致。

两个口径各有复现命令：

```sh
# retrieval ceiling: all 33 facts, no promotion filter
pnpm exec vitest run packages/experimental/knowledge-brain/tests/question-accuracy.spec.ts

# end-to-end: promotion gate, delivery, then both question sets
pnpm exec tsx scripts/verify-knowledge-brain.ts \
  --facts packages/experimental/knowledge-brain/tests/fixtures/corpus33 \
  --replay packages/experimental/knowledge-brain/tests/fixtures/replay33.jsonl \
  --gold packages/experimental/knowledge-brain/tests/fixtures/gold33.json \
  --questions packages/experimental/knowledge-brain/tests/fixtures/questions33.json \
  --paraphrased packages/experimental/knowledge-brain/tests/fixtures/questions33-paraphrased.json
```


两个真实回放集（843 轮与 198 轮未见会话）上的实测工作点。标签来自蒸馏语料，因此采纳策略只改变"有哪些事实"：

| 策略 | `floor` | 需要时取到 | 投递精度 | 正确沉默 |
|---|---|---|---|---|
| 默认（support ≥5、precision ≥0.55） | 5 | 66.7% / 70.3% | 76.3% / 78.1% | 62.0% / 53.8% |
| **质量优先（support ≥2、precision ≥0.80）** | 5 | 64.8% / 72.7% | **91.9% / 96.2%** | **94.6% / 88.5%** |
| 质量优先 | 7 | 55.5% / 59.3% | 98.3% / 100% | 100% / 100% |

召回的上界由语料覆盖决定，而不是由 floor 决定；在质量语料上的错投归因显示：覆盖缺口 22 次、排序问题 3 次。正确沉默以标注代理衡量，因此是下界。

对已投递条目做的 17 轮人工抽查显示：按"确定有用"算是 23.5%，按"同子系统算有用"算是 52.9%，而路径代理给出 76.5%。因此本文所有精度数字都是**标注上界**，不是真值。



召回的上界由语料覆盖决定，而不是由 floor 决定：提高 floor 单调换来沉默、牺牲召回。正确沉默以标注代理衡量，因此是下界。

采纳有两条已文档化的策略。默认要求 support ≥5 且 precision ≥0.55；"稀有但精确"策略（`--min-support 2 --min-precision 0.80`）在同一批回放集上多收 4 条事实，把投递精度从 76.8%/77.1% 提升到 94.3%/95.7%，正确沉默从 65.1%/61.5% 提升到 95.3%/88.5%，召回持平（58.8%/62.8%）。




-----

<a id="understand-the-implementation"></a>
### 评审回路

蒸馏负责提议，评审人负责决定，晋升门负责准入。每一步都是一条独立命令，因此某一步出错不会泄漏进语料：

```sh
pnpm run distill-facts -- --turns turns.jsonl --out candidates
pnpm exec tsx scripts/confirm-facts.ts --facts candidates --confirm candidate-1,candidate-2
pnpm exec tsx scripts/confirm-facts.ts --facts candidates --reject candidate-3 --reason "already covered"
pnpm run distill-facts -- --turns turns.jsonl --out candidates --skip-rejected candidates/rejected.jsonl
pnpm exec tsx scripts/draft-conflicts.ts --facts candidates --out conflict-report.md
```

上面几条命令的顺序是：蒸馏提议，评审人确认或拒绝，之后的蒸馏跳过已拒结论，冲突草案始终只是提议。蒸馏会丢弃同一回复里对已接受结论的重述，也会丢弃对已拒结论的重述。两者都按词表比较，所以"用一句话回指长句"（如"上面那条已经写进清单了"）不会被合并；这类候选随后会被晋升门按覆盖冗余拒掉——语料仍然干净，代价是它要多走一次评审。`rejected/` 是保留目录名：加载器会跳过它，所以被拒的结论即使文档还留在树里也进不了语料。确认只改 `trust` 与 `updatedAt`，结论与证据永不重写。

### 漂移门禁

用原始会话文本做蒸馏需要足够的输出预算：推理模型会在写出数组之前花掉大半预算，被截断的回复会按"不可解析"丢弃。八段真实轮次实测每轮产出：1200 时 0.25、2400 时 0.63、3200 时 1.0，因此 `--max-tokens` 默认 3200——代价是输出 token，不是输入。

| `--max-per-turn` | candidates per turn | drop rate | prompt tokens | completion tokens |
|---|---|---|---|---|
| 1 | 0.54 | 0.11 | 3,093 | 5,164 |
| 2 (default) | 0.83 | 0.23 | 3,093 | 10,769 |
| 3 | 1.25 | 0.12 | 3,244 | 14,604 |

提高上限会让输出 token 近似线性增长，同时产出上升；单条候选成本最低的是上限 1，覆盖最广的是上限 3。该上限由 `--max-per-turn` 设置。报告同时记录所有调用的 `promptTokens` 与 `completionTokens`；提供方不上报用量时为 null，因此一次蒸馏的成本是一个数字而不是假设：八段真实轮次在一次实测中花费 3,463 输入与 16,989 输出 tokens。`distill-facts --report <path>` 写出评审人需要跟上的运行统计：每轮候选数、被丢弃提议的占比、以及丢弃原因。`pnpm run verify-knowledge-baseline -- --distill-report <path>` 会把这两个比率与语料测量一起记录；不提供报告时它们保持 null，因此入库的基线永不依赖模型调用。

`pnpm run verify-knowledge-baseline` 重新测量冻结语料并与 `tests/fixtures/baseline.json` 比对：事实条数与晋升条数一条都不许变少，比率只允许按记录的容差（0.05）向下漂移。回退时它会直接打印"哪个数字从多少掉到多少"，而不是依赖谁记得旧值。

## 实现说明

<details>
<summary>实现细节 —— 点击展开</summary>

[`src/facts.ts`](src/facts.ts) 校验每个字段并**响亮失败**，坏文档不会悄悄让语料变少。[`src/load.ts`](src/load.ts) 读取一个目录树并按 id 排序。[`src/rank.ts`](src/rank.ts) 只有在查询命中条目的包、目录、路径、符号或命令时才纳入候选，文本重合仅用于排序打平。[`src/render.ts`](src/render.ts) 把三种载荷渲染为“事实 + 时钟”的纯函数，因此投递内容可从会话日志逐字节重建。[`src/index.ts`](src/index.ts) 注册三个工具，并在首次使用时惰性加载语料。

事实来自 `BrainStore`：目录后端读取事实文档，内存后端直接提供数组，因此调用方可以在不改工具层的前提下换后端。插件不注册任何会话事件，也不做自动注入；投递只以普通工具调用与结果的形式存在。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [架构说明](../../../docs/architecture.zh.md)
- [如何新增工具](../../../docs/cookbook/adding-a-tool.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

### 知识工具

#### 模型看到什么

生成的工具目录拥有 `knowledge_scan`、`knowledge_doubt`、`knowledge_recall` 的准确 schema 与描述。扫描每命中一条返回一行；质疑返回证据、例外、信任级别、过期状态与冲突；召回返回结论、适用范围、证据引用与强制标记。

#### Token 影响

三个固定工具 schema 在挂载期间占用一个常量。扫描受 `maxScan` 行数约束；召回只返回一条。**除非模型调用工具，否则没有任何知识文本进入请求。**

#### KV 缓存影响

工具 schema 不变则保留既有前缀。扫描或召回只是在普通工具历史后追加参数与有界结果，不会重写之前的请求内容。

## 已知限制与后续工作

已实测否决的想法，记录在此以免在没有新证据时被重新提出：

| 想法 | 实测结果 |
|---|---|
| 给"被编辑"的路径更高权重 | 召回 0.670 vs 0.669，无差别；已回退 |
| 分差接近时只给 1 条或直接弃权 | 正确数 5 → 3 → 0（3 / 1 / 0 条候选） |
| 打印"候选不可区分"警告行 | 正确 1 → 0，错答 3 → 4；已删除 |
| 绕过晋升门扩大候选池 | 手挑语料召回 92.0%，走门 97.0% |
- **话题一致性要求共享两个 token。** 调用方给了话题时，事实必须与之共享至少两个 token（拉丁词或中文二元组）；话题词不足两个时要求全部共享。只要求一个词时区分力不够：在 33 条语料上，"给了无关文件"仍有 9 次选中错误事实；提高到两个后降到 3 次，召回从 97.0% 降到 93.9%（−3.1pp）。二元组仍然较粗，所以它过滤明显不相关，不能证明相关。 把 `minTopicTokens` 设为 1 可把召回恢复到 97.0%，但"给了无关文件"时的错误命中会回到 9/33；默认值 2 实测为 93.9% 召回、3/33 错误命中。
- **只给自然语言问题、不给路径上下文时不会命中任何条目。** 放行要求作用域、符号或命令命中，所以纯文字提问即使语料里有答案也会弃权。调用方必须传正在处理的路径或标识符；只按问题措辞匹配时，实测投递量翻倍而精度减半。

<a id="known-limitations-and-deferred-work"></a>

- **没有自动投递** —— 知识从不注入；不调用工具的轮次什么都看不到。
- **只有词面与作用域匹配** —— 未命名任何作用域的同义改写不会被命中，向量检索是刻意不引入的。
- **冲突由作者声明，不做推断。** 条目通过 `conflictsWith` 声明矛盾；共享作用域或相反措辞不视为矛盾证据——对被推断出的冲突抽样复核后，真矛盾为零。声明这条链接属于评审责任。
- **语料新鲜度由调用方维护** —— 复审条目时必须更新 `updatedAt`；插件只负责报告过期。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 —— 点击展开</summary>

默认关闭是刻意设计：实测无地板时的投递精度只有 22%，因此语料必须先通过回放晋升门，才能挂进出厂 profile。

</details>
