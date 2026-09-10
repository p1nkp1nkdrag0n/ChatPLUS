# 架构实验的提示词与夹具审计

日期：2026-09-10。审计对象为已冻结的 B 整体对话系统比较与 C 提示词读出诊断。以下是机制和测量边界，不是 GLM 输出质量结论。生产代码与已启动的实验代码均未因本报告修改。

离线复现通过 `createArchitectureRuntime` 建立独立 SQLite、冻结时钟，并走生产 HTTP 消息路由。模型传输只调用 `architectureFixtureFetch` 返回固定测试回复；`baseUrl=https://example.invalid`，没有外部请求，也没有付费模型调用。固定回复不能用来判定人格或回答质量。

复现脚本：[architecture-preflight-audit.ts](E:/2026/ChatPLUS/tmp/architecture-preflight-audit.ts)。完整证据：[audit.json](E:/2026/ChatPLUS/tmp/architecture-preflight-audit-data-20260910/audit.json)。脚本用 `mkdirSync` 拒绝覆盖既有目录；复跑时先把输出常量改成一个新的、位于 `tmp` 的目录，再在仓库根目录执行 `pnpm exec tsx tmp/architecture-preflight-audit.ts`。这只是分析脚本，不参与冻结实验。

## 1. anchored_story 的记忆证据在时间投影后未能渲染

同一 P08 历史、同一角色、同一生产检索器，仅改变时间框架，可以稳定复现下表：

| 检查项                                | realtime                 | 精确对齐的 anchored_story |
| ------------------------------------- | ------------------------ | ------------------------- |
| 当前角色当地时间                      | 2026-10-05 17:00 +08:00  | 2026-10-05 17:00 +08:00   |
| 系统锚点                              | 2026-10-05T09:00:00.000Z | 2026-10-05T09:00:00.000Z  |
| 初始存储记忆数                        | 3                        | 3                         |
| MEMORY_USE_JSON.backgroundEvidenceIds | evidence_0n39rci         | evidence_0n39rci          |
| 最终 RETRIEVED_EVIDENCE_JSON 的证据数 | 1                        | 0；整个段落未渲染         |

因此，这一失败不仅是作者输入只有年份、默认故事日期落在 1 月 1 日造成的错位。即使故事锚点与真实冻结时钟精确对齐，已经选中的证据仍不能进入最终提示词。两份证据分别见 [realtime](E:/2026/ChatPLUS/tmp/architecture-preflight-audit-data-20260910/P08-realtime/audit.json) 和 [anchored_aligned](E:/2026/ChatPLUS/tmp/architecture-preflight-audit-data-20260910/P08-anchored_aligned/audit.json)。

调用链解释了这个现象：

1. [prompt-assembler.ts:972](E:/2026/ChatPLUS/packages/features/src/prompt-assembler.ts:972) 将原始 `memoryEvidence` 放进 `retrievedEvidence`；[同文件:1006](E:/2026/ChatPLUS/packages/features/src/prompt-assembler.ts:1006) 对整个上下文运行 `projectPromptTemporalData`，然后在 [同文件:1110](E:/2026/ChatPLUS/packages/features/src/prompt-assembler.ts:1110) 交给段落注册表渲染。
2. [character-time.ts:18](E:/2026/ChatPLUS/packages/features/src/character-time.ts:18) 只在 `anchored_story` 下递归转换。其 [第 30 行](E:/2026/ChatPLUS/packages/features/src/character-time.ts:30) 和 [第 51 行](E:/2026/ChatPLUS/packages/features/src/character-time.ts:51) 把 `generatedAtUtc`、`recordedAtUtc` 等键改为 `generatedAtCharacterLocal`、`recordedAtCharacterLocal`。
3. [retrieved-evidence-segment.ts:36](E:/2026/ChatPLUS/packages/features/src/prompt-segments/retrieved-evidence-segment.ts:36) 对已被投影的数据重新执行存储形状的 `EvidenceBundleSchema.safeParse`；失败时在下一行直接返回 `null`。但该合同仍要求 [retrieval.ts:179](E:/2026/ChatPLUS/packages/contracts/src/retrieval.ts:179) 的 `generatedAtUtc`，以及嵌套 [memory-evidence.ts:90](E:/2026/ChatPLUS/packages/contracts/src/memory-evidence.ts:90) 的 `recordedAtUtc`。

这造成“检索审计认为已选中，提示词实际没有证据”的不一致，且 MEMORY_USE_JSON 可能留下指向缺失证据的 ID。只检查 selectedEvidenceIds 会误判机制已经生效，必须同时检查最终段落和实际负载。

本次 B/C 的手工作者夹具在付费前已明确设为 `realtime`，见 [architecture-evaluation-runtime.ts:127](E:/2026/ChatPLUS/apps/server/src/scripts/architecture-evaluation-runtime.ts:127)，共享冻结时钟。显式传入的生成角色仍保留自身时间框架。生产 `anchored_story` 渲染缺陷尚未修复，不能把实验夹具的时间对齐写成产品修复。只有年份时采用 1 月 1 日默认锚点的代码位于 [defaults.ts:342](E:/2026/ChatPLUS/apps/server/src/domain/defaults.ts:342)，这是与上述 schema 问题分别存在的时间输入边界。

## 2. P09 是存在真实记忆但未召回的探针

P09 原始用户历史明确先约周六、柳桥站东口，随后更正为周日上午十点、柳桥站西口并使旧版作废。当前问句是“我要给同行的人发最终安排，帮我把时间和集合地点写成一句话”，不会逐字重提站名；原安排位于当前最近原文窗口之外。场景见 [architecture-evaluation-cases.ts:239](E:/2026/ChatPLUS/apps/server/src/scripts/architecture-evaluation-cases.ts:239)。

离线证据 [P09-realtime/audit.json](E:/2026/ChatPLUS/tmp/architecture-preflight-audit-data-20260910/P09-realtime/audit.json) 显示：

- 原安排 `memory_0p09yzc` 和更正 `memory_1acncgu` 均以带原句来源的报告形式存储，状态均为 `active`。不存在“没有向数据库放入正确答案材料”的借口。
- 检索返回 `selectedMemoryIds=[]`、`selectedEvidenceIds=[]`、`abstained=true`，原因 `durable_memory_below_relevance_threshold`，记录的最高分为 `0.303065`。三条候选都在 rejectedMemoryIds 中。
- 最终提示词没有 RETRIEVED_EVIDENCE_JSON，MEMORY_USE_JSON 的三个使用 ID 数组也都为空。

生产阈值筛选在 [memory-recall.ts:858](E:/2026/ChatPLUS/packages/features/src/memory-recall.ts:858)；无入选候选时返回弃权，层级检索在 [memory-recall-hierarchy.ts:1028](E:/2026/ChatPLUS/apps/server/src/services/memory-recall-hierarchy.ts:1028) 将其报告为上述原因。证据足以证明本夹具下未召回，不足以从单例判定词法匹配是唯一原因或概括全部更正机制。

因此，P09 的 full 输出可以揭示整个系统是否在此回顾任务中失效；但删除本来为空的记忆读出不能测量记忆的因果贡献。冻结前主脚本已增加实际有效负载检查，见 [architecture-evaluation.ts:473](E:/2026/ChatPLUS/apps/server/src/scripts/architecture-evaluation.ts:473)。被跳过的空目标需要报告为诊断不适用，不能当作“消融没有影响”。full 主生成与 flat 的比较仍可保留，前提是标注其共享的记忆缺失。

## 3. P10 的回答不复述，不等同于存储撤回成功

P10 用户先给私下代号，后来明确要求不要保存、重复或作为以后线索。准备前缀使用完整用户原句作为 source-report，经正式候选校验写入；随后调用生产生命周期协调和明确实践捕捉。实现见 [architecture-evaluation-runtime.ts:199](E:/2026/ChatPLUS/apps/server/src/scripts/architecture-evaluation-runtime.ts:199)、[同文件:241](E:/2026/ChatPLUS/apps/server/src/scripts/architecture-evaluation-runtime.ts:241)。每次都记录 `prepared-prefix-source-report-fixture-not-generated`，没有用隐藏评分答案生成记忆。

但 [P10-realtime/audit.json](E:/2026/ChatPLUS/tmp/architecture-preflight-audit-data-20260910/P10-realtime/audit.json) 的真实状态是：原私下代号报告 `memory_0ssorb5` 和撤回报告 `memory_1pleurq` 都仍为 `active`；两次协调结果为空。更严重的是，当前“回到我的计划”检索选择了原代号记录，将其纳入 `background` 和 `explicit_mention` 允许用途，撤回报告反而被拒选。最终提示词的 evidence quote 中包含原代号。

这证明当前准备前缀路径没有完成存储失效或召回隔离。完整对话尾部尚可能让回复遵守“不复述”，因此文本得分通过不能证明底层已经忘记。本次 P10 应分别报告输出是否复述、存储状态、实际提示词泄露三项；不能只用字符串不存在来声称遗忘成功。

边界同样必须保留：这是“逐句源报告入库 + 正式协调”夹具下的观察，不等同于完整原生历史对话曾执行过全部在线忘记入口。候选是来源报告，而非另行提供已解析的删除目标。D 原生轨迹可补充测量真实逐轮抽取/撤回行为；本报告不预先声称它通过。

## 4. 整体系统对比包含默认策略、修复和预算差异

B 的解释单位应是“部署这些机制后的整个对话处理系统”。它不是严格控制所有政策和数据表示的纯架构实验。

- 作者输入相同，但 full 从生产角色构造器获得额外默认内容。例如 [defaults.ts:132](E:/2026/ChatPLUS/apps/server/src/domain/defaults.ts:132) 的 `synthetic_extension` 价值“尊重真实关系”，以及 [defaults.ts:194](E:/2026/ChatPLUS/apps/server/src/domain/defaults.ts:194) 的计划方式偏好。simple 则把原始 author card 放入单对象提示词，见 [architecture-evaluation-runtime.ts:429](E:/2026/ChatPLUS/apps/server/src/scripts/architecture-evaluation-runtime.ts:429)。所以 B 的差异同时包含生产默认人格、策略、表示及机制。
- simple 也有明确的共同事实约束、当前请求优先、后续更正与撤回优先和完整答复要求，见 [architecture-evaluation-runtime.ts:411](E:/2026/ChatPLUS/apps/server/src/scripts/architecture-evaluation-runtime.ts:411)。它与 full 的 APP_POLICY 不是逐字相同；不可把 B 结果单独归因于模块分层。
- full 使用生产路由及其校验/修复；simple 有独立的规范 JSON 修复流程；C 的读出诊断只运行直接主生成，不再把 full 上下文重新注入修复。可比较各系统最终效用和实际调用成本，但 C 不能被称为移除了所有上游模块。
- enforced 实验配置见 [reply-steering-runner.ts:262](E:/2026/ChatPLUS/apps/server/src/scripts/reply-steering-runner.ts:262)。产品环境的 companion context 和 persona runtime 默认仍是 off，见 [config.ts:274](E:/2026/ChatPLUS/apps/server/src/config.ts:274)。因此应称“启用已实现机制的 full 配置”，不要称“当前默认产品配置”。本实验关闭 correspondence 与 keepsakes，并且作者夹具无主动日程；范围是对话架构，不是完整自主生活系统。
- C 的 flat 仅保留 full 已经实际纳入提示词的 JSON 数据和原文，再压平表示、缩短共同策略。它没有补回被检索器漏掉的事实。适合检验已入选信息的表达开销，不能等同于政策完全相同或对全模块生命周期的移除。

## 5. P12 历史时间戳与问句的测量冲突（盲评首批后补记）

这一项在第一次 34 条盲评完成后，根据一条候选提到“今天下午才聊过”发现。原始评分已锁定，不以发现后的理解回改；它不是付费前已排除的问题。

P12 场景指定 `simulatedDay:4`，用户说“已经过了几天了”，见 [architecture-evaluation-cases.ts:294](E:/2026/ChatPLUS/apps/server/src/scripts/architecture-evaluation-cases.ts:294)。主脚本把第 4 天作为当前时刻，见 [architecture-evaluation.ts:392](E:/2026/ChatPLUS/apps/server/src/scripts/architecture-evaluation.ts:392)。但初始化器又把所有历史记录排在这个当前时刻之前每条相差一分钟，见 [architecture-evaluation-runtime.ts:180](E:/2026/ChatPLUS/apps/server/src/scripts/architecture-evaluation-runtime.ts:180)，没有把原始事件留在第 0 天。

full 因而可能看到“几分钟前”的明确历史时间，而 simple 的 `recentMessages` 是只有 role/content 的原始数组，见 [architecture-evaluation-runtime.ts:435](E:/2026/ChatPLUS/apps/server/src/scripts/architecture-evaluation-runtime.ts:435)。两边时间证据不对称，且 full 时间证据与当前用户的“几天”冲突。不要把 full 纠正这句话直接解释为模型时间能力更差，或用相反方式奖励它。

原 P12 结果需保留并标注夹具混杂。后续日期修正验证应作为独立补充批次：把原历史固定在第 0 天，在第 4 天提出问题，且向各 arm 提供相同可见时间戳；新结果不能覆盖原冻结结果。当前运行期间没有改动相关代码。
