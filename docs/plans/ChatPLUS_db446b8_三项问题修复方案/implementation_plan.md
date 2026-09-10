# ChatPLUS：16 轮预演的三项问题定位与修复实施方案

审查目标：`db446b8fdeb00b4189a44a72d509336d86405e8c`。
该提交仅新增/更新预演记录；记录中的实际受测应用代码为 `9f994684df1b693a5701bee2bb66e0596f4a10b0`。

## 0. 证据边界

已核对用户上传的 16 轮 conversation.md、固定提交的关键源文件及预演结果记录。未直接读取该运行的 model-io.jsonl、最终 prompt 或 final.sqlite；这些运行内部信息以用户报告和仓库预演记录为依据，不能称为本次独立数据库审计。未修改远端仓库，未运行付费 API 或仓库全套测试。

`rule_probes.mjs` 是从该提交抄录、去除类型标注的独立纯规则检查，不是项目模块的集成测试。它验证 T6 的分类、T8/T15/T16 的正向请求识别及 T14 被原有人格检查放行。不执行 Zod、SQLite、检索或 Provider。

## 1. 结论与优先级

- T14：事实方向与事实层级的输出校验缺口。不能解释成没召回，也不能仅通过增强检索修复。
- T8：跟进候选的语义完整性缺口。真实引用和相关摘要没有证明 expectedOutcomeDescription。已报告记录为 pending、attemptCount=0、未发送；不是用户承诺、执行或发送错误消息。
- T6：非请求交流的建议强度缺口。当前具体文本还被分类为 casual；即使分类修好，也仍需表达策略及最终输出检查。

优先阻止无依据跟进写入，并补可见关系事实校验；随后调整建议强度。保留 T8/T15/T16 的正常分析和明确求助能力。

## 2. 已核对的代码定位

| 文件                                                          | 函数/位置                                       | 发现                                                                                                               |
| ------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `packages/features/src/persona-guard.ts`                      | `guardPersonaReply()`                           | 检查空回复、元语言、禁用词、日程声称等；不检查互动的行为人和接受者。                                               |
| `apps/server/src/services/causal-reply-guard.ts`              | `inspectCausalReply()`                          | 校验委托决定、行动归属等有限模式，不覆盖日常倾听关系。                                                             |
| `apps/server/src/services/turn-decision-service.ts`           | `inspect()`、`inspectDecision()`                | 当前 conversationPlan 虽在输入中，却没有建议强度或普通关系历史校验。有效人格实际用于此检查的主要是语言禁用项。     |
| 同上                                                          | `decidePersonaReply()`                          | 修复回复后仍附回原 validatedWorldEffects；返回原始 envelope 的 continuityEffects。增加新修复逻辑时须重验相关提案。 |
| `apps/server/src/services/reply-repair-service.ts`            | `repairPersonaReply()`                          | 已传角色、请求、人格实践等，但缺少通用的、带说话人归属的冻结回合证据包。                                           |
| `apps/server/src/services/conversation-continuity-service.ts` | `materializeFollowUpCandidate()`                | 修正引用与摘要，expectedOutcomeDescription 基本直接透传。找不到模型引用时会用用户原文摘录补入。                    |
| 同上                                                          | `followUpProposalSource()`、`groundedSummary()` | 按 subjectType 选择消息；摘要包含关系不等于语义支持。                                                              |
| `packages/features/src/follow-up.ts`                          | `normalizeFollowUpCandidate()`                  | 检查来源角色、引用、摘要相关性与可解析时间；不验证预期活动和用户采纳。                                             |
| `apps/server/src/services/follow-up-service.ts`               | `createFollowUp()`                              | 将规范化结果在短事务中持久化，包括未得到语义验证的预期字段。                                                       |
| `apps/server/src/services/turn-commit-service.ts`             | `commitContinuity()`                            | 续接提交在主消息事务结束后执行；已有正常拒绝提案审计，可复用。                                                     |
| `packages/features/src/conversation-context-plan.ts`          | `VENTING`、`buildConversationContextPlan()`     | T6 不匹配现有倾诉表达，也不含分享分支关键词，落入 casual。                                                         |
| `packages/features/src/conversation-requests.ts`              | `deriveCurrentConversationRequests()`           | 当前已经修好本次 T15/T16 的否定倾听、转而求助，不能用旧判断覆盖。                                                  |
| `packages/features/src/prompt-assembler.ts`                   | 回复策略、`EFFECTIVE_PERSONA_JSON`              | 有软性不强迫建议指令；实践只序列化 facet/practice/scope 等，没有明确互动方向及请求/已发生区别。                    |

## 3. T14：有向互动事实，而不是仅增加“不要幻觉”

### 3.1 两种错误必须分开检查

T9 支持的是：用户请求角色在工作话题中先倾听用户。T14 却写成：用户过去一直倾听角色。

因此同时有：

1. 行为主体与接受者反转。
2. 请求/相处偏好，被升级为反复发生过的行为历史。

即使只交换“你/我”，仍不能无依据声称“我过去一直做到了”。

### 3.2 最小新增模块

建议新增（尚未存在的设计目标，不是现有 API）：

- `packages/contracts/src/interaction-evidence.ts`
- `packages/features/src/interaction-attribution.ts`
- 在现有 `TurnDecisionService.inspect()` 集成纯规则检查；疑难语义审查放在服务编排中。

第一版只覆盖已结构化的有限相处实践，以及本轮/可验证历史中被回复实际引用的事实，不建设通用心理图谱。

服务器生成临时证据锚点，例如：

```json
{
  "kind": "communication_preference",
  "requestedBy": "user:<id>",
  "expectedActor": "character:<id>",
  "recipient": "user:<id>",
  "behavior": "listen_first",
  "scope": { "topic": "work" },
  "modality": "requested",
  "sourceMessageIds": ["<T9的真实消息ID>"],
  "observedAdherenceEvidenceIds": []
}
```

这个锚点描述语义，不是新增长期成长。空的已履行证据只表示当前不足以声称反复履行，不表示反复履行一定从未发生。

事实核查的历史集合与本轮生效的习惯集合应分开：习惯在电影话题不生效，不代表它历史上不存在；没有生效的习惯也不能凭模型任意反写。

### 3.3 最终回复检查

检查对象是候选回复中的实际关系事实声称，而不是只检查用户是否问“你记得吗”。包括自发补充的“你之前一直……”“你替我……”“我答应过你……”。

对每个相关声称核对：行为人、接受者、行为、时间/量词、语气层级、证据。处理否定、引用、假设和第三方转述，不用出现“你/我/听”三个字就判错。

建议新增审计码：

- `INTERACTION_DIRECTION_INVERTED`
- `REQUEST_PROMOTED_TO_HISTORY`
- `UNSUPPORTED_REPEATED_BEHAVIOR_CLAIM`

明确冲突可用纯规则拒绝；复杂语义用一次有界评审，结果为 supported/contradicted/insufficient。评审模型也可能误判，须保存依据并用正负例测试。不要让 LLM 自报的关系元数据代替对实际文字的检查。

### 3.4 修复与短回复

将完整相关证据、角色 ID、原始说话人及上述锚点传给 `ReplyRepairService`。既有一次修复预算应全回合共享，不在多个 inspect() 调用点重复付费。修复后重验最终 text 与 chunks。

本轮没有必要回忆 T9。可接受的语义示例（不是固定模板）：

> 明白，是你朋友对另一个人说的，不是你在改我们之间的相处方式。

禁止仅机械替换人称；禁止用与问题无关的日程 fallback；禁止为修复关系事实虚构新的承诺。

## 4. T8：跟进事项必须由合法用户事件/计划或真实承诺支持

### 4.1 当前路径

```text
原始 worldEffects.continuityEffects
→ ConversationContinuityService.commitTurn()
→ materializeFollowUpCandidate()
→ FollowUpService.createFollowUp()
→ normalizeFollowUpCandidate()
→ repository.insertFollowUp()
```

摘要被换回用户原话，只能证明用户说过分析请求；它不能支持“用户准备尝试清单”。pending 是调度状态，不是证据审核状态。

### 4.2 建议增加公共验证入口

建议新增 `packages/features/src/follow-up-grounding.ts`，所有创建路径均使用。至少检查：

- 主体属于谁；
- 要跟进的具体事项是否来自有依据的用户事件、用户计划、被明确采纳的建议或明确跟进请求；
- expectedOutcomeDescription 是否暗含未出现的活动、承诺、执行或成功；
- timingHint 是事件时间、跟进时间还是模型推断，不能混用；
- 引用是否完整、是否包含否定/条件、是否为第三方说法。

`materializeFollowUpCandidate()` 改为可返回结构化拒绝结果，而不是无论怎样都生成合法 schema 对象。没有有效引用时不能拿一句真实原文给不相关提案“补证”。可以另走独立的服务端事实提取，但必须重新证明全部事项。

`normalizeFollowUpCandidate()` 保留现有角色和时间检查，再验证语义依据。`FollowUpService.createFollowUp()` 必须是统一门槛，不能让 fallback 或直接调用绕过。

### 4.3 区分自然关心与采纳

| 输入                             | 可以产生什么                           | 不可以产生什么         |
| -------------------------------- | -------------------------------------- | ---------------------- |
| “请分析怎样区分做错和改烦了。”   | 正常分析回复                           | 用户将尝试清单的跟进   |
| 助手建议清单；用户没回应         | 建议仍只是建议                         | 采纳、承诺或活动预期   |
| 用户明确说“明天我试试你说的清单” | 有限的尝试计划；可问是否尝试、有无变化 | 已经执行、保证有效     |
| “明天下午有面试。”               | 有来源的事件关心，无需另行说“请提醒我” | 面试已成功             |
| “如果明天不加班，我也许试试。”   | 保留条件和不确定性；可选择不建自动跟进 | 无条件确定活动         |
| “好”“谢谢”“我懂了”               | 依据上下文判断礼貌或理解；不确定则不写 | 自动绑定上一轮所有建议 |
| “提醒我把清单发给同事。”         | 明确请求范围内的跟进                   | 自动追加清单以外的活动 |

不要为了提高通过率把所有建议删除、把所有 follow-up 禁掉，或强迫每次自然关心都要求用户授权提醒。

### 4.4 记录与措辞

建议在正式跟进中保存服务器验证的依据：basisKind、具体事项、modality、支持来源、验证版本及有效性。保留原有 sourceMessageId 作为主要来源；若采纳依赖前一轮建议和后一轮用户确认，还要保存完整的多源链。

可以用追加的 grounding 字段或侧表，避免立刻重做全部生命周期。模型不能自行设置 verified 标志、真实 ID 或已承诺状态。

对合法计划，服务端可以生成保守期望：“询问是否尝试或计划是否有变化”，而不是透传“用户完成清单后反馈结果”。不知道事项是什么，不能只把措辞变软后继续写入。

验证必须覆盖 user_goal/user_event/shared_commitment/character_commitment，防止改个 subjectType 绕过。共享承诺需要对应的双方依据；角色自己提出未来行为也不等于它已发生。

`CareCue.mentionGuidance` 存在相似的直接保留模式，应复用检查思路；这只是邻近路径审查建议，不是本次已经观察到的第四个故障。

### 4.5 事务边界

现有续接在主消息事务之后执行。不要把模型评审或 checkpoint 的 await 搬入 SQLite 事务。可先对内存中的固定回合上下文做预验证，待来源消息真实落库后，在 createFollowUp 中重验并短事务写入。

无效候选应通过现有 rejection 路径记录、跳过，正常分析回复仍成功提交。不要为了一个坏 follow-up 让整个合法聊天返回错误。需要全回合原子化的架构变化可单独实施，不要误称现有结构已经全原子。

## 5. T6：建议强度策略应独立于精确情绪分类

独立规则探针结果：T6 是 casual/adviceRequested=false/respond_naturally；T8/T15/T16 均能识别为 help。新代码已解决上一轮的“否定倾听仍被当成倾听”用例，不要回滚这些修复。

建议新增 `AdvicePolicy`，由当前请求、helpTiming 与相处实践派生，而不是让模型自行授权：

| 当前意图                | 建议政策                                             |
| ----------------------- | ---------------------------------------------------- |
| 明确要求现在分析/给建议 | requested：允许满足请求的具体多步骤回答              |
| 明确只想说、先让我说完  | none_now：这一轮不安排任务                           |
| 明显倾诉、没有求解      | none_now 或先接住情绪，避免行动清单                  |
| 普通分享/闲聊，没有求助 | optional_light：至多一项轻量可选提议，不变成任务表   |
| 先听后分析              | 保留顺序，完成表达之前不提前给方案                   |
| 意图冲突不清            | 不强行长分析，也不无休止固定倾听；自然回应或简短确认 |

“至多一项”是本项目的初始产品策略，可通过评测调整，不是人类交流定律。关键是控制建议负担，不硬性缩短所有回复。

补充对“回到家脑子仍停不下来”等状态分享的识别，但不要依靠无止境添加情绪词。即使分类仍是 casual，optional_light 也应阻止本次连续画画、清单、洗澡、出门等行动安排。

新增 `inspectAdviceLoad()` 或同等检查，识别向用户发出的实际独立行动建议及语气强度，不能按关键词、句数或段落数计数：

- “不是让你去画画或列清单”不是两条建议。
- “你说画画和走路都没用”是转述。
- 用户明确要求比较方法，允许具体分析。
- 一个句子里列四项活动，仍然是多项建议。

本轮更适合的语义示例（不写死台词）：

> 改了一天，回到家脑子还在接着上班，确实很耗人。没有出大事，也不代表今天就轻松。

不要求每次结尾都问“你要建议还是倾听”。

## 6. 共用的最终检查、修复与副作用重验

建议在现有 inspect/repair 机制上增加有限检查，并在所有可能改写文本的环节结束后、发布/提交前做最后复核。不要并列新增多个互相重复的无限修复循环。

```text
冻结回合证据与请求
→ 生成原始回复及提案
→ 检查关系方向、事实层级、建议强度
→ 有问题时使用剩余的一次修复预算
→ 重验最终 text/chunks
→ 按真实来源及最终回复重新验证依赖回复的副作用
→ 正常短事务提交与续接验证
→ 发布最终用户可见文本
```

现有 decidePersonaReply 修复文字后会附回 validatedWorldEffects，并返回原始 continuityEffects。因此不能认为“文字修好”自动意味着候选已经修好。

按依赖区分：用户原话独立支持的事件可以保留；依赖被删建议、被删承诺或错误关系声称的提案必须拒绝/重新验证。不要为了省事把同轮所有合法状态和用户事实清空。

检查须覆盖所有最后改写：WorldEffectService、显式事实/因果修复、fallback，以及顺序消息 chunks。不要让 text 合格但某个聊天气泡仍有旧句。

建议审计：原始与最终回复 hash、触发规则、问题片段、证据 IDs、修复次数、最终建议负担、接受/拒绝的 follow-up 及依据。逻辑调用和物理调用均计费留痕，不把经修复成功算作原始模型从未犯错。

## 7. 既有错误数据如何处理

保留原始预演产物不可变，新代码使用新 run ID，不改写旧报告让它看起来通过。

- T8：在测试副本或确实需要继续使用的实例中，按该运行与 sourceMessageId 精确定位该 pending 记录，核对 attemptCount=0、sentMessageId 为空，标记“证据无效/待复核”并从可发送集合剔除。不要把它伪造为用户取消，也不要清空所有 pending。
- 若当前生命周期无审核状态，追加独立 evidenceStatus/有效性侧表并在领取和发送前校验；旧记录默认待复核，不默认全可信。
- T14：原始消息仍须保留。用问题片段注释或可信纠正记录，在后续上下文与派生处理中不再把错句当成关系事实。整个消息里正确的第三方归属不必一起删除。已展示的历史不要静默替换；需要显示更正时显式标注。
- 本次没有观察到该错句形成长期人格，不要声称已完成了人格污染清理。但要增加“下一轮原文窗口/后续整理不自证”回归。

## 8. 回归与验收

`regression_cases.json` 给出建议新增的机制测试，不是现有 runner 支持的可执行配置。

建议测试文件（新增）：

- `packages/features/src/interaction-attribution.test.ts`
- `packages/features/src/follow-up-grounding.test.ts`
- `packages/features/src/advice-policy.test.ts`
- `apps/server/src/services/conversation-semantic-boundaries.integration.test.ts`

同时扩展既有 follow-up、persona guard、context-plan 与 repair 测试。测试覆盖真实服务路由，不能只给新函数输入提前标注好的 speaker/adopted=true。

### 四层

1. 纯规则：T6 的策略、关系方向、请求和履行区别、采纳状态。
2. Provider stub 集成：给正常生成入口注入错误原始回复/continuityEffects，检查实际 final reply、repair、拒绝提案、DB 行与重试。
3. 同角色固定快照回归：T6 的快照不得含 T9 之后的长期偏好；T8 之后不得注入未来的用户采纳。修正任一环节后检查其他两个问题不复发。
4. 单独授权后的真实小批次：先重跑原 16 轮作回归，再加入同义改写和正向控制；冻结模型、角色基线、预算、配置和源代码。原始错误与最终修复分别计分。

### 门槛

- T14 错误原句在 stub 集成中必须被检测，最终用户可见 text/chunks 不出现关系反转或无依据“过去一直”。
- T8 分析请求＋助手清单建议不能创建这项 user_event follow-up；正常分析必须保留；后来明确采纳的对照可以创建有限计划跟进。
- T6 不再堆叠行动建议，同时 T8/T15/T16 仍回答明确请求。
- 同 clientMessageId 重放不重复写入、不新增修复调用。
- 所有拒绝都有明确原因和来源，没有用无关 fallback 掩盖。

原普通非请求分母为 9，8/9=88.9% 未达到预设90%。修复一个例子使原集9/9，只能说明原回归集通过，不能据此证明真实总体达到90%；单独报告留出改写集，保留原分母，不事后重分类抬分。

## 9. 三个实施工作包

**PR-A：跟进语义门槛。** 公共 grounding、规范化和物化拒绝结果、accepted basis持久化、精准处理无效 pending。保护自然关心与合法后续采纳。

**PR-B：可见关系事实。** 有向锚点、请求/履行层级、最终回复检查、带证据修复、text/chunks与副作用重验、旧错句只读更正。

**PR-C：非请求建议负担。** AdvicePolicy、有限语义检查、对普通分享/倾诉的识别与正向求助保护、同义改写留出测试。

三项共享一个冻结回合上下文和一次修复预算。不要顺便自动修改全局价值观、停用所有跟进或将普通聊天变成每轮填写支持方式表单。
