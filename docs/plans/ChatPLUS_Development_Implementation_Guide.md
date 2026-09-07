# ChatPLUS：从决策因果 Demo 到长期角色陪伴的开发实施指南

版本：实施建议 v1 / 2026-09-06  
审查基线：`dc51b5cba3dee574c86ba4bd58337c93b2d8b555`（本次读取的 main）  
范围：记忆语义、检索与普通聊天、角色生成与有限成长、生活推进。  
性质：源码定位与开发设计，不是已经应用的补丁。本次未修改仓库，未运行仓库测试或付费模型调用。文中的“新增”文件、API、开关和测试均为建议，尚不存在于当前基线。函数名以源码为定位锚点；行号可能随提交变化。

## 1. 决策摘要

不要从“让全部人格数值动态变化”开始。按以下顺序实施：

1. 固定评测与日志基线。
2. 修正记忆写入、总结、纠正和派生内容中的语义问题。
3. 让检索理解上下文，让普通聊天不默认进入建议或人生选择。
4. 消除角色生成链路中的目标、矛盾强制补全；建立当前有效画像。
5. 在可靠事实上增加局部的认识与相处方式更新。
6. 最后修改生活主线的推进方式，保留已有因果正确性。

初始人物档案是“起点”，不是“当前人物永远不变的全部真相”。明确历史和创作限制保持连续；情绪、关注点、关系和解释可以变化；长期价值倾向的自动更新暂不作为第一版能力。

## 2. 已核实的关键入口

| 责任 | 当前文件与函数 | 已核实的情况 |
|---|---|---|
| 创建输入 | `packages/contracts/src/character.ts` / `OriginalCharacterInputSchema` | 三个 coreTraits 固定数量；coreContradiction、mainGoal 必填。 |
| 人格合同 | 同上 / `CharacterPersonaSchema`、`ContradictionRuleSchema` | contradictions 可为空；goals 至少一项；矛盾没有当前适用期与关系范围。 |
| 原创默认草稿 | `apps/server/src/domain/defaults.ts` / `buildOriginalDraft` | mainGoal 同时进入目标、第一条价值与 selfDescription；默认补充第二组矛盾。 |
| 默认目标阶段 | 同上 / `buildTimeBasedGoalMilestones` | 默认生成 0、14、45、90、180 天的阶段。 |
| 编译与权威回填 | `apps/server/src/services/character-compiler.ts` / `CHARACTER_COMPILATION_STRATEGY`、`applyOriginalFormAuthority` | 提示词要求有支持时至少两组矛盾；后处理会强制回填首条矛盾、目标，并把 mainGoal 写入第一条价值。 |
| 生成生命周期 | `apps/server/src/services/character-service.ts` / `generate`、`import`、草稿更新和发布链路 | 模型草稿经过服务端权威处理；不能只修模型提示词。 |
| 里程碑回填 | `apps/server/src/services/character-clock.ts` / `ensureTimeBasedGoalMilestones` | 缺少足够里程碑时重新补全。 |
| 聊天编排 | `apps/server/src/services/conversation-service.ts` / `chat` | 当前记忆查询用 input.text；随后才整理近期上下文；生成、检查和世界效果都持有 spec。 |
| 上下文准备 | `apps/server/src/services/conversation-context-service.ts` / `prepare` | 汇集 continuity、时间、自传和关系产物上下文。 |
| 回复策略 | `packages/features/src/reply-strategy.ts` / `deriveReplyStrategy` | 主要根据措辞、长度、复杂程度、风格和状态配置回复形式。 |
| 提示词 | `packages/features/src/prompt-assembler.ts` / `assembleChatPrompt`、`compactMemoryEvidence` | 静态人格和目标仍进入提示词；证据按字符裁剪且只保留前三条。 |
| 提示词预算 | `packages/features/src/prompt-segments/default-segments.ts`、`registry.ts`、`retrieved-evidence-segment.ts` | 分段、优先级、预算与序列化需要一起检查，不能只调一个 maxEvidence。 |
| 记忆合同 | `packages/contracts/src/memory.ts` | 已有 namespace、certainty、attribution、stability、claim、superseded、needs_review，优先复用。 |
| 记忆写入与候选读取 | `apps/server/src/services/memory-service.ts` / `PersistMemoryInput`、候选持久化链路、`readRecallCandidateRecords` | 已有活跃状态过滤、词语候选池、明确纠正相关逻辑。 |
| 记忆语义规则 | `packages/features/src/memory-judge.ts`、`memory-claim.ts`、`memory-lifecycle.ts` | 已有来源、状态、稳定推断等规则；不是缺少全部防幻觉设施。 |
| 自传校验 | `packages/features/src/autobiography.ts` / `isGrounded`、`validateAutobiographyRevision` | isGrounded 的共有词/双字片段匹配不能证明语义蕴含。 |
| 自传与事件卡提交 | `apps/server/src/services/autobiography-service.ts`、`checkpoint-service.ts` | checkpoint 生成、校验、派生卡片、来源 hash 与 revision 栅栏已存在。 |
| 检索合同与执行 | `packages/contracts/src/retrieval.ts`；`apps/server/src/services/memory-recall-service.ts`、`memory-recall-hierarchy.ts` | 证据集合与结果 ID 数组都限制为最多三项；分层检索也有相同限制。 |
| 检索审计 | `apps/server/src/repositories/retrieval-run-repository.ts` | 存在检索记录与回放机制，应扩展而非另建平行日志。 |
| 生活上下文 | `apps/server/src/services/fuzzy-life-service.ts` / `promptContext`、`ensureGoalThreads`、`advance` | promptContext 不接本轮查询；会带入近期决策、困境、压力与主线等。 |
| 生活计划 | `apps/server/src/services/fuzzy-life-planning.ts` / `freezeTimelinePlan` 等 | 当前 fuzzy 生活本身也存在冻结里程碑，不要与 legacy_exact 混淆。 |
| 生成、校验、修复与提交 | `turn-decision-service.ts`、`reply-repair-service.ts`、`world-effect-service.ts`、`turn-commit-service.ts` | 都是有效画像和证据版本需要贯穿的入口。 |
| 服务装配 | `apps/server/src/composition/plugins.ts`、`service-tokens.ts` | 新服务在既有组合根注册，不在聊天服务里无序 new。 |
| 数据迁移 | `apps/server/src/db/migrations.ts` | 从 `db/migrations/` 读取排序后的 SQL 文件，逐个短事务执行。应追加 SQL，不重写旧迁移。 |
| 前端 | `apps/web/src/pages/CharacterGeneratorPage.tsx`、`CharacterEditorPage.tsx`、`CharacterImportPage.tsx`、`DeveloperPage.tsx` | 创建、编辑和观测的入口；具体修改需同步 API/共享合同。 |

特别重要：`mainGoal -> values[0].description` 是服务端显式赋值，不只是模型可能出现的偏差。修正它是生成阶段的首要任务之一。

## 3. 目标架构和责任边界

### 3.1 不重做现有领域内核

保留 Actor Queue、短事务、不可原地修改的已发布版本、领域事件、来源链、Fixture 和现实动作不自动执行等机制。它们解决的是实验一致性，不妨碍角色自然交流。

`packages/contracts` 放共享协议；`packages/features` 放不访问数据库、不调用模型的纯规则；`apps/server/src/services` 负责编排和模型调用；`repositories` 负责持久化。

### 3.2 新的回合逻辑顺序

以下是概念流程，不是可以直接粘贴替换的现有函数：

```text
重试命中已有 turn -> 原样 replay，不重复生成或学习
  否则：
角色队列 -> 必要生活推进
  -> 读取角色基线、人格 revision、memory revision、状态、关系
  -> 读取并保留近期原文
  -> 整理本轮交流意图与指代候选
  -> 解析当前回合的明确纠正（暂存，不提前分散落库）
  -> 构造检索查询并召回合法证据
  -> 选择可用于理解的背景和可明确提及的记忆
  -> 生成当前有效人格投影
  -> 为语言生成选择相关生活上下文
  -> 调用角色模型
  -> 使用同一画像 revision 校验/修复
  -> 验证模型提案和当前回合纠正
  -> 短事务提交消息、纠正、状态、关系、审计及待处理观察
  -> 发布失效通知
```

用于校验的生活事实快照与用于生成的相关生活片段分开。减少提示词中的人生困境，不能让服务端失去对决定、行动、结果的校验。

### 3.3 不在同一回合构造自证循环

本轮可以使用已经确认的当前纠正来避免继续说错，但“本轮助手刚生成了一段成长独白”不能马上被当成证明人格已成长的独立证据。持久人格学习优先在回合提交后、下一次显式整理时进行。

## 4. P0：基线与验收合同

### 修改或新增

- 修改 `README.md`：把“普通相处形成连续性”列为核心验收，决策作为专门场景。
- 新增 `docs/plans/Companion_Continuity_Implementation.md`：采用本指南的范围和阶段。
- 新增 `tests/fixtures/companion-continuity/`：人工编写固定剧本与预期事实，不混入正式用户库。
- 在现有开发者 trace 中增加 policy version、effective persona revision、检索查询来源、被丢弃上下文和更新理由。

### 最小场景集

1. 分享小事，不求建议。
2. 表达挫败，包含“为什么”，但没有要求分析。
3. 明确要求具体建议。
4. 明确委托决定，保留既有能力。
5. 同一件事隔多轮用“她”“那件事”接续。
6. 明确纠正一条旧事实。
7. 现在改变偏好，而不是否认过去偏好。
8. 同一用户只在某个话题要求少提建议。
9. 无核心矛盾、无明确目标的角色生成。
10. 相同事实、相反用户立场，检测迎合。
11. 状态变化但人格不改变。
12. 关系中出现有依据的局部学习。
13. 用户问过去某一时点的事实。
14. 重启、重试、回放和不同实验分支隔离。

### 固定实验条件

冻结角色基线、输入历史、模拟时钟、模型 profile、提示预算和策略版本。比较现版本、仅普通聊天改造、有效画像、开放局部学习等变体。真实模型存在随机性，保存所有尝试；不靠挑选最好的一次证明通过。Fixture 只证明机制，不证明自然度。

## 5. P1：记忆正确性，先写回归再改实现

### 5.1 自传语义校验

现状：`autobiography.ts/isGrounded` 共享一个词或中文双字片段即可返回 true。它最多是词面相关性判断，应保留为候选匹配或诊断指标，而不是最终“被证据支持”的判定。

先添加回归：

| 原始内容 | 不允许被提升成的事实 |
|---|---|
| 我没有辞职，只是考虑过。 | 用户已经辞职。 |
| 我不是不喜欢父亲，今天只是不想谈。 | 用户不喜欢父亲。 |
| 她说自己准备搬家。 | 用户准备搬家。 |
| 如果拿到录取，我就搬过去。 | 用户已经决定搬家。 |
| 今天我什么人都不想见。 | 用户不喜欢社交。 |
| 用户说“我已经通过面试”。 | 系统独立验证用户已通过面试。 |

建议新增纯模块 `packages/features/src/evidence-semantics.ts`：

- 验证引用是否属于指定消息及完整跨度。
- 识别明显的主语、否定、转述、条件和时间状态冲突。
- 输出 `supported | contradicted | insufficient`，不能把“不知道”强制分到真/假。
- 规则无法证明语义支持时，不靠继续追加正则制造虚假置信度。

服务层新增 `apps/server/src/services/evidence-validation-service.ts`，统一使用纯规则与可选语义评审。

对于确需抽象总结而确定性规则无法判断的内容，可使用独立的有界模型评审，输入只包含候选与原始证据。评审失败、超时或有矛盾时，回退到完整原文/保守报告或 needs_review，不阻止自然聊天，也不把未知内容升级为事实。模型评审不是绝对真理。

不要把异步模型调用直接塞进 `packages/features`，也不要放在 SQLite 事务里。`checkpoint-service.ts` 已有模型调用在事务外、提交前复查来源 hash 与 revision 的模式，沿用这种结构。

### 5.2 修复所有长期写入口

需要覆盖的不只是 memory candidate：

- `memory-service.ts` 的候选持久化链路。
- `autobiography-service.ts/prepareRevision`。
- `checkpoint-service.ts` 中由摘要生成事件卡的路径。
- 由生活与关系事件生成的长期记录。

复用 `MemoryNamespace`、`MemoryCertainty`、`MemoryAttribution`、`MemoryStability`，不要另造另一套同义 enum。新的语义验证结果及 validator version 可放在可审计元数据或侧表中。

### 5.3 防止截断改变意思

修改 `compactMemoryEvidence()`，并审查 `registry.ts`、`retrieved-evidence-segment.ts` 的最终预算行为：

- 不再把证据按前 N 个字符直接截断后当完整证据。
- 使用来源跨度、完整句群和必要的主语/否定/条件上下文。
- 预算不足时整条剔除，或使用已经独立校验的短摘要。
- JSON 段保持完整合法；不能字符串截掉半个对象。
- 日期、标识符和当前用户原文保留独立预算。
- 某段证据不完整时，不能支持依赖缺失部分的精确断言。

### 5.4 纠正必须失效整个派生链

现有 `superseded`、`supersededById`、`needs_review` 和 claim revision 可以复用，但要测试纠正是否传播到事件卡、自传和后续人格解释。

建议新增最小依赖关系表/索引，记录“哪个派生对象依赖哪个来源对象及版本”。不要只按 source message ID 粗暴作废整段历史：一个消息可以包含多个独立事实。

事务内：保存当前纠正与替代关系，递增 agent 的 memory revision，把受影响派生对象标记为需重验；当前事实检索立即排除失效投影。重建可以由显式整理入口执行，但失效保护不能等重建完成后才生效。

区分三种操作：

- **纠错**：旧信息本来就不成立。
- **变化**：旧信息过去成立，从当前时间起发生变化。
- **撤回推断**：事实没变，但系统不再采纳某个解释。

不要删除历史原文。时间查询仍可访问合法历史状态。已发送书信、不可变到达快照和审计产物保留当时记录；新增纠正说明，不偷偷改写历史产物。

### 验收

上述否定、条件、归属、知识变化场景都经过服务层真实写入/召回路径。断电或异常不能出现“新事实已经写入、旧派生仍被当当前事实”的半提交。证据不足可以继续共情，但不能编造“我记得你以前……”来填补。

## 6. P2：上下文检索与普通聊天

### 6.1 调整读取顺序

在 `ConversationService.chat()` 中，把 `listMessagesForContext()` 与 retention selection 移到检索之前。新建 `ConversationContextService` 的协作函数/服务负责整理回合上下文，不继续膨胀聊天编排器。

新增建议：

- `packages/contracts/src/conversation-context-plan.ts`
- `packages/features/src/conversation-context-plan.ts`
- `apps/server/src/services/conversation-context-plan-service.ts`

计划只决定检索与表达方式，不创建授权或事实。可表达：

- 当前是在分享、宣泄、求助、回顾、修复关系、闲聊，还是不确定。
- 明确求建议/明确要求详细分析的证据。
- 当前话题与代词可能对应的已知对象。
- 是否需要记忆、偏好的支持方式、是否适合提及角色生活。

不要每轮都执行一个昂贵的前置模型。第一版：明确指令走确定性规则；短期话题状态保留已确定的对象；确有指代歧义或复杂回顾时才执行一次有界语义规划。计划失败时回到原文查询和自然回应，不能伪造实体映射。

### 6.2 查询扩展不改变用户命令

检索保留三个输入：原文、扩展查询、扩展依据。

“她今天又那样了”可根据近期对话产生同事/姐姐两个候选，但不得在证据不足时选一个写入长期记忆。对授权和明确事实核验，继续用原始当前用户文本，不使用模型扩写后的查询作授权依据。

新增诊断：query policy version、originalQuery、expandedQueries、context message IDs、unresolved references、selected/rejected evidence、stale revision exclusion、token omission。

### 6.3 扩大召回要贯穿合同、实现和预算

依次修改：

1. `contracts/src/retrieval.ts` 的 `EvidenceBundleSchema` 和 selected ID 数组上限。
2. `memory-recall-service.ts` 的默认预算。
3. `memory-recall-hierarchy.ts` 的 bounded upper limit。
4. `features/src/memory-recall.ts` 的选取逻辑。
5. `prompt-assembler.ts/compactMemoryEvidence` 的 slice。
6. retrieval prompt segment 和 registry 的预算策略。
7. preview/replay 持久化的策略版本、审计与测试。

第一版建议配置：闲聊 0–2 条明确提及候选，普通延续 1–3 条，复杂回顾最多 8 条并受 token 总预算约束。数字是初始实验设置，不是研究结论；API 最大上限与每轮实际选择数量分开。

旧三条策略保留回放，不让新代码重新解释旧检索记录。新增策略名，例如 `continuity_context_v2`。先保留旧分层；跨层混合检索是可选后续 PR，不要同时重写全部排序与纠错算法。

### 6.4 语义检索是可选加法，不是首个基础设施项目

先修指代和完整证据。如果评测仍发现“有证据但同义表达召不回”，再增加 embedding 候选提供器，与当前关键词召回并行。

所有候选必须重新过 namespace、时间、归属、替代版本、来源完整性过滤。embedding 只帮助找到候选，不证明候选是真的。小规模可保留 SQLite 和本地缓存，不要求外置向量数据库；缓存绑定原文 hash、embedding 模型版本和 memory revision。

若采用 SQLite FTS5，要注意 trigram 的全文查询对少于 3 个 Unicode 字符的子串不能正常匹配；中文两字词仍需分词或已有 bigram 回退，不能以为切换 FTS5 自动解决中文检索。

### 6.5 “可用于理解”不等于“适合说出来”

新增纯选择函数 `selectMemoryUseForTurn`（建议文件 `packages/features/src/memory-use.ts`）：

- 背景信息：帮助理解指代和处境。
- 行为偏好：影响是否提建议、是否追问、如何称呼。
- 适合明确提及的共同经历：才允许自然回忆。

不是三套事实数据库，而是同一条合法证据在当前回合的三种使用权限。不要复制存储为互相矛盾的长期事实。只针对“明确提及”做话题相关性、近期重复与撤回偏好限制；过期或错误事实不能继续作为隐含背景使用。

### 6.6 让回复策略关注相处，而不只关注字数

`deriveReplyStrategy()` 接收回合计划；“为什么我总把事情搞砸”不应仅因“为什么”而自动要求复杂分析。保留明确详细请求的优先级。

普通闲聊允许 worldEffects 为空，不强制生成 support intervention、memory candidate、情绪改善或亲密增长。注意现有系统可能存在确定性的时间衰减/熟悉度变化，测试应检查“没有无证据的额外模型变化”，而不是要求所有状态前后完全相同。

既有 `listen_only`、`deliberate`、`recommend`、`delegated_decision` 可继续使用；闲聊不必强行选一个人生支持模式。明确委托的判定继续由原始证据和服务端规则控制。

### 验收

- 没有求建议时，不强行列步骤。
- 明确求建议时，仍能具体回应。
- 记得用户不爱被追问，表现为少追问，不是机械播报记忆。
- 歧义不被写成事实；新会话需合法证据，不能借旧会话原文绕过持久证据约束。
- 检索扩大后，正式提示词、审计记录和 replay 看到一致的候选范围。

## 7. P3A：角色生成去模板化

此阶段可以在 P1/P2 的基础工程进行时准备，但不要未测就发布全量行为改变。

### 7.1 创建输入

调整 `OriginalCharacterInputSchema`：

- `coreTraits` 不再要求恰好三个；允许少量行为描述，避免强迫作者贴三张标签。
- `coreContradiction`、`mainGoal` 对新创建流程可空或可省略。
- 继续支持旧请求格式，但“字段出现”不等于“必须作为终身规则”。
- 空字符串在输入边界规范化为未提供；不要往 schema 放空内容的假目标。
- 要求仍有足够的身份、生活或性格素材，避免所有信息都留空后由模型任意造人。

同步 `CharacterGeneratorPage.tsx`、API 类型、服务端校验、fixture、示例输入、E2E。目标 label 改为“目前在意/想做的事（可空）”；矛盾改为“最近拿不准的事情（可空）”，而不是默认隐藏值仍发送旧字段。

### 7.2 权威字段回填

修改 `applyOriginalFormAuthority()`：

- 只按字段语义保留作者原话；不要按数组首项推断“这就是作者目标/价值”。
- 删除 mainGoal 对 values[0] 的覆盖。
- 作者没提供目标/矛盾时，不创建 authorGoal/authorContradiction。
- 目标的作者来源不自动授权一条对应价值判断。
- 对规则使用稳定 ID/明确 source field mapping，而不是数组位置关联。
- 只把用户明确提供的内容标成 user_spec；推断和创作补充保持原有分级。

新增回归：真实 provider stub 返回“重视诚实”且 mainGoal 是“完成漫画”，权威回填后该价值仍是“重视诚实”，不被覆盖成“完成漫画”。

### 7.3 默认草稿与补全链

修改 `buildOriginalDraft()`：

- 不默认添加第二组普遍适用的矛盾。
- 不把目标写成价值观或自动写成人生解释。
- 未提供目标时 `goals=[]`，不补“先找到人生目标”作为伪目标。
- 未提供矛盾时 `contradictions=[]`。
- 不同角色不要共享大量被误标成作者事实的默认人生观。

`CharacterPersonaSchema.goals` 允许为空。对仍要求非空的其他字段，用有来源的基线或明确的待审创作补充，不以假作者事实凑 schema。

修改 `ensureTimeBasedGoalMilestones()`、`CharacterService` 中相关调用和默认里程碑构造：只有旧计划策略或作者明确提供计划时保留里程碑；新创建的普通愿望无需时间线。

### 7.4 编译提示词

用下列目标替代“至少两组矛盾”和“每个目标四到六个阶段”：

> 生成可发展的初始人物。区分已确认事实、稳定倾向、当前处境与暂定解释。没有足够依据时不生成核心矛盾；目标可空，不预设成长路线。通过具体关注与行为表现人物，不为普通偏好自动补充创伤原因。允许日常话题不激活任何人格冲突。记录支持倾向的证据，也记录例外；不把所有相反行为都解释成同一核心矛盾。

### 7.5 发布前行为检查

用普通场景、被反对、纠正误解、无目标闲聊测试生成结果。试聊隔离数据库、不进入正式记忆。固定语言和事件事实才是硬门；“每句话都表现性格标签”不应成为验收。

### 验收

端到端生成、编辑、发布、重启一个 `goals=[]`、`contradictions=[]` 的角色，不回填目标、不崩溃、仍能日常交流。已有旧角色正常读写和运行。

## 8. P3B：当前有效画像，不改写起始档案

### 8.1 最小持久模型

建议新增：

- `packages/contracts/src/persona-runtime.ts`
- `packages/features/src/persona-projection.ts`
- `apps/server/src/repositories/persona-runtime-repository.ts`
- `apps/server/src/services/persona-runtime-service.ts`

不要一次引入完整心理图谱。先支持三种可学习内容：

1. 对特定话题的理解（belief/interpretation）。
2. 对特定关系和话题的相处方式（relationship practice）。
3. 有证据的偏好变化（preference adaptation）。

全局 traits/values 数值自动重写暂不开启。

### 8.2 建议数据表

追加新的 SQL migration。确切编号由实施时现有 migration 列表决定，采用相同补零宽度；不编辑旧迁移内容。

| 表（新增建议） | 作用 | 最小字段 |
|---|---|---|
| `persona_runtime_heads` | 指向当前投影版本 | agent_id、base_character_version、revision、projection_json、memory_revision、updated_at |
| `persona_observations` | 持久化但尚未成为人格的观察 | id、agent_id、kind、content、scope_json、source_refs_json、status、dedupe_key |
| `persona_adaptations` | 已接受/已撤回的有限适应 | id、agent_id、target_kind、target_key、scope_json、content、effective_from、effective_to、revision、supersedes_id、status、source_refs_json |
| `persona_revision_events` | 追加式变更历史 | id、agent_id、from_revision、to_revision、operation_json、reason_code、evidence_root_ids_json、policy_version、idempotency_key |

已有审计/事件表可承担 revision events 的存储，不必强制再建一张同义表。独立新表需要明确的查询或约束收益。

至少添加 `(agent_id, revision)` 唯一约束和 `(agent_id, idempotency_key)` 唯一约束；关系范围 key 不使用 sessionId，否则新会话会“失忆”。当前项目有 LOCAL_USER_ID 可用于单用户关系 key；实验分支仍按数据库/实例隔离。

字段 JSON 入库前用 Zod 校验，DB 中加合适的 NOT NULL、CHECK 和唯一约束；数据库 ID、revision、权限和有效期由服务端生成或验证，不由模型决定。

### 8.3 投影规则

`buildEffectivePersona()` 的职责：

- 起始档案保持不可变。
- 合法的当前事实更新替代过期的“当前职业/住所”等描述，历史仍保留。
- 已接受适应仅覆盖其授权的 facet/scope。
- 未批准推断可作为低置信背景，但不能伪装成身份事实。
- 已撤回/证据失效/版本不匹配的适应不进入当前画像。
- 初始矛盾只在当前相关且仍有效时作为张力上下文；不永远常驻。

区分 authoring lock 与 evolution policy。现有 lockedPaths 用于编辑保护，不应不加审查地变成“人格永不可变化”的规则。生平事实通常禁止聊天自动改写；关系实践可局部更新；全局价值变更默认人工确认。导入原作事实保持原作来源，运行时发展记为本分支后续，不覆盖原作。

### 8.4 贯穿所有读路径

`ConversationService` 为本轮冻结有效画像 revision。以下路径必须拿到同一投影：

- `assembleChatPrompt`。
- `TurnDecisionService.decide` 和 `inspect`。
- `ReplyRepairService`。
- 世界效果校验中涉及人格/关系范围的部分。
- Fixture 路径和真实 provider 路径。
- 书信生成在对应快照时点的画像读取。

不要把有效投影伪装成新的已发布 CharacterSpec 写回。接口应显式区分 baseSpec 和 effectivePersona。

缓存 key 至少包括 agent、base character version、persona revision、memory revision、prompt policy version；需要时再加入关系/状态投影版本。当前 revision 不能只存在 DB 而旧缓存一直生效。

### 8.5 作者编辑与成长的合并

作者发布新基础版本时，用三方信息检查：旧 baseline、新 baseline、现有 adaptations。

未改变且 ID 可对应的 facet 可保留适应；作者显式锁定或修改的 facet 将适应标记为待重验；被删除的目标或人格规则不按数组下标错误绑定到新规则。不要悄悄抹去成长，也不要悄悄让成长覆盖作者新设定。

### 验收

同一个角色在不同情境有不同表达，但没有证据时 revision 不增加。新会话、重启、回复修复后都保持当前适应。旧基线不被修改。未来 revision 不污染已创建的书信快照或历史回放。

## 9. P3C：有限人格学习，先局部再全局

### 9.1 更新粒度

先支持：

- “用户谈工作挫折时倾向先听，不自动给建议”。
- “角色逐渐认为向这个用户寻求某类帮助不必失去自主”。
- “角色最近对某项兴趣的偏好发生变化”。

不支持第一版自动提交：

- 修改出生、童年、已确定的历史事件。
- 一句鼓励后降低全局“独立性”，或提高“对所有人的信任”。
- 把用户“你就是这样的人”的评价作为作者修改权限。
- 让助手自己的成长独白成为唯一证据。

### 9.2 模型提案与正式记录分离

模型只提出内容、范围提示和当前提供证据中的引用。不输出数据库 revision、不输出任意 JSON Patch、不决定最终授权。

建议使用有界候选类别，而非可以改 `identity.*` 的路径 DSL。服务端绑定合法目标和 source refs；由规则判断是否允许该类别/范围更新。

### 9.3 生命周期

```text
观察 captured
  -> 待证据 candidate
  -> 可提交 eligible
  -> accepted / rejected / needs_review
accepted
  -> 被后续适应替代 superseded
  -> 因证据纠正被撤回 retracted
```

这只是实现的概念状态。持久 enum 可缩减，不要为展示状态添加不必要表。

明确相处偏好可以立即、局部生效；全局心理判断门槛高。不要强制“积累固定十次才允许所有变化”。证据独立性按根事件或原始消息去重，不能把同一个事件的聊天、自传、事件卡、书信当成四次独立经历。

### 9.4 整理触发

第一版建议在明确“整理记忆”入口或现有 checkpoint 成功后触发有界候选审查。不要每轮重写整个人格；不要在 checkpoint 未通过时照样学习。

checkpoint 是运行机会，不是人格必须变化的原因。没有新证据就没有新 revision。离线关闭期间不宣称模型在持续思考；无 worker 时未执行任务就是未执行。

### 9.5 并发与事务

事务外读取快照并生成 proposal；提交时在角色队列/短事务中重新检查：

- base_character_version 未变化。
- persona revision 与预期一致。
- memory revision 与引用 source hash 有效。
- 幂等键未提交。
- scope 没有被作者锁定或当前纠正否定。

不一致就丢弃候选或重新评估，不覆盖最新数据。角色聊天原有队列继续保持；后续优化长模型调用锁占用时，先补 revision 栅栏，不能直接去掉串行化。

### 验收

- 改变对用户的某种相处方式，不改变对所有人的性格。
- 拒绝证据失效的修订。
- 同一个事件重复整理不会强化两次。
- 回放不会产生新的观察或成长。
- 低落状态恢复不产生人格 revision。
- 改变可以暂停、撤回、细化，不预设越来越外向、温柔或依恋。

## 10. P4：生活主线去剧本化

### 10.1 先减少曝光，再改推进

先新增纯函数 `selectLifeContextForTurn`（建议文件 `packages/features/src/life-context-selection.ts`）。输入是服务器完整生活快照和本轮计划，输出是生成所需片段。

普通闲聊可以不带目标、决策史或困境；明确询问近况时取相关生活事实。校验仍接收其必要的完整因果快照，不能因为模型没看到某记录就允许违背它。

### 10.2 按主线版本区分推进策略

旧 fuzzy 的自然日里程碑要保留可回放性。新主线可引入：

- `legacy_calendar_v1`：保留旧冻结计划语义。
- `evidence_driven_v2`：意愿、投入、停滞、改向、放弃或完成由合法事件和当前处境推进。

这是建议的主线策略，不替代 `fuzzy` / `legacy_exact` 的全局生活模式。

修改 `fuzzy-life-planning.ts`、`fuzzy-life-service.ts`、`life` 相关合同和仓储。`lifeThreadStagesAdvanceByCharacterLocalDate: true` 这样的上下文声明也要按策略更新，不能逻辑变了而提示仍声称按日期推进。

不要求立刻模拟复杂社会。先允许新角色没有目标、已有目标暂停、没有事件时保持阶段，以及有证据时改向。

### 10.3 防止目标复活

检查 `ensureGoalThreads`：它的职责应是幂等初始化，不能因 baseline 仍有某个目标，就把已经放弃的运行时主线重新创建。增加永久去重/终态记录。没有目标时，日常生活由普通习惯和处境提供，不补一个“寻找目标”的假目标。

### 10.4 虚构事件不等于幻觉

保留 `origin=simulation` 的受控角色世界事件；不要禁止角色世界里发生任何新事。新事件需要世界内来源和提交记录，且不声称用户在现实中做了什么。

目标是少一些没有依据的重大转折，而不是让角色除了用户输入之外什么都不能经历。

### 验收

FakeClock 推进多天不会仅因时间过去而宣称用户已行动或已经成功；旧冻结时间线可回放；无目标角色能启动；暂停/放弃目标不复活；角色生活有变化但不每轮主动汇报。

## 11. 导入角色的增量改善（在生成闭环稳定后）

`CharacterService.import()` 当前保存的是有限 contentExcerpt；编译读取也有有界摘录策略。旧资料没有存全，就不能靠升级代码补回原文。

建议新增原文内容寻址存储和 scene/source chunk 索引，保留作品、角色、时间范围、发言者、位置偏移与来源 hash。检索行为例证，而不只检索人格摘要。场景中的反例同样重要。

原创作者 brief 与导入原作 evidence 使用不同来源权限；补充情节标为本实验分支发展，不能伪装原作事实。旧角色需重新导入完整素材才能建立完整索引，不自动从公开网络补全为“作者提供”。

## 12. 发布、迁移与回滚

### 12.1 开关

以下是建议新增，不是当前已有环境变量：

```dotenv
COMPANION_CONTEXT_MODE=off
PERSONA_RUNTIME_MODE=off
```

它们可采用 `off | shadow | enforced`。编译器另保存明确的 compilation policy version，不需要给每个细节加环境变量。既有 `MEMORY_RECALL_MODE=enforced` 等事实保护不要因为新实验关闭。

- off：不应用新投影和新候选。
- shadow：运行候选和诊断，不改变正式回复输入或权威人格。
- enforced：应用通过验证的投影和更新。

shadow 仍可能有模型成本；只有显式开启的付费实验才能调用真实模型。普通 CI 的 shadow 使用 Fixture。

### 12.2 数据迁移步骤

1. 使用已有备份路径制作数据库快照，在副本验证恢复。
2. 追加 SQL：新侧表、索引与必要 revision。旧 CharacterSpec JSON 不自动改写。
3. 从已有基线初始化空的人格运行时 revision 0；不得自动把旧摘要全都升级成适应。
4. 扫描旧记忆与派生对象：缺少新验证的条目标为待重验，不能一律删除或全部认定为已通过。
5. 旧 checkpoint/旧回放保持旧 policy；新评测显式采用新 policy。
6. 先对一个隔离角色开启 shadow，再对实验副本 enforced。
7. 新数据模型完全验证后再用于你们日常实例。

当前迁移器按文件名字典序执行。沿用相同编号格式，不插入重复或位于已执行序列之前的迁移。

### 12.3 回滚区别

- **功能回滚**：关闭新策略，停用新适应，仍使用兼容新 schema 的当前程序，保留审计。
- **数据回滚**：恢复同一时点备份，接受备份之后的新记录需要另行处理。
- **程序降级**：不保证旧二进制能读取新 schema/新严格 JSON，不能仅靠开关假定兼容。

即使关闭动态人格，也不能重新启用已被证明错误的记忆或失效摘要。真实性修复不随体验开关撤回。

## 13. 测试矩阵与执行方式

### 13.1 三层验收

**纯规则测试**：来源完整性、否定条件、scope、投影、幂等、预算。

**服务/HTTP 集成测试**：真实路径写入、纠正失效传播、发布、重启、新会话、返回 repair、异常中断、并发 revision 冲突。

**真实语义验收**：自然度、建议是否抢先、角色是否借题展示矛盾、是否只会迎合、更新是否局部且合理。人工记录原句，不用一个自动总分替代审阅。

### 13.2 建议新增测试文件

这些文件均为实施建议，创建后才能加入命令：

```text
packages/features/src/evidence-semantics.test.ts
packages/features/src/memory-use.test.ts
packages/features/src/conversation-context-plan.test.ts
packages/features/src/persona-projection.test.ts
packages/features/src/life-context-selection.test.ts
apps/server/src/services/memory-correction-propagation.integration.test.ts
apps/server/src/services/character-generation-v2.integration.test.ts
apps/server/src/services/effective-persona-pipeline.integration.test.ts
apps/server/src/services/persona-runtime.integration.test.ts
apps/server/src/services/companion-context.integration.test.ts
apps/server/src/db/persona-runtime-migration.test.ts
```

复用现有 `prompt-assembler.test.ts`、`reply-strategy.test.ts`、`autobiography.test.ts` 和状态/长测入口；不要把全部新测试塞进旧巨型 integration 文件。

### 13.3 当前仓库已有的基础命令

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
pnpm test:dual-model:fixture --turns 3
```

这些命令来自当前 package.json。执行前先配置隔离数据库；build 或 E2E 的具体环境依赖按 README。没有在本次审查中实际执行。

### 13.4 建议新增脚本

```text
test:companion:unit
test:companion:integration
test:companion:fixture
test:companion:real
```

实现脚本后再运行；真实入口使用现有显式付费许可方式，禁止普通 test/CI 间接调用网络或收费模型。

### 13.5 关键指标

硬门：事实翻转、来源归属错误、跨角色/分支串线、重复成长、历史改写、错误授权必须在固定回归中为零。这是回归目标，不是对所有未来输出的数学保证。

语义观测：不必要建议率、强行提目标/核心矛盾次数、记忆应用是否合时宜、角色识别度、局部变化是否被后续保持。先统计当前基线，再设合理改进目标，不预先编造“提高 30%”之类收益。

效率：每轮模型物理调用数、输入 token、端到端延迟、repair 比例、checkpoint 成本、重试与失败原因。普通短聊天不应因动态人格被迫串行调用多个额外大模型。

## 14. 建议 PR 拆分与依赖

| PR | 范围 | 合并门槛 |
|---|---|---|
| PR-0 | 场景、诊断字段、基线记录 | 不改变正式聊天行为。 |
| PR-1 | 自传/记忆语义与完整证据 | 固定反例经过真实持久路径。 |
| PR-2 | 纠正与派生失效 | 当前和历史查询各自正确，重启有效。 |
| PR-3 | 上下文检索、使用策略、普通回复 | 无请求不强行建议，明确请求不退化。 |
| PR-4 | 生成去模板化、权威回填、无目标兼容 | 新生成完整链路和旧数据都通过。 |
| PR-5 | 人格运行时侧表、有效画像、全读路径一致 | 只支持受控/人工种入适应，先证明投影正确。 |
| PR-6 | 局部学习 shadow 到 enforced | 引用、scope、撤销、幂等、revision 冲突通过。 |
| PR-7 | 生活上下文选择与新推进策略 | 不破坏旧 timeline、行动结果事实链。 |
| PR-8（可选） | 导入原文/场景证据检索、语义候选 | 在真实失败样例上证明增益。 |

依赖主线：PR-0 -> PR-1 -> PR-2 -> PR-3；PR-4 可在基线测试明确后独立开发；PR-5 需要 PR-2 和 PR-4；PR-6 需要 PR-3 和 PR-5；PR-7 在稳定画像接口之后。

两个人可以按所有权分工：一人负责记忆、纠正和回放，一人负责生成、有效画像和普通聊天策略。共享合同先约定，避免两人同时重写 `ConversationService`。双方都要人工阅读对方模块生成的长程对话。

## 15. 第一个可交付闭环

用下面一条跨会话轨迹判断系统是否已经向产品目标前进：

```text
创建没有强制核心矛盾、没有预设里程碑的角色
 -> 分享一件普通小事，角色不把它变成人生选择
 -> 说明“我谈工作烦恼时，先听我说，不急着建议”
 -> 新会话再次分享类似事情
 -> 角色自然调整交流方式，不机械背诵偏好
 -> 用户纠正一次系统的错误理解
 -> 旧摘要和旧人格解释不再继续起作用
 -> 角色仍保持自己的基本立场
 -> 重启之后以上状态依然正确
```

这条轨迹比先增加更多矛盾、目标类型或成长数值更接近当前产品缺口。

## 来源与定位说明

所有仓库定位基于同一提交。下列固定版本链接用于开发时直接核查：

- https://github.com/p1nkp1nkdrag0n/ChatPLUS/tree/dc51b5cba3dee574c86ba4bd58337c93b2d8b555
- https://github.com/p1nkp1nkdrag0n/ChatPLUS/blob/dc51b5cba3dee574c86ba4bd58337c93b2d8b555/packages/contracts/src/character.ts
- https://github.com/p1nkp1nkdrag0n/ChatPLUS/blob/dc51b5cba3dee574c86ba4bd58337c93b2d8b555/apps/server/src/services/character-compiler.ts
- https://github.com/p1nkp1nkdrag0n/ChatPLUS/blob/dc51b5cba3dee574c86ba4bd58337c93b2d8b555/apps/server/src/domain/defaults.ts
- https://github.com/p1nkp1nkdrag0n/ChatPLUS/blob/dc51b5cba3dee574c86ba4bd58337c93b2d8b555/apps/server/src/services/character-clock.ts
- https://github.com/p1nkp1nkdrag0n/ChatPLUS/blob/dc51b5cba3dee574c86ba4bd58337c93b2d8b555/apps/server/src/services/conversation-service.ts
- https://github.com/p1nkp1nkdrag0n/ChatPLUS/blob/dc51b5cba3dee574c86ba4bd58337c93b2d8b555/packages/features/src/autobiography.ts
- https://github.com/p1nkp1nkdrag0n/ChatPLUS/blob/dc51b5cba3dee574c86ba4bd58337c93b2d8b555/apps/server/src/services/checkpoint-service.ts
- https://github.com/p1nkp1nkdrag0n/ChatPLUS/blob/dc51b5cba3dee574c86ba4bd58337c93b2d8b555/packages/contracts/src/memory.ts
- https://github.com/p1nkp1nkdrag0n/ChatPLUS/blob/dc51b5cba3dee574c86ba4bd58337c93b2d8b555/packages/contracts/src/retrieval.ts
- https://github.com/p1nkp1nkdrag0n/ChatPLUS/blob/dc51b5cba3dee574c86ba4bd58337c93b2d8b555/packages/features/src/prompt-assembler.ts
- https://github.com/p1nkp1nkdrag0n/ChatPLUS/blob/dc51b5cba3dee574c86ba4bd58337c93b2d8b555/apps/server/src/services/fuzzy-life-service.ts
- https://github.com/p1nkp1nkdrag0n/ChatPLUS/blob/dc51b5cba3dee574c86ba4bd58337c93b2d8b555/apps/server/src/db/migrations.ts
- https://github.com/p1nkp1nkdrag0n/ChatPLUS/blob/dc51b5cba3dee574c86ba4bd58337c93b2d8b555/package.json

SQLite 官方 FTS5 文档（trigram 限制）：https://www.sqlite.org/fts5.html

未通过新增真实实验验证的实现收益，在本文中均作为设计目标，而不是已证实结论。
