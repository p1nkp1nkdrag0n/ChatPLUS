# ChatPLUS 大语言模型驱动角色状态使用与变化闭环修改计划（Codex）

> 文档性质：以 README 核心目标为唯一产品方向的代码修改与功能验证计划。
>
> 制定日期：2026-08-28
>
> 选定历史基线：`7082ee21296ebb1e458457921c7631f8d7687971`（tag：`v0.1.1-preview`）
>
> 基线提交说明：`test(acceptance): validate semantic cross-session recall`
>
> 当前对照版本：`0841c11`，分支 `codex/v4-companion-first-eval-20260826`
>
> 建议实施分支：`codex/llm-state-closed-loop-20260828`
>
> 当前执行状态：已从选定基线创建独立 worktree/分支，WP0 基线与 characterization 已完成；尚未执行真实 DeepSeek 调用。

---

## 0. 本轮结论与方向锁定

本轮不再以“回复权限、替用户做决定、隐私边界、第三方关系、商业发布门槛”作为项目主线。

本轮只实现并验证 README 中已经定义的 PersonaSim 核心：

> **时间会推进，互动有后果，关系会积累，变化可追溯。**

产品范围固定为：

- 一个本地运行、单机、单用户的 AI 角色生活与对话 Demo；
- 对话参与者只有用户与角色；
- 角色有自己的状态、日程、记忆和生活进程；
- 对话可以影响角色，但角色不是任务型人工智能助手；
- 重点验证大语言模型能否读取状态、在回复中使用状态、提出合理变化，并在后续对话中延续变化；
- 服务端继续拥有最终数据写入权，LLM 只能提交 proposal。

本计划继承以下历史设计：

- `README.md` 的项目定义和四条核心准则；
- `docs/plans/ChatPLUS_PersonaSim_Integrated_Upgrade_Plan_v2.md` 中的：
  - P0-16：Live State / Relationship 闭环；
  - P0-17：Reply Strategy 感知状态；
  - 7.7：State / Relationship 测试要求；
  - 21：North Star 验收链。

后续 V3/V4 文档只可作为历史问题记录，不是本轮需求来源。其隐私、决策权限、人工盲审、商业发布和大规模 release gate 不进入本计划。

---

## 1. 历史版本选择

### 1.1 选定版本

实际修改基线固定为：

```text
7082ee21296ebb1e458457921c7631f8d7687971
tag: v0.1.1-preview
test(acceptance): validate semantic cross-session recall
```

这个版本已经具备：

- RuntimeState 与 RelationshipState；
- 日程、活动结算、FakeClock 与离线追赶；
- personal intent、self planning 与 personal life；
- 记忆提取、召回和跨会话连续性；
- 单阶段 canonical chat envelope；
- LLM 回复、`stateDelta`、`relationshipDelta` 和服务端校验/限幅/持久化路径；
- 真实 DeepSeek HTTP acceptance 脚本；
- 30 天默认策略模拟与跨会话召回测试；
- SQLite、事务、幂等和领域事件基础。

它能支撑本轮工作，不需要重新搭建角色生活、状态、记忆或日程系统。

### 1.2 历史分界

```text
7082ee2  ← 本轮选择：完整核心，结构仍可控
   │
   └── 9bdac63  长跑快照；单提交新增约 5.4 万行，加入拆分管线和大量报告/约束
          │
          └── 0040f5a  structured turn response policy 起点
                 │
                 └── 后续 interaction / permission / privacy / release-gate 主线
```

### 1.3 候选比较

| 候选                         | 已有能力                                    | 不选或选择原因                                                                     |
| ---------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------- |
| `4ede0f0` / `v0.1.0-preview` | 基础角色、状态、关系、记忆和日程            | 太早，缺少 personal-life、personal-intent 和 self-planning                         |
| `c059ddc`                    | PersonaSim 综合升级基本完成                 | 可作备用点，但缺少之后 16 个与真实 DeepSeek、模型效果、记忆、规划和结算相关的修复  |
| `7082ee2` / `v0.1.1-preview` | README 核心完整，真实模型和连续性验证已存在 | **选择；功能足够，复杂度仍可控**                                                   |
| `9bdac63`                    | 增强长跑、拆分理解/回复/执行管线            | 不选；相对 `7082ee2` 单次新增约 54,702 行，并加入普通对话状态/关系的关键词资格门控 |
| 当前 `0841c11`               | 大量回复策略、盲审和 release 资产           | 不选；距离 README 核心过远，直接删减比从稳定核心向前修更难验证                     |

### 1.4 为什么不为了“代码更近”选择 `9bdac63`

`9bdac63` 虽然距离当前版本更近，但它把原有的单阶段对话闭环拆成 understanding、reply generation、execution 等多段，并增加：

- 7,312 行的 companion long-run runner；
- 2,516 行的 reply-generation service；
- 1,576 行的 turn-execution service；
- 1,080 行的 evidence-only grounding；
- 大量报告、适配器、回复约束和长跑回归；
- 基于消息关键词判断 state/relationship delta 是否有资格生效的门控。

本轮要验证的是 LLM 能否自然使用并改变状态。先继承这些机制，再逐项拆除，既增加工作量，也会继续把“测试框架正确”误当成“角色状态闭环正确”。

### 1.5 后续提交的使用规则

- 不整体 cherry-pick `9bdac63` 或任何 V3/V4 提交；
- 不按文件夹整体复制后续 turn policy、permission 或 release 代码；
- 只有当本计划中的某个核心测试先稳定复现问题，并且后续某个小修复直接解决同一问题时，才允许按独立 commit 或最小 hunk 选择性移植；
- 每次选择性移植必须补充与 README 核心目标直接对应的测试。

---

## 2. 工作树与分支保护

当前工作树包含未提交修改，不能在当前目录执行历史回退。

实施时采用独立 worktree：

```text
source commit: 7082ee21296ebb1e458457921c7631f8d7687971
new branch:    codex/llm-state-closed-loop-20260828
new worktree:  E:\2026\ChatPLUS-state-closed-loop-20260828
```

执行规则：

- 不在当前工作树使用 `git reset --hard`；
- 不在当前工作树使用 `git checkout -- <path>`；
- 不批量 revert 当前 81 个后续提交；
- 当前分支、盲审产物、真实 DeepSeek 记录和未提交改动全部保留，作为历史证据；
- 新 worktree 建立后，先把本计划作为该分支的第一个文档提交，再开始代码修改；
- 未获得用户明确要求前，不删除当前分支或旧 worktree。

---

## 3. 本轮目标与非目标

### 3.1 功能目标

本轮必须闭合以下链路：

```text
权威 pre-state / relationship
→ 注入当前对话 Prompt
→ LLM 生成自然回复，并提交隐藏的 worldEffects proposal
→ schema 校验、证据检查、capability 缩放和数值限幅
→ 与消息在同一事务中持久化
→ 生成包含前后值和原因的 trace
→ 下一轮读取 post-state
→ 回复和后续生活行为体现已经发生的变化
```

最终需要证明五件事：

1. 角色状态确实被提供给模型，而不是只存在数据库里；
2. 相同角色面对相同输入时，不同状态能导致可解释的表达或行为差异；
3. 对话和生活事件能产生小幅、合理、可限幅的状态变化；
4. 状态和关系变化真正落库，重启与下一轮仍可见；
5. 每次变化都能追溯到用户消息、角色回复或活动结算事件。

### 3.2 明确非目标

本轮不做：

- 第三方人物、共同社交圈、群聊或多角色关系图；
- 第三方隐私规则、隐私测试矩阵或隐私拒绝话术；
- “角色是否可以替用户决定”的 permission ceiling；
- 任务助手式的目标分解、日程代办或用户决策编排；
- 多请求一句话的助手能力测试；
- 商业发布、账户、权限、云同步、合规或正式 release gate；
- 新一轮真人盲审或 `3×30` 大规模人评；
- 为开放域回复增加大批关键词正则、拒绝模板或安全策略编译器；
- 重写现有日程、记忆、主动消息和 UI；
- 新建完整连续生理模型；
- 无依据新增状态字段。

日程和共同活动只在它们是“用户与角色直接对话造成的生活后果”时进入本轮，不扩展到不存在的第三方世界。

---

## 4. `7082ee2` 的事实基线

### 4.1 已有 RuntimeState

| 变量                |      范围 | 现有主要来源                 | 现有主要消费者                   | 本轮处理                                        |
| ------------------- | --------: | ---------------------------- | -------------------------------- | ----------------------------------------------- |
| `moodValence`       |  `[-1,1]` | 对话 proposal、活动结算      | Prompt                           | 增加定性描述与状态对照验证                      |
| `moodArousal`       |   `[0,1]` | 对话 proposal、活动结算      | Prompt                           | 映射到表达节奏和活跃程度，但不强制固定措辞      |
| `energy`            |   `[0,1]` | 对话 proposal、睡眠/活动     | Prompt、Reply Strategy、自主计划 | 验证低/高精力下回复和生活选择差异               |
| `stress`            |   `[0,1]` | 对话 proposal、活动完成/跳过 | Prompt、Reply Strategy、自主计划 | 验证高压状态对表达、活动完成概率的影响          |
| `socialBattery`     |   `[0,1]` | 对话 proposal、社交活动      | Prompt、Reply Strategy、自主计划 | 验证主动程度与回复长度倾向                      |
| `focus`             |   `[0,1]` | 对话 proposal、工作/学习活动 | Prompt、自主计划                 | 验证话题维持与活动选择                          |
| `sleepDebtMinutes`  | `[0,720]` | 自主计划、睡眠结算           | Prompt、Reply Strategy、自主计划 | 修正发生时机并验证跨日延续                      |
| `currentActivityId` |      可选 | 活动结算                     | Prompt、角色当前生活事实         | 验证当前活动与回复陈述一致                      |
| `locationContext`   |  可选文本 | 当前没有可靠生产写入         | Prompt                           | 本轮先标为 `context-only`；不得由模型无依据写入 |
| `asOfUtc`           |       UTC | 对话/结算                    | 并发与时序                       | 验证时间单调与重启一致性                        |
| `revision`          |  非负整数 | 每次状态提交                 | 幂等、并发、SSE                  | 保证每个有效原因最多递增一次                    |

### 4.2 已有关系状态

| 变量                       | 默认值 | 当前问题                       | 本轮目标                                                                    |
| -------------------------- | -----: | ------------------------------ | --------------------------------------------------------------------------- |
| `closeness`                | `0.55` | 默认已经像熟人，难验证缓慢建立 | 保留角色可配置；默认新角色改为较低的“初识”预设，确切数值通过离线场景校准    |
| `trust`                    | `0.60` | 初始信任偏高                   | 不按每轮固定增长，只在有语义依据时小幅变化                                  |
| `familiarity`              | `0.40` | 普通无 delta 聊天不会积累      | 每次成功、非 replay 的有效互动产生极小基础积累，再叠加有依据的模型 proposal |
| `recentInteractionValence` |    `0` | 只累加、不随时间回落           | 改为短期信号，在后续互动或时间结算中逐步回归 0                              |
| `lastInteractionAtUtc`     |     无 | 只有发生数值 delta 时更新      | 每次成功、非 replay 的用户—角色回合都更新                                   |

### 4.3 已有对话闭环

`7082ee2` 已经采用单阶段 canonical envelope：模型一次生成角色回复和隐藏 world effects，服务端再校验、限幅和提交。

保留该结构，原因是它已经足以验证 README 目标。第一阶段不增加独立分类器，也不拆成 understanding / reply / execution 三次职责。

只有真实 DeepSeek 对照证据表明“结构化 sidecar 明显损害自然回复”时，才另立实验比较两阶段方案；不能预先为了架构完整而拆分。

### 4.4 已确认缺口

基线中必须正面处理的缺口：

- `LIVE_WORLD_EFFECTS` 默认是 `shadow`，真实模型可以提出 delta，但默认不落库；
- `SELF_INITIATED_PLANNING` 默认是 `off`，角色自己的生活闭环默认不运行；
- Prompt 已包含状态数值，但没有为全部字段提供稳定、自然、可验证的行为语义；
- Reply Strategy 主要消费 `energy`、`stress`、`socialBattery` 和睡眠债，其他字段的实际影响难以证明；
- 普通聊天只有在模型给出任意数值效果时才获得默认 familiarity 增量；
- `lastInteractionAtUtc` 也依赖数值效果，不代表真实互动时间；
- 活动结算只改变 RuntimeState，不会让用户—角色共同经历自然影响关系；
- 离线批结算用批次起始状态计算所有活动，前一活动结果不会影响后一活动完成概率；
- 多个活动的 delta 先聚合再整体限幅，长时间离线可能丢失逐事件因果；
- 睡眠债可能在未来计划生成时提前增加，而不是在睡眠事实发生后结算；
- `conversation.world_effects_committed` 事件只记录“是否有 delta”，没有完整记录 proposed / accepted / applied / before / after；
- `locationContext` 等字段存在，但没有可证明的生产写入与消费闭环。

### 4.5 必须保留的完整性边界

这些不是商业产品扩展，而是状态模拟正确性所必需：

- Zod/schema 校验；
- 数值范围和单轮 delta 限幅；
- capability profile 的缩放；
- SQLite 事务；
- 同一角色串行化；
- client message idempotency；
- state revision 与时间单调；
- LLM 不能直接生成数据库 ID 或绕过服务端写入；
- 失败时消息、状态、关系和 trace 一起回滚。

---

## 5. 目标行为原则

### 5.1 状态必须影响角色，但不能变成台词模板

状态影响的是倾向，不是固定文案：

- 低 energy 可以更短、更慢、更少主动扩展，但不必每次说“我很累”；
- 高 stress 可以更紧绷或更难集中，但不能强制输出同一焦虑词；
- 低 socialBattery 可以减少连续追问，但不能机械拒绝聊天；
- 高 focus 可以更稳定地维持当前话题；
- moodValence 与 moodArousal 共同影响情绪色彩与表达活跃度；
- sleep debt 可以影响精力、回复节奏和后续自主活动选择；
- relationship 影响熟悉程度、称呼和交流松弛度，但不能变成数值养成提示。

测试只断言“状态被使用且语义一致”，不锁定一句固定回复。

### 5.2 关系积累由两层组成

关系变化分为：

1. 服务端确定性基础层：
   - 每个成功、非 replay 的用户—角色回合更新 `lastInteractionAtUtc`；
   - 每个有效回合产生极小 familiarity 增量；
   - 增量受 capability profile 缩放和每日上限约束。

2. LLM 语义 proposal 层：
   - closeness、trust 和 valence 只在本轮语义确实支持时变化；
   - 变化必须小幅并由服务端限幅；
   - 不要求命中特定关键词才允许所有关系变化；
   - 不因普通寒暄自动大幅增加 closeness 或 trust。

精确增量与每日上限不在计划文档中拍脑袋固定，先用确定性 1、10、30、100 回合模拟校准，再写入常量与测试。

### 5.3 时间变化仍然采用事件驱动

本轮继续采用 PersonaSim 原本的事件驱动语义：

- 活动开始、完成、部分完成、跳过会产生状态后果；
- 应用关闭期间不运行后台 LLM；
- 重开时按持久化 cursor 追赶；
- 每个结算事件按时间顺序作用于当时状态；
- 前一事件形成的状态可以影响后一事件的完成概率；
- 对话前读取的是结算完成后的权威状态。

本轮不先添加按分钟连续衰减的复杂生理模型。只有事件驱动闭环完成后，仍无法形成可观察的生活连续性，才另行评估最小的被动恢复/衰减规则。

### 5.4 共同活动只描述用户与角色

用户直接邀请角色并形成共同活动时：

- 日程变化仍由服务端验证并持久化；
- 只有活动真正完成或部分完成后才产生状态和关系后果；
- 取消或跳过产生不同后果；
- 后果可以进入后续对话记忆；
- 不推导第三方参与者、共同朋友圈或外部社交事实。

---

## 6. WP0：建立独立基线与 characterization

### 目标

在不改变行为前，证明 `7082ee2` 的真实起点，并保护当前工作成果。

### 工作

1. 从 `7082ee2` 创建独立 worktree 和分支；
2. 记录 Node、pnpm、SQLite migration 与环境变量；
3. 运行基线：
   - `pnpm typecheck`；
   - `pnpm lint`；
   - `pnpm test`；
   - `pnpm build`；
4. 新增不改变生产行为的 characterization tests，证明：
   - shadow world effects 不写 RuntimeState；
   - enforced world effects 会写 RuntimeState；
   - self planning 默认不运行；
   - 普通无 delta 回合不更新关系时间；
   - 活动结算读取批次起始状态；
   - world-effects audit 目前只有布尔摘要；
5. 保存基线测试报告，不执行真实 DeepSeek。

### 完成条件

- 新旧工作树完全隔离；
- 基线所有测试结果可重复；
- 每个已确认缺口至少有一个失败或 characterization 证据；
- WP0 不改变任何状态公式。

---

## 7. WP1：让默认本地 Demo 真正运行状态闭环

### 目标

用户按 README 启动本地 Demo 时，核心能力不是 shadow 或 off。

### 工作

1. 明确并实现本地 Demo 的权威配置：
   - `LIVE_WORLD_EFFECTS=enforced`；
   - `SELF_INITIATED_PLANNING=enforced`；
   - fixture 和 test profile 可显式覆盖；
2. 更新 `.env.example` 和 README，避免“代码支持、默认不运行”；
3. 启动时打印一次简短模式摘要；
4. 不新增 rollout dashboard 或商业 feature flag 系统；
5. 验证真实 Provider 与 fixture 走相同的服务端提交规则，不允许 fixture 假装成功而真实 Provider 仍在 shadow。

### 设计约束

- 核心默认值应由代码和 README 一致定义；
- 本地 `.env` 只负责密钥和显式实验覆盖；
- 不要求用户理解 legacy/shadow/enforced 才能体验核心功能。

---

## 8. WP2：状态读取与自然回复影响

### 目标

证明模型不仅“看到了数字”，而是能在回复中自然使用角色当前状态。

### 工作

1. 保留 authoritative RuntimeState、relationship、当前活动和最近已结算事实；
2. 在 Prompt 中同时提供：
   - 精确值，供结构化 proposal 使用；
   - 稳定的定性描述，供自然语言表达使用；
   - `asOfUtc` 与 revision，供 trace 使用；
3. 为现有状态字段定义倾向语义，不增加固定台词；
4. 扩充 Reply Strategy，使 mood、arousal、focus 和 sleep debt 有可验证的消费路径；
5. 确保动态状态只作为当前上下文，不被错误固化成人格事实或长期记忆；
6. 为同一输入构造对照状态：
   - 高 energy / 低 stress 对低 energy / 高 stress；
   - 正向低 arousal 对负向高 arousal；
   - 高 focus 对低 focus；
   - 高 socialBattery 对低 socialBattery；
7. 断言回复策略、语义或行为倾向不同，不断言固定词面。

### 禁止做法

- 不用大批关键词判断模型是否“像累了”；
- 不强迫模型逐项复述状态；
- 不把状态 JSON 直接暴露在角色回复中；
- 不为每个状态单独增加一次 LLM 调用。

---

## 9. WP3：对话状态变化、事务提交与下一轮读取

### 目标

让合法的 LLM state proposal 成为可持久化、可重放、可追溯的角色经历。

### 工作

1. 保留单阶段 canonical envelope：
   - `replyDecision`；
   - `worldEffects.stateDelta`；
   - `worldEffects.relationshipDelta`；
   - 必要的 memory / personal intent candidates；
2. 服务端依次执行：
   - schema parse；
   - 删除服务端专属字段；
   - 单轮 delta 限幅；
   - capability 缩放；
   - 基于当前 state 计算 post-state；
   - 在一笔事务中提交消息、状态、关系和 trace；
3. 修复 repair/fallback 路径：
   - 回复文字修复不能无故丢失已经验证的 world effects；
   - 无法解析的 effects 可拒绝，但自然回复仍可提交；
   - effects 拒绝原因必须进入 trace；
4. 每个有效回合最多增加一次 state revision；
5. 相同 `clientMessageId` 重试不得重复变化；
6. 提交失败时消息、状态、关系、记忆和领域事件整体回滚；
7. 下一轮 Prompt 必须读取已提交 post-state，而不是内存中的旧快照；
8. 应用重启后读取值必须与提交结果完全一致。

### 不增加的机制

- 不增加关键词资格门控来决定普通聊天能否有 state/relationship delta；
- 不增加 interaction frame、decision subject 或 permission ceiling；
- 不把状态 proposal 当成第二个用户请求；它是角色回合的隐藏副作用。

---

## 10. WP4：关系缓慢、自然、可解释地积累

### 目标

让关系来自长期互动，不依赖某一句“关系关键词”，也不在几轮内跳成亲密关系。

### 工作

1. 新角色默认关系改为“初识”预设，但保留角色创建时的显式配置；
2. 每次成功、非 replay 的用户—角色回合：
   - 更新 `lastInteractionAtUtc`；
   - 添加极小 familiarity 基础增量；
3. closeness 与 trust：
   - 只接受有语义依据的 LLM proposal；
   - 受单轮上限、每日上限和 capability scale 约束；
   - 普通寒暄不自动提升 trust；
4. `recentInteractionValence`：
   - 表示近期互动而不是永久累计；
   - 新互动到来时融合当前值；
   - 随时间结算逐步回归 0；
5. 共同活动：
   - 计划创建不立即增加关系；
   - completed / partial / skipped 分别产生可解释的小幅后果；
6. 主动消息本身不自动提高关系；用户实际回复后才按正常回合处理；
7. 用 1、10、30、100 回合确定性模拟校准曲线；
8. 关系值只用于内部状态和角色表达，不在普通聊天 UI 中做“好感度进度条”。

### 验收性质

- 重点检查增长速度、因果和跨会话延续；
- 不比较哪个角色更“听话”；
- 不测试角色替用户决定；
- 不引入第三方关系。

---

## 11. WP5：时间、活动和角色生活驱动状态

### 目标

角色在用户离开后不调用模型，但时间与已计划生活仍能在下次打开时形成连续后果。

### 工作

1. 启用并验证 self planning；
2. 保留 72 小时滚动日程和 FakeClock；
3. 结算事件按时间排序逐个应用：
   - 前一活动的 post-state 成为后一活动的 pre-state；
   - 每个活动有独立 delta、revision 语义和 trace；
4. 修正长时间离线结算：
   - 不先聚合所有 delta 再丢失因果；
   - 幂等 cursor 保证重开不会二次结算；
5. 修正 sleep debt：
   - 未来计划缩短睡眠时不提前把债记成已经发生；
   - 按实际 completed / partial / skipped 睡眠事实增减；
   - 下一日状态与回复可感知结果；
6. 活动完成后的状态必须进入下一轮 Prompt；
7. 当前活动必须与角色回复中的“正在做什么”一致；
8. 只对已有状态变量接线，不扩展复杂生理维度。

### 本轮暂缓

- 按分钟消耗 energy；
- 无事件时 mood 自动回归基线；
- 复杂昼夜节律；
- 多天习惯学习；
- 第三方人物活动模拟。

这些只能在事件驱动闭环完成并证明不足后另立计划。

---

## 12. WP6：用现有领域事件完成变化追溯

### 目标

本地开发者能够直接回答：“这次状态为什么变、从多少变到多少、下一轮是否读到了？”

### 工作

扩充现有 `conversation.world_effects_committed` 与活动结算事件，不新建产品级审计平台。

每次变化至少记录：

```text
source: llm | interaction_baseline | activity_settlement | sleep_settlement
causationId: userMessageId | activityEventId
stateRevisionBefore
stateRevisionAfter
proposedDelta
acceptedDelta
appliedDelta
relationshipScale
limitsApplied
rejectionCodes
beforeChangedFields
afterChangedFields
recordedAtUtc
```

要求：

- trace 与状态写入同事务；
- shadow 只记录 would-apply，不伪装成 committed；
- rejected 与 clamped 能看见原始原因；
- 普通 familiarity 基础增量标明 `interaction_baseline`，不伪装成模型判断；
- 测试报告保存输入、原始模型 envelope、服务端处理结果和最终状态；
- 优先复用现有 Developer timeline/JSON 与领域事件接口；
- 不为本轮新增复杂前端页面。

---

## 13. WP7：状态专用测试方案

### 13.1 测试分层

| 层级          | Provider              | 目的                                             | 是否联网     |
| ------------- | --------------------- | ------------------------------------------------ | ------------ |
| Unit          | 无                    | schema、clamp、scale、状态公式、关系曲线         | 否           |
| Integration   | stub/fixture envelope | 事务、幂等、重启、下一轮 Prompt                  | 否           |
| Simulation    | fixture + FakeClock   | 活动、离线结算、sleep debt、长期关系             | 否           |
| Real Provider | DeepSeek              | 验证真实模型能读取状态、自然表达并提出合理 delta | 是，显式执行 |

### 13.2 离线核心场景

| ID    | 场景                                      | 必须证明                                   |
| ----- | ----------------------------------------- | ------------------------------------------ |
| ST-01 | 相同消息，高精力低压力 vs 低精力高压力    | Prompt 状态不同，回复倾向与状态一致        |
| ST-02 | 正向低唤醒 vs 负向高唤醒                  | mood 两维均有独立影响，不只是复述数字      |
| ST-03 | 高 focus vs 低 focus；高/低 socialBattery | 话题维持、主动扩展和回复策略有差异         |
| ST-04 | 合法 `stateDelta`                         | 限幅后落库，revision 只增一次              |
| ST-05 | 下一轮与应用重启                          | post-state 被下一轮和重启后读取            |
| ST-06 | 相同 `clientMessageId` 重试               | 不产生第二次状态或关系变化                 |
| ST-07 | 事务中途失败                              | 消息、状态、关系和 trace 全部回滚          |
| RL-01 | 10 个普通自然回合                         | familiarity 缓慢增加，时间戳每轮更新       |
| RL-02 | 30/100 回合                               | 关系不爆涨，不越界，增长曲线可解释         |
| RL-03 | 支持、误解、修复三段互动                  | closeness/trust/valence 变化有因果且不过度 |
| RL-04 | 共同活动 completed / partial / skipped    | 只有实际结果产生差异化后果                 |
| TM-01 | 多活动按序结算                            | 前一 post-state 影响后一活动概率和结果     |
| TM-02 | 关闭 24 小时后重开两次                    | 第一次追赶，第二次幂等无重复               |
| TM-03 | 睡眠缩短、部分完成、跳过、补眠            | sleep debt 在事实发生时变化并能恢复        |
| CP-01 | lightweight / daily / high_fidelity       | capability 差异明确且不会绕过服务端限制    |

### 13.3 测试对话原则

测试输入必须像朋友之间的自然交流：

- 每句话一个主要交流意图；
- 不把“安慰、安排、解释、确认、决策”塞进同一句测试；
- 不要求角色列目标或替用户制定计划；
- 不使用第三方隐私、共同朋友圈或虚构外部人物；
- 不以固定拒绝句或关键词命中作为成功；
- 同一状态对照使用相同输入，避免测试变量混杂。

### 13.4 真实 DeepSeek 小型功能验证

离线测试全部通过后，再执行一轮小型真实 Provider 验证：

- 只选择 6 个单一意图场景；
- 每个场景保存完整输入、system/prompt 状态摘要、原始输出、解析后 envelope、pre-state、applied delta、post-state 和下一轮输入；
- token 预算以完整输出为优先，不因预算过低截断结构化 envelope；
- 只对网络、超时或 JSON 解析失败重试一次；
- 语义不理想不自动重试，不用重采样掩盖问题；
- 不运行盲审，不扩成大规模 release matrix；
- 不把真实 Provider 结果作为数值公式单元测试；
- 执行前记录并告知当时使用的模型、URL、token 预算、凭证环境和产物保存位置；
- 实际调用使用用户已经为本项目给出的真实 DeepSeek 授权，不重复把同一批准改造成新的审批流程；若用户撤回授权则停止；
- 本计划编写阶段本身不触发付费请求。

真实验证只回答：

1. 模型是否正确理解角色当前状态；
2. 回复是否自然体现状态，而不是机械复述；
3. proposal 是否与本轮对话有因果关系；
4. 服务端是否正确处理并持久化；
5. 下一轮是否延续变化。

---

## 14. 精确文件改动地图

以下路径均以 `7082ee2` 为基线，实施时以实际依赖为准。

### Contracts

- `packages/contracts/src/state.ts`
- `packages/contracts/src/relationship.ts`
- `packages/contracts/src/persona-chat-decision.ts`
- 必要时扩充现有领域事件 payload schema；不新建权限类合同。

### Features

- `packages/features/src/state-engine.ts`
- `packages/features/src/relationship-engine.ts`
- `packages/features/src/world-effects.ts`
- `packages/features/src/prompt-assembler.ts`
- `packages/features/src/prompt-segments/default-segments.ts`
- `packages/features/src/reply-strategy.ts`
- `packages/features/src/settlement-engine.ts`
- `packages/features/src/self-planning.ts`

### Server

- `apps/server/src/config.ts`
- `apps/server/src/domain/defaults.ts`
- `apps/server/src/services/conversation-service.ts`
- `apps/server/src/services/turn-decision-service.ts`
- `apps/server/src/services/world-effect-service.ts`
- `apps/server/src/services/turn-commit-service.ts`
- `apps/server/src/services/settlement-service.ts`
- `apps/server/src/services/personal-life-service.ts`
- `apps/server/src/db/store.ts`，仅在现有事务/事件接口不能表达所需 trace 时修改。

### Tests and scenarios

- 复用并缩小 `apps/server/src/services/conversation-real-path.integration.test.ts`；
- 为 state usage、relationship accumulation、sequential settlement 和 restart continuity 建立目标明确的小测试文件；
- 复用 `apps/server/src/scripts/deepseek-acceptance-flow.ts` 的 HTTP 与原始记录能力；
- 不移植 `9bdac63` 的 7,312 行长跑 runner；
- 只实现本计划 13.2 的紧凑状态场景 runner。

### Documentation

- `README.md`
- `.env.example`
- 本计划的执行状态与最终完成报告。

### 明确不应新增或移植

- `turn-response-policy*`
- `interaction-frame*`
- `interaction-policy*`
- `permission-ceiling*`
- `privacy-boundary*`
- `release-gate*`
- `companion-first` 大型门禁报告器
- 新的第三方人物或社交图 schema

---

## 15. 推荐实施顺序与提交边界

### Commit 1：基线与 characterization

- 独立 worktree；
- 引入本计划；
- 增加只描述现状的测试；
- 不改变生产行为。

### Commit 2：默认本地闭环配置

- 让真实 world effects 和 self planning 在本地 Demo 中实际运行；
- 同步 README 与 `.env.example`。

### Commit 3：Prompt 状态语义与 Reply Strategy

- 增加定性状态描述；
- 明确每个状态字段的消费路径；
- 增加状态对照测试。

### Commit 4：对话状态提交与 trace

- 修复事务、幂等、revision、repair/fallback；
- 记录 proposed/accepted/applied/before/after。

### Commit 5：关系自然积累

- 互动时间；
- familiarity 基础层；
- closeness/trust/valence 语义层；
- 长度曲线模拟。

### Commit 6：顺序活动结算与 sleep debt

- 逐事件应用；
- 离线追赶；
- 共同活动关系后果；
- 睡眠事实结算。

### Commit 7：完整离线状态场景

- 单元、集成、FakeClock、重启与 capability 分档；
- 生成紧凑 before/after 报告。

### Commit 8：真实 DeepSeek 验证与最终报告

- 仅在离线全绿后使用既有授权执行；
- 不在此 commit 修改数值公式；
- 若发现问题，先形成复现测试，再单独修复。

每个 commit 都必须能独立解释与 README 哪一条核心准则对应，不混入无关清理。

---

## 16. 验证命令

基线与每个工作包至少运行：

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

新增测试应提供可单独执行的 workspace 命令，至少区分：

```text
state unit
state integration
state FakeClock simulation
real DeepSeek state acceptance
```

真实 DeepSeek 命令必须保持显式，不得被 `pnpm test`、CI 或普通开发启动自动触发。

---

## 17. 风险与控制

### 风险 1：结构化 envelope 影响语言自然度

控制：先保持单调用最小 sidecar；用相同 Prompt 做真实对照。只有出现稳定证据才讨论两阶段调用。

### 风险 2：关系数值膨胀

控制：基础 familiarity 极小、按日封顶；closeness/trust 需要语义 proposal；用 1/10/30/100 回合曲线校准。

### 风险 3：模型随机性让测试变成词面门禁

控制：数值与持久化用 stub/fixture；真实模型只检查状态一致性和因果，不断言固定句子。

### 风险 4：离线批结算改变既有结果

控制：先冻结 characterization；按事件迁移；对 cursor、重启、重复激活和时间回退做幂等测试。

### 风险 5：再次扩大产品范围

控制：任何新增需求必须直接回答“它验证了 README 四条准则中的哪一条”。无法回答的内容不进入本轮。

### 风险 6：误伤当前工作树

控制：只在从 `7082ee2` 创建的独立 worktree 实施；当前脏工作树不回退、不覆盖、不清理。

---

## 18. 完成定义

只有同时满足以下条件，本轮才算完成：

- 默认本地 Demo 的真实 world effects 不再只是 shadow；
- self planning 与时间结算能产生可观察、可持久化的角色生活后果；
- 所有 RuntimeState 字段都有已验证的 producer/consumer，或明确标记为 `context-only`；
- 相同输入在对照状态下产生状态一致的不同回复倾向；
- 合法 state delta 经过校验、缩放和限幅后落库；
- 下一轮和应用重启后读取的是 post-state；
- 每个有效用户—角色回合更新时间并缓慢积累 familiarity；
- closeness、trust 与近期 valence 不会因普通寒暄大幅跳变；
- 共同活动只有在实际结算后才产生关系后果；
- 多活动按时间顺序结算，前一状态能影响后一事件；
- sleep debt 在事实发生时变化，而不是在未来计划生成时提前发生；
- replay、重试、重复激活和失败回滚不会造成二次变化；
- trace 能显示来源、proposal、accepted、applied、before、after 与原因；
- fixture 与真实 Provider 使用相同的服务端持久化规则；
- 真实 DeepSeek 小型验证能展示状态读取、自然表达、合理变化与下一轮延续；
- typecheck、lint、test、build 全部通过；
- 本轮没有新增隐私、决策权限、第三方社交或商业发布门禁体系。

最终验收必须能用一条真实链路展示：

```text
角色完成/错过一段生活
→ 状态改变
→ 用户来聊天
→ 角色自然体现当前状态
→ 本轮互动又造成小幅状态或关系变化
→ 变化落库且可追溯
→ 下一次聊天仍然延续
```

---

## 19. Codex 执行报告模板

每个工作包完成后只报告与本轮目标直接相关的内容：

```text
工作包：
基线 SHA：
代码 commit：

修改的状态生产者：
修改的状态消费者：
持久化路径：
trace 事件：

新增离线复现：
修复前表现：
根源：
修复后表现：

测试命令与结果：
真实 Provider 是否调用：
真实输入文件：
真实原始输出文件：
pre-state / post-state：

是否触及非目标范围：否 / 是（若是必须停止并说明）
下一步：
```

不要用“发布通过”“策略覆盖率”或“盲审胜率”代替状态功能结果。

---

## 20. 下一步执行入口

用户批准实施后，第一步不是改业务代码，而是：

1. 从 `7082ee2` 创建独立 worktree 与 `codex/llm-state-closed-loop-20260828` 分支；
2. 在新 worktree 运行 WP0 基线测试；
3. 提交 characterization 结果；
4. 向用户展示“当前状态输入、模型 envelope、数据库前后值和下一轮 Prompt”的最小证据；
5. 报告 WP0 证据；如果用户没有改变方向，则继续进入 WP1–WP6 的生产修改。

在这一步之前，不应继续修当前 V4 回复策略，也不应再发起盲审。
