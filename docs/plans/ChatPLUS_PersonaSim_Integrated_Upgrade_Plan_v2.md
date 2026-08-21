# ChatPLUS / PersonaSim 综合升级计划 v2

> **项目愿景**
>
> **他们的人生不会因为你离开而停止，却会因为你来过而发生改变；你的人生也同样如此。**
>
> 核心准则：**时间会推进，互动有后果，关系会积累，变化可追溯。**

- 文档性质：基于现有代码的增量升级计划
- 当前代码基线：`main @ 4ede0f0`（`Merge schedule negotiation refactor (v0.1.0 preview)`）
- 原修订计划参考基线：`b983e5f`
- 参考项目：DeepSeek Harness、Cyrene-Agent、Suzu Lives
- 实施方式：只借鉴架构思想和设计模式；不直接复制第三方受限许可证代码
- 优先级定义：
  - **P0：正确性与架构边界，必须先完成**
  - **P1：长期稳定性与关系连续性，核心闭环稳定后完成**
  - **P2：体验、语义检索、多模态与生态扩展，按实验结果选择性完成**

---

# 0. 执行摘要

ChatPLUS 当前已经不是“从零开始的 MVP”。以下基础能力已经存在并且应当保留：

- 原创角色生成和作品文本导入
- 结构化、可编辑、可版本化的 `CharacterSpec`
- 轻量 / 日常 / 拟真三档 capability profile
- 72 小时滚动日程
- System / Fake Clock
- 离线批量结算和自然整点结算
- `ScheduleItem → ActivityEvent → RuntimeState → Memory → ProactiveCandidate`
- Actor Queue 单角色串行写入
- SQLite WAL、领域事件、幂等游标
- Fixture / OpenAI-compatible LLM Provider
- JSON → Zod → 领域规则三层校验
- Persona Guard
- 主动消息的静默时间、每日上限、活动来源和去重
- 微内核、Service Registry、Event Bus、Plugin Runtime、Bundle
- Schedule Negotiation 多轮协商与服务端持久化状态机
- 单元、集成、模拟和 Playwright E2E 测试

因此，本次升级不应重写这些模块。

新版路线聚焦四个缺口：

```text
A. 角色还不能真正从“自己的目标 / 偏好 / 兴趣”形成生活计划
B. 记忆已经可用，但还不足以支持数周、数月的可靠长期连续性
C. 主动消息已经能发，但还没有完整的“生成前后双重校验”和一次性回访语义
D. 当前 Prompt / Conversation 编排能够工作，但继续堆功能会增加耦合和上下文污染
```

最终目标从：

> “增加角色自主日程功能”

升级为：

> **建立一个可追踪、可回放、不会欺骗用户，并且能够长期保持时间、记忆、关系和人格连续性的角色自主生活模拟系统。**

---

# 1. 当前 ChatPLUS 已完成内容评估

## 1.1 已完成且不应重建

### 微内核

当前已经存在：

```text
packages/kernel/
├── actor-queue.ts
├── event-bus.ts
├── plugin-runtime.ts
├── service-registry.ts
├── logger.ts
└── errors.ts
```

`PluginRuntime` 已支持：

- Manifest 校验
- API version
- requires / provides
- 依赖拓扑排序
- 循环依赖检测
- 服务所有权校验
- 激活失败回滚
- 反向 dispose

结论：

> DeepSeek Harness 风格的“内核重构”已经基本完成，P0/P1 不应再次重写 Plugin Runtime。

以后只需要增加新的 Service Token 和 feature plugin。

---

## 1.2 CharacterSpec 已经足够丰富

当前 `CharacterSpec` 已经包含：

```text
identity
traits
values
contradictions
goals
preferences
boundaries
dialogue
userRelationship
routines
schedulePolicy
proactivePolicy
knowledge
sources
lockedPaths
```

因此：

> 不增加新的“大人格模型”。

自主行为应当从现有：

```text
goals
preferences
routines
contradictions
current state
relationship
```

运行时推导。

这与原修订计划中的：

```ts
deriveActivityAffinities(character)
```

方向一致。

---

## 1.3 时间模拟基础已经完整

当前系统已经有：

```text
ScheduleItem
ActivityEvent
RuntimeState
SimulationCursor
SettlementResult
```

并实现：

```text
应用打开
→ settle
→ 批量结算
→ ActivityEvent
→ RuntimeState
→ 活动记忆
→ ProactiveCandidate
```

这条链路保留。

新的自主规划只能接入这条链，不能创建第二套时间系统。

---

## 1.4 Schedule Negotiation 已经形成独立状态机

当前 `ScheduleNegotiationAction` 已经支持：

```text
none
request_details
propose_offer
accept_user_offer
accept_pending_offer
decline_offer
withdraw_offer
```

并且有：

```text
schedule_negotiations 表
offer version
CAS
domain event
legacy / shadow / enforced rollout
```

因此原修订计划中的 D1 必须继续坚持：

> **个人意向 PersonalIntent 与 ScheduleNegotiation 完全独立。**

两者可以共享：

```text
ScheduleItem
最终投影验证
事务提交工具
```

但不能共享：

```text
状态机
确认逻辑
持久化生命周期
```

---

## 1.5 当前记忆系统的实际状态

已经有：

```text
semantic
episodic
relationship
commitment
```

以及：

```text
confidence
importance
occurredAtUtc
expiresAtUtc
tags
sourceMessageIds
sourceActivityEventIds
origin
dedupeKey
status
supersededById
```

同时已有：

- 低置信度拒绝
- 低重要性拒绝
- Claim-like memory 强制来源
- 基础 Jaccard 式去重
- 活动事件自动形成 episodic memory

因此：

> 记忆系统不是缺失，而是“证据模型和长期语义还不够严格”。

目前最明显的问题：

1. 没有 namespace；
2. 消息来源和证据只是 ID 数组，没有独立证据对象；
3. `occurredAtUtc` 不能表达“提及 / 计划 / 实际发生 / 写入”四种时间；
4. live chat 当前读取重要记忆后直接注入 Prompt，没有真正走 query-aware recall；
5. 没有可靠结果时没有明确 abstain；
6. 没有 checkpoint / autobiography；
7. 没有 date-range recall；
8. 没有长期生命周期和冲突账本。

---

## 1.6 当前主动消息的实际状态

已经有：

```text
ActivityEvent
→ ProactiveCandidate
→ quiet hours
→ relationship threshold
→ daily limit
→ dedupe / merge
→ assistant_proactive message
```

这是正确基础。

仍然缺少：

```text
发送前原子 claim
生成前 / 生成后状态复核
stale generation cancellation
用户是否已经回来 / 正在聊天
未回复惩罚
具体事项的一次性 FollowUpIntent
```

因此不重写 ProactiveCandidate，只增强提交协议。

---

## 1.7 当前 Prompt 的实际状态

`prompt-assembler.ts` 已经会注入：

```text
Character
RuntimeState
Relationship
24h Schedule
Memories
Source Excerpts
Recent Conversation
Current User Message
Reply Strategy
```

问题不是“没 Prompt”，而是：

```text
所有内容最终由一个 assembleChatPrompt 集中拼装
RuntimeState 主要以裸数字形式暴露
记忆一次可注入多条，缺少 EvidenceBundle
没有 Autobiography
没有 Prompt Segment 生命周期
```

因此 Prompt Segment 化属于 P1，不阻塞 P0 自主日程。

---

# 2. 三个参考项目还能借鉴什么

## 2.1 DeepSeek Harness

### 已经借鉴

| 设计 | ChatPLUS 状态 |
|---|---|
| Service Registry | 已实现 |
| Plugin lifecycle | 已实现 |
| Event Bus | 已实现 |
| Provider / Consumer 思路 | 已部分实现 |
| Bundle / Profile | 已实现 |
| Runtime event 与持久事件区分 | 已实现 |

### 仍可借鉴

P1/P2 将以下能力抽象为 Service：

```text
MemoryRecallService
CheckpointService
AutobiographyService
CalendarService
EmbeddingProvider
RerankerProvider
```

### 不需要现在借鉴

```text
任意第三方插件加载
插件市场
权限沙箱
复杂外部工具系统
```

---

## 2.2 Cyrene-Agent

### 当前已经部分具备

```text
Persona Guard
结构化输出
quiet hours
主动消息每日上限
关系状态
消息分段风格
```

### 仍然值得借鉴

#### 保守 Memory Judge

增加：

```text
certainty
attribution
stability
evidence
shouldWrite
forbiddenOverclaims
```

原则：

> 宁可漏记，不要误记。

#### 主动消息两阶段校验

```text
candidate
→ preflight
→ claim / epoch
→ 生成
→ postflight
→ commit
```

生成期间用户回来，就丢弃旧消息。

#### Care Cue

用户的目标或困扰可以生成：

```text
“以后自然提一下”
```

但不一定生成主动消息。

#### Persona 连续性规则

增加：

```text
anti-appeasement
emotion continuity
anti-manipulation
boundary continuity
```

角色不能：

- 用户一说什么就同意；
- 下一条消息就完全清空上一轮情绪；
- 通过内疚、依赖或“你不理我”制造压力。

---

## 2.3 Suzu Lives

这是当前最值得继续借鉴的项目。

### 四层长期上下文

```text
稳定核心
长期第一人称自传
最近完整原文
本轮相关历史证据
```

PersonaSim 扩展为：

```text
Character Core
Agent Autobiography
User Model
Recent Verbatim
Retrieved Evidence
```

### Evidence-only RAG

RAG 不替角色回答。

只提供：

```text
Event Card
Verbatim Quote
Date Digest
```

没有可靠命中：

```text
none
```

### 时间语义分离

必须区分：

```text
mentionedAt
plannedAt
occurredAt
recordedAt
```

### 一次性 FollowUpIntent

例如：

```text
用户：“明天面试。”

→ 创建 FollowUpIntent

用户第二天先说：
“面试结束了。”

→ 自动 resolved

不再主动询问
```

### Checkpoint + Autobiography

长期聊天通过 checkpoint 压缩：

```text
原始消息永久保留
→ 旧消息退出 live context
→ 生成第一人称自传摘要
→ 每条重要内容绑定原始证据
```

---

# 3. 总体新架构

升级后保持三个主循环，并增加两个辅助循环。

```text
角色编译循环
  Character Source
      ↓
  CharacterSpec

会话循环
  User Message
      ↓
  ReplyDecision
      ↓
  WorldEffects
      ↓
  Server Validation
      ↓
  Atomic Commit

生活模拟循环
  CharacterSpec + RuntimeState + PersonalIntent
      ↓
  SelfPlanning
      ↓
  ScheduleItem
      ↓
  Settlement
      ↓
  ActivityEvent
      ↓
  State / Memory / Proactive

长期记忆循环（P1）
  Messages + ActivityEvents
      ↓
  Checkpoint
      ↓
  Event Cards + Autobiography
      ↓
  Evidence Retrieval

关系跟进循环（P1）
  User Goal / Event / Commitment
      ↓
  FollowUpIntent / CareCue
      ↓
  Resolution Check
      ↓
  Optional Proactive Message
```

---

# 4. P0：正确性、个人意向和自主生活闭环

P0 是下一个开发阶段。

P0 完成之后必须能够证明：

```text
角色能够形成自己的意向
→ 程序为它找到合理时间
→ 日程真正发生
→ 角色付出状态代价
→ 形成有证据的记忆
→ 时间线可以说明“为什么发生”
```

---

# P0-0：重新基线化现有 Schedule Negotiation

## 目标

当前 main 已经比原计划的 `b983e5f` 多出了 Schedule Negotiation 重构。

不要覆盖它。

## 工作

保留：

```text
legacy
shadow
enforced
```

短期 rollout。

增加一条规则：

> PersonalIntent 永远不进入 ScheduleNegotiationAction。

共同协商继续由：

```text
ScheduleNegotiationService
```

负责。

角色自己的计划由：

```text
PersonalIntentService
SelfPlanningService
```

负责。

## 进一步修正

当前 `ScheduleNegotiation` 是 create-oriented MVP。

在将默认模式切换为 `enforced` 前，需要确认：

```text
接受用户邀请
+
与现有 flexible 日程冲突
```

是否能完全由服务端生成合法的最终安排。

推荐增加：

```ts
ScheduleMutationBundle
```

作为低层工具。

它可以包含：

```ts
{
  create?: ScheduleItemDraft[],
  reschedule?: ServerScheduleAdjustment[],
  cancel?: ServerScheduleCancellation[]
}
```

重要：

```text
ScheduleMutationBundle 不是 LLM 输出
```

它只能由服务器 Planner 生成。

这样：

```text
Schedule Negotiation
Personal Self Planning
Night Bundle
```

都可以复用：

```text
final projection validation
atomic commit
```

但不复用上层状态机。

## 验收

- legacy / shadow / enforced 现有测试保持通过；
- PersonalIntent 不出现在 ScheduleNegotiation schema；
- 最终投影验证只有一个权威实现；
- 不允许 legacy effect 与 server bundle 在同一回合同时写日程。

---

# P0-1：重新设计 Chat Decision Envelope

这是原修订计划 P0-5 的升级版本。

## 当前问题

内部 `AgentTurnDecision` 已经有：

```text
stateDelta
relationshipDelta
memoryCandidates
```

但 live model-facing `PersonaChatDecision` 目前主要暴露：

```text
text
toneTags
chunks
scheduleAction
scheduleEffects
memoryCandidates
```

因此：

```text
stateDelta
relationshipDelta
```

还没有成为稳定 live path。

同时 reply repair 容易和 world effect 生命周期纠缠。

## 新结构

推荐：

```ts
interface PersonaTurnEnvelope {
  replyDecision: {
    text: string;
    toneTags?: string[];
    deliveryMode?: "single_block" | "sequential";
    chunks?: string[];

    // 仅描述共同协商中的对话动作
    scheduleAction?: ScheduleNegotiationAction;
  };

  worldEffects: {
    stateDelta?: RuntimeStateDelta;
    relationshipDelta?: RelationshipDelta;
    memoryCandidates?: MemoryCandidate[];
    personalIntentCandidates?: PersonalIntentCandidate[];
  };
}
```

禁止 live path 再通过新功能产生：

```text
exact ScheduleItem
schedule source
database id
persisted status
exact server timestamp
```

## Repair 规则

```text
reply repair
只允许修改 replyDecision

worldEffects validation
独立完成

controlled reply
不得清空已经验证成功的 stateDelta / relationshipDelta

cross-check
最终 reply 不能和实际提交结果明显冲突
```

## 文件

修改：

```text
packages/contracts/src/persona-chat-decision.ts
packages/contracts/src/turn.ts
packages/contracts/src/llm.ts
packages/features/src/prompt-assembler.ts
apps/server/src/services/conversation-service.ts
```

新增：

```text
packages/features/src/world-effects.ts
```

## 验收

- live LLM 能产生受限 stateDelta；
- live LLM 能产生受限 relationshipDelta；
- reply repair 不覆盖 worldEffects；
- worldEffects 失败不导致角色回复消失；
- DB 错误仍然使整个 turn transaction 回滚。

---

# P0-2：记忆正确性基础升级

自主生活会显著增加角色自身记忆，因此在大量新增 ActivityEvent 前先修正记忆模型。

## 2.1 新增 namespace

```ts
type MemoryNamespace =
  | "canon"
  | "character_self"
  | "user_model"
  | "shared_relationship"
  | "runtime_simulation";
```

含义：

```text
canon
角色设定 / 作品正典

character_self
角色如何记住自己经历

user_model
用户明确表达的稳定信息

shared_relationship
双方共同经历 / 承诺 / 关系事件

runtime_simulation
日程结算产生的世界事实
```

---

## 2.2 新增记忆可信属性

```ts
type MemoryCertainty =
  | "explicit"
  | "inferred"
  | "uncertain";

type MemoryAttribution =
  | "user_explicit"
  | "character_decision"
  | "simulation_event"
  | "model_inference"
  | "mixed";

type MemoryStability =
  | "one_off"
  | "situational"
  | "stable";
```

---

## 2.3 独立 MemoryEvidence

```ts
interface MemoryEvidence {
  id: string;
  memoryId: string;

  sourceType:
    | "message"
    | "activity_event"
    | "schedule_event"
    | "character_source"
    | "manual";

  sourceId: string;

  quote?: string;
  contextSummary?: string;

  recordedAtUtc: string;
}
```

数据库新增：

```text
memory_evidence
```

---

## 2.4 时间语义

替换单一：

```text
occurredAtUtc
```

为完整语义：

```ts
interface TemporalMetadata {
  mentionedAtUtc?: string;

  plannedStartAtUtc?: string;
  plannedEndAtUtc?: string;

  occurredStartAtUtc?: string;
  occurredEndAtUtc?: string;

  recordedAtUtc: string;

  temporalCertainty:
    | "exact"
    | "date_only"
    | "approximate"
    | "unknown";

  temporalStatus:
    | "planned"
    | "in_progress"
    | "occurred"
    | "cancelled"
    | "unknown";
}
```

原则：

```text
计划
≠
发生

消息发送时间
≠
事件发生时间

结算时间
≠
活动发生时间
```

---

## 2.5 保守 Memory Judge

`MemoryCandidate` 增加：

```text
namespace
certainty
attribution
stability
evidence
shouldWrite
forbiddenOverclaims
```

强制：

```text
model_inference
不能成为 explicit

shared_experience
必须有真实证据

activity_outcome
必须引用 ActivityEvent

user_model stable
必须来自用户明确表达或多次可靠证据
```

---

# P0-3：把 live memory 注入改成真实检索

## 当前问题

当前 chat path：

```text
readActiveMemories()
→ 取高 importance / recent
→ Prompt 最多注入 12 条
```

而不是：

```text
current user message
→ relevance retrieval
→ selected evidence
```

现有 `selectRelevantMemories()` 并没有成为 live chat 的权威入口。

这是 P0 必须修复的问题。

## 新增 MemoryRecallService

```ts
interface MemoryRecallResult {
  mode:
    | "event_card"
    | "verbatim_quote"
    | "basic_memory"
    | "none";

  selectedMemoryIds: string[];
  selectedEvidenceIds: string[];

  score: number;
  abstained: boolean;
  abstentionReason?: string;
}
```

P0 暂时继续使用：

```text
SQLite
关键词
tags
importance
recency
time range
namespace
```

不加入 embedding。

## Prompt 改动

从：

```ts
memories: Memory[]
```

升级到：

```ts
memoryEvidence?: EvidenceBundle
```

默认：

```text
最多一个 EvidenceBundle
最多 3 条证据
低于阈值 → none
```

原则：

> 不可靠地“想起一点”，比明确“不召回”更糟。

---

# P0-4：动态运行上下文不能进入长期记忆

以下属于 runtime context：

```text
现在几点
今天星期几
角色当前 energy
角色当前 stress
当前活动
未来日程
本次 settlement interval
内部系统 policy
```

它们不能自动进入：

```text
message archive
long-term memory
autobiography
```

增加：

```ts
type ContextAttachmentType =
  | "user_visible_text"
  | "runtime_time_context"
  | "runtime_state_context"
  | "schedule_context"
  | "memory_evidence"
  | "system_policy";
```

Memory Judge 默认只接受：

```text
用户 / 角色可见消息
ActivityEvent
Character Source
手工输入
```

作为正式证据。

---

# P0-5：PersonalIntent 基础契约

保留原修订计划 D1-D5。

## Schema

新增：

```text
packages/contracts/src/personal-intent.ts
```

```ts
type PersonalIntentBasis =
  | "goal"
  | "preference"
  | "routine"
  | "chat"
  | "spontaneous";

type PersonalIntentStatus =
  | "pending"
  | "planned"
  | "consumed"
  | "expired"
  | "rejected"
  | "superseded";

interface PersonalIntent {
  id: string;
  agentId: string;
  sessionId?: string;

  activity: string;
  category: ScheduleCategory;

  desiredDurationMinutes: number;

  earliestAtUtc?: string;
  latestAtUtc?: string;

  basisKind: PersonalIntentBasis;

  basisRefIds: string[];
  evidenceMessageIds: string[];

  priority: number;
  freshness: number;

  status: PersonalIntentStatus;

  dedupeKey: string;
  specVersion: number;
  schemaVersion: number;

  attemptCount: number;
  lastAttemptAtUtc?: string;

  createdAtUtc: string;
  updatedAtUtc: string;
}
```

## Chat Candidate

LLM 不返回 exact time。

```ts
interface PersonalIntentCandidate {
  activity: string;
  category?: ScheduleCategory;

  durationHint?: string;
  timingHint?: string;

  basisKind: "chat";
  evidenceQuotes: string[];

  reasonCode: string;
  reasonSummary: string;
}
```

服务器负责：

```text
category normalization
duration default
timingHint → time window
evidence quote grounding
dedupe
source ownership
```

---

# P0-6：PersonalIntentService

新增：

```text
apps/server/src/services/personal-intent-service.ts
```

职责：

```text
grounding
normalization
dedupe
merge
expiry
spec version check
audit
```

## 五类 grounding

### goal

必须引用：

```text
CharacterSpec.persona.goals[].id
```

### preference

必须引用：

```text
CharacterSpec.persona.preferences[].id
```

### routine

必须引用：

```text
CharacterSpec.routines[].id
```

### chat

必须：

```text
引用本回合 user message
保存 evidence quote
quote 必须能在用户文字中 grounding
```

### spontaneous

不要求来源证据。

但必须继续通过：

```text
spontaneity budget
category allowlist
risk policy
frequency policy
persona boundary
schedule validator
```

P0 可以先默认关闭 spontaneous 自动生成，仅保留 schema 支持。

---

# P0-7：personal_intentions 数据层

新增迁移：

```text
005_personal_intentions.sql
```

表：

```text
personal_intentions
```

字段：

```text
id
agent_id
session_id
activity
category
duration_minutes
earliest_at_utc
latest_at_utc
basis_kind
record_json
status
dedupe_key
spec_version
schema_version
attempt_count
last_attempt_at_utc
created_at_utc
updated_at_utc
```

索引：

```text
agent_id + status
agent_id + earliest_at_utc
dedupe_key
```

同一角色：

```text
同一 dedupeKey
+
pending / planned
```

不允许无限重复。

---

# P0-8：SelfPlanningService

新增：

```text
packages/features/src/self-planning.ts
apps/server/src/services/self-planning-service.ts
```

核心入口：

```ts
ensureSelfInitiatedPlans(agentId)
```

调用时机：

```text
activate
settlement 完成后
hourly tick
chat 产生 PersonalIntent 后
```

不要等待：

```text
72h horizon refresh
```

才能消费意向。

## 规划顺序

推荐：

```text
settle
→ ensure72Hours
→ expire PersonalIntent
→ ensureSelfInitiatedPlans
→ deliver eligible proactive
```

## Planner 输入

```text
CharacterSpec
RuntimeState
pending PersonalIntent
current Schedule
nowUtc
```

## 输出

Planner 只输出服务器对象：

```ts
SelfPlanBundle
```

不是 LLM proposal。

---

# P0-9：空闲槽计算

禁止：

```text
09:00 - 21:00 全局 active time
```

角色自己的生活节奏由：

```text
sleep
work
study
routine
existing schedule
```

决定。

空闲槽：

```text
planning horizon
-
all non-cancelled schedule intervals
-
buffer
```

必须考虑：

```text
跨午夜
DST
角色时区
最小活动长度
meal / sleep hard constraints
```

---

# P0-10：affinity 推导

不要修改 CharacterSpec。

新增：

```ts
deriveActivityAffinities(character)
```

来源：

```text
routines
goals
preferences
dialogue / persona keywords
night-related keywords
```

输出：

```ts
interface ActivityAffinities {
  categoryScores: Record<ScheduleCategory, number>;
  nightOwlBias: number;
}
```

P0 只做 deterministic runtime derivation。

不要增加编辑器字段。

---

# P0-11：确定性放置

每次：

```text
最多成功生成 1 条 self-initiated activity
```

规则：

```text
候选按：
priority
freshness
affinity
state compatibility
排序

第一条放置失败
→ 尝试下一条

使用 deterministic seed
→ 重启后结果一致
```

seed：

```text
agentId
intentId
specVersion
targetLocalDay
```

---

# P0-12：服务器拥有 Schedule Source

增加：

```text
self_initiated
```

到：

```ts
ScheduleSource
```

映射由服务器决定：

```text
routine          → routine
user negotiation → user_invitation
self planner     → self_initiated
manual           → manual
```

LLM 永远不能决定 source。

---

# P0-13：claim-before-effect 幂等

原修订计划这一点必须保留。

错误：

```text
创建 schedule
→ 写 event
```

正确：

```text
准备 bundle
→ 开事务
→ claim 唯一 intent-consumption event
→ claim 成功
→ final projection revalidate
→ 创建 / 修改 schedule
→ intent consumed
→ 写 lineage event
→ commit
```

如果 final validation 失败：

```text
整个事务 rollback
claim 不存在
intent 可重试
```

如果 claim 已存在：

```text
不产生任何副作用
```

---

# P0-14：夜行 SelfPlanBundle

普通活动：

```text
PersonalIntent
→ find free slot
→ create schedule
```

夜间活动不同。

例如：

```text
夜跑
观星
夜市
深夜散步
```

可能需要改变 fixed sleep。

因此使用：

```ts
interface SelfPlanBundle {
  intentId: string;

  activity: ScheduleItemDraft;

  sleepAdjustment?: {
    sleepItemId: string;
    newStartAtUtc: string;
    newEndAtUtc: string;
    lostSleepMinutes: number;
  };
}
```

验证：

```text
先生成最终投影
→ 整体检查 conflict
→ 只允许修改自己的 sleep
→ 非 sleep fixed 永远不能移动
→ committed 默认不能移动
→ 检查最低睡眠
→ 检查 7 天频率
→ 原子提交
```

不要通过两个独立：

```text
create
reschedule
```

effect 来实现。

---

# P0-15：Sleep Debt

夜行如果只是“睡眠减少，但状态没变化”，体验会失真。

在 RuntimeState 增加：

```ts
sleepDebtMinutes: number
```

建议范围：

```text
0 - 720
```

根据实际少睡分钟增加。

之后睡眠 settlement 可以逐渐偿还。

状态影响根据：

```text
lostSleepMinutes
current sleepDebt
next-day workload
```

计算：

```text
energy
focus
stress
```

禁止：

```text
任何夜行都固定 energy -0.2
```

---

# P0-16：Live State / Relationship 闭环

增加 live model world effects。

安全：

```text
clamp
capability gating
relationship scaling
per-turn maximum
```

当前 Relationship Engine 已经有 per-turn clamp，应复用。

## Prompt 不再主要显示裸数字

新增：

```ts
describeRuntimeState(state)
```

例如：

```text
energy < 0.25
→ “精力见底，注意力已经明显下降”

stress > 0.7
→ “压力很高，很难完全放松”

socialBattery < 0.2
→ “社交精力很低，更倾向少说一点”
```

可以保留机器数值作为辅助 JSON，但语言描述是主要 persona context。

---

# P0-17：Reply Strategy 感知状态

当前 `deriveReplyStrategy` 只看：

```text
用户请求
dialogue style
```

升级为：

```text
user request
dialogue style
runtime state
relationship context
```

疲劳时：

```text
降低自然回复长度
减少 sequential chunk 数
增加停顿感 / 简短确认
```

但是：

> 用户明确请求“详细解释”时，不能因为角色疲劳而故意不给必要信息。

角色状态影响表达方式，不应破坏用户任务完成。

---

# P0-18：主动消息原子 claim

当前主动候选已经有：

```text
quiet hours
daily limit
relationship threshold
dedupe
TTL
```

保留。

增加最小安全提交：

```text
pending
→ claim
→ sending
→ sent
```

事务：

```text
UPDATE ... WHERE status='pending' AND revision=expected
```

受影响行数为 0：

```text
不发送
```

这样即使未来引入 LLM 生成消息，也不会出现重复发送。

P0 暂时不做完整 proactive epoch。

---

# P0-19：来源和 lineage 产品化

原修订计划阶段 3 中的：

```text
source badge
timeline lineage
intent → schedule visualization
```

提升到 P0。

原因：

> “为什么角色今天突然去了夜市？”不是开发信息，而是产品真实性的一部分。

Timeline 增加：

```text
来源 badge：
routine
user invitation
self initiated
manual

因果链：
Persona preference
→ PersonalIntent
→ SelfPlanBundle
→ ScheduleItem
→ ActivityEvent
→ Memory
→ ProactiveCandidate
→ Message
```

普通用户界面可以简化。

Developer 模式显示完整 ID 和 event chain。

---

# P0-20：Memory Inspector 最小版

当前 Developer Page 主要是：

```text
FakeClock
Domain Snapshot
LLM Calls
```

增加：

```text
Memory Recall Preview
```

输入：

```text
测试消息
```

显示：

```text
candidate memories
score
namespace
time status
selected / rejected
最终 EvidenceBundle
证据来源
abstention reason
```

接口：

```text
POST /api/developer/agents/:id/memory-recall-preview
```

这能快速排查：

```text
“为什么角色错误想起了这件事？”
```

---

# 5. P0 数据库迁移顺序

当前已有：

```text
001_initial.sql
002_memory_projection.sql
003_rejected_proposals.sql
004_schedule_negotiations.sql
```

推荐继续：

```text
005_personal_intentions.sql
006_schedule_self_initiated.sql
007_memory_evidence.sql
008_memory_semantics.sql
009_proactive_claim.sql
010_runtime_sleep_debt.sql
```

如果当前数据库仍然只是 Demo 数据，可选择一次 reset。

如果保留旧 DB：

```text
旧 Memory 有 message/event source
→ 自动生成 MemoryEvidence

无法确定来源
→ status = needs_review

needs_review
→ 默认不进入 Prompt
```

---

# 6. P0 模块边界要求

当前：

```text
conversation-service.ts
```

已经承担大量编排职责。

P0 新功能不得继续把业务逻辑全部写进这里。

ConversationService 只做：

```text
settle
→ load snapshot
→ assemble prompt
→ request decision
→ delegate validators/services
→ commit orchestration
→ SSE
```

新增独立模块：

```text
apps/server/src/services/
├── personal-intent-service.ts
├── self-planning-service.ts
├── memory-recall-service.ts
└── proactive-delivery-service.ts

packages/features/src/
├── personal-intent.ts
├── self-planning.ts
├── activity-affinity.ts
├── runtime-state-description.ts
└── memory-recall.ts
```

不要把：

```text
free-slot calculation
night rules
memory score
intent grounding
```

直接写进 `conversation-service.ts`。

---

# 7. P0 测试要求

## 7.1 Schedule Ownership

- legacy 与 server bundle 不能同回合同时写；
- PersonalIntent 永不进入 ScheduleNegotiation；
- source 不能由模型伪造。

## 7.2 Grounding

- goal 无效 refId → reject；
- preference 不相关 refId → reject；
- chat quote 无法在 user message grounding → reject；
- 极短无意义 quote → reject；
- spontaneous 不需要 evidence，但仍经过频控。

## 7.3 Intent

- 相同 intent 不重复创建；
- expired 不消费；
- spec version 不兼容时重新评估；
- chat failure 不阻断正常回复；
- DB failure 回滚整个 turn。

## 7.4 Self Planning

- 空闲槽正确；
- 不使用全局 active hours；
- 第一个候选失败会尝试第二个；
- 每轮最多放置一个；
- deterministic seed 重启一致；
- 不覆盖 fixed / committed。

## 7.5 Night Bundle

- create + sleep adjustment 原子成功；
- 任一部分失败整体 rollback；
- 最低睡眠不足拒绝；
- sleep debt 正确增加；
- 次日状态受影响；
- 跨午夜；
- DST；
- 7 天频率。

## 7.6 Memory

- planned 不能变 occurred；
- user statement 不能自动变 shared experience；
- activity memory 必须关联 ActivityEvent；
- 无可靠 memory → recall none；
- runtime time context 不写长期记忆；
- evidence source 不存在 → reject。

## 7.7 State / Relationship

- state delta clamp；
- relationship delta clamp；
- live provider path 实际应用；
- repair 不丢 worldEffects；
- 疲劳改变回复风格但不破坏明确任务。

## 7.8 Proactive

- pending 只能 claim 一次；
- 重启不重复发送；
- quiet time 不发送；
- daily limit；
- source activity 必须存在。

---

# 8. P0 完整演示

新增一个核心 Demo：

```text
1. 创建角色：
   喜欢摄影
   平时自律
   偶尔喜欢晚上一个人散步

2. 用户聊天：
   “我最近发现河边夜景很好看。”

3. Chat：
   角色自然回应
   同时形成 chat-grounded PersonalIntent
   但不声称“我已经安排好了”

4. 时间推进

5. ensureSelfInitiatedPlans：
   根据兴趣、状态和空闲时间
   生成“河边夜景摄影”

6. 如果占用部分睡眠：
   使用 SelfPlanBundle
   调整自己的 sleep
   产生 sleep debt

7. Settlement：
   ActivityEvent
   State Delta
   Memory

8. Timeline：
   用户消息
   → PersonalIntent
   → Self Plan
   → Schedule
   → Activity
   → Memory

9. 下一次聊天：
   角色能够根据证据想起这段经历

10. 重启：
    不重复创建意向
    不重复放置活动
    不重复结算
```

P0 完成时应证明：

> **用户的一句话没有直接操纵角色日程，却真实地影响了角色之后的生活。**

---

# 9. P1：长期连续性

P1 只有在 P0 通过长期模拟后开始。

目标：

```text
30 天甚至更长对话后
Prompt 仍然可控
记忆仍然准确
角色的过去仍然有连续解释
主动联系不过量
```

---

# P1-1：Conversation Retention Policy

新增：

```ts
interface ConversationRetentionPolicy {
  fullVerbatimHours: number;
  softTokenLimit: number;
  hardTokenLimit: number;
  minimumTailTokens: number;
  minimumRecentTurns: number;
}
```

初始建议：

```text
24h full verbatim
8k soft
12k hard
3k tail
12 recent turns
```

这些都是配置，不是硬编码产品真理。

压缩只能发生在：

```text
完整 turn transaction 边界
```

---

# P1-2：Conversation Checkpoint

新增：

```text
conversation_checkpoints
```

```ts
interface ConversationCheckpoint {
  id: string;
  agentId: string;
  sessionId: string;

  fromMessageId: string;
  throughMessageId: string;

  sourceHash: string;
  sourceRevision: number;
  sourceMessageCount: number;

  autobiographySnapshotId?: string;

  status:
    | "pending"
    | "committed"
    | "invalidated"
    | "failed";

  createdAtUtc: string;
}
```

流程：

```text
select boundary
→ snapshot revision/hash
→ LLM summary
→ validate evidence
→ recheck revision/hash
→ commit
```

期间有新消息：

```text
invalidate
```

不能覆盖。

---

# P1-3：Agent Autobiography

新增：

```text
autobiography_snapshots
autobiography_entries
```

```ts
interface AgentAutobiographySnapshot {
  summaryFirstPerson: string;

  importantExperiences: string[];
  relationshipChanges: string[];
  activeGoals: string[];
  unresolvedThreads: string[];
  commitments: string[];

  sourceEvidenceIds: string[];

  fromUtc: string;
  throughUtc: string;
}
```

原则：

```text
DomainEvent = 事实
Message = 证据
ScheduleItem = 计划
ActivityEvent = 发生结果
Autobiography = 角色对事实的解释
```

Autobiography 永远不能反向覆盖事实。

---

# P1-4：Event Card / Verbatim 双索引

新增：

```text
event_cards
message_archive
```

Recall 优先：

```text
Event Card
↓
Verbatim Quote
↓
Date Digest
↓
none
```

每轮只注入：

```text
一个 EvidenceBundle
```

---

# P1-5：Temporal Query / Date Digest

支持：

```text
昨天
前天
上周
上个月
周二
旅行前
晚会之后
```

无法确定：

```text
ambiguous
```

而不是猜。

Date Digest 只能包含目标范围内：

```text
可靠 ActivityEvent
可靠 shared memory
可靠 user event
```

---

# P1-6：Memory Lifecycle

扩展状态：

```text
active
aging
archived
superseded
merged
needs_review
```

增加：

```text
memory_conflicts
memory_merge_history
```

例如：

```text
“我准备考研”
→ active goal

数周后：
“我决定不考了”
→ old superseded
→ new active
```

不是两个目标同时 active。

---

# P1-7：FollowUpIntent

与 ProactiveCandidate 分开。

```ts
interface FollowUpIntent {
  id: string;
  agentId: string;

  subjectType:
    | "user_goal"
    | "user_event"
    | "shared_commitment"
    | "character_commitment";

  contextSummary: string;
  expectedOutcomeDescription: string;

  sourceMessageId: string;

  earliestAtUtc: string;
  expiresAtUtc: string;

  status:
    | "pending"
    | "resolved"
    | "sent"
    | "expired"
    | "cancelled";

  maxAttempts: 1;
  attemptCount: number;

  dedupeKey: string;
}
```

示例：

```text
用户：“明天答辩。”

→ FollowUpIntent

用户先说：
“答辩过了。”

→ resolved

不得第二天再问：
“答辩怎么样？”
```

---

# P1-8：CareCue

CareCue 不主动发送消息。

它只是：

```text
未来在自然上下文中可提及
```

例如：

```text
“用户这周要交作品集”
```

可以在几天后的相关聊天中自然问：

```text
“作品集后来弄得怎么样？”
```

限制：

```text
expires
maxMentions
dismissed
```

避免无限重复。

---

# P1-9：Proactive 双阶段提交

在 P0 atomic claim 基础上升级。

```text
candidate
→ preflight
→ generationEpoch
→ optional LLM compose
→ postflight
→ commit
```

Preflight：

```text
quiet hours
daily cap
relationship
cooldown
user unanswered count
active conversation
candidate expiry
```

Postflight：

```text
agent revision unchanged?
user returned?
new message arrived?
candidate still pending?
same event already discussed?
```

否则：

```text
stale_generation
→ discard
```

---

# P1-10：Prompt Segment Registry

当前 `assembleChatPrompt()` 保留兼容接口。

内部拆为：

```text
01_app_policy
02_character_identity
03_core_persona
04_values_conflicts
05_boundaries
06_autobiography
07_user_model
08_runtime_state
09_relationship
10_current_time
11_current_activity
12_future_schedule
13_retrieved_evidence
14_recent_verbatim
15_reply_strategy
16_user_message
17_output_contract
```

新增：

```ts
interface PromptSegment {
  id: string;
  priority: number;
  tokenBudget: number;
  required: boolean;
  cacheable: boolean;

  render(context: PromptContext): string | null;
}
```

这样未来插件可以注册：

```text
calendar
worldbook
location
multimodal context
```

不用覆盖整个 Prompt。

---

# P1-11：LLM Capability Profile

当前 OpenAI-compatible Provider 已经有：

```text
json_object
Zod validation
repair
retry
token metrics
```

很好。

新增：

```ts
interface LlmCapabilityProfile {
  structuredOutputMode:
    | "native_schema"
    | "json_object"
    | "prompt_json";

  supportsThinkingControl: boolean;
  supportsStreaming: boolean;

  maxContextTokens?: number;
  maxOutputTokens?: number;
}
```

不要默认所有 OpenAI-compatible Provider 都支持：

```text
thinking: disabled
response_format: json_object
```

完全相同。

---

# P1-12：Calendar Scope

新增：

```ts
type CalendarScope =
  | "public_system"
  | "user_private"
  | "character_world";
```

用途：

```text
法定节假日
用户私人纪念日
角色世界节日
角色生日
作品内纪念日
```

私人日期：

```text
不进入 Git
不进入普通日志
只在相关回合注入
```

---

# P1-13：开发者 Memory Inspector 完整版

展示：

```text
query
temporal resolution
namespace filters
all candidates
lexical score
semantic score（若未来启用）
temporal score
importance
relationship score
selected EvidenceBundle
final rendered prompt fragment
source jump
```

增加：

```text
RetrievalRun
```

可回放。

---

# P1-14：ConversationService 瘦身

P0 不应做大范围重写。

P1 在行为稳定后将当前超大编排拆成：

```text
ConversationContextService
TurnDecisionService
WorldEffectService
TurnCommitService
ReplyRepairService
```

`ConversationService` 最终只保留 orchestration。

同样避免：

```text
store.ts
```

无限膨胀。

逐步拆为：

```text
CharacterRepository
ConversationRepository
MemoryRepository
ScheduleRepository
SimulationRepository
```

但不要为了“架构漂亮”一次性重写 DB 层。

---

# P1-15：Simulation Scenario Harness

增加命令：

```bash
pnpm sim:party-invite
pnpm sim:self-initiated
pnpm sim:night-life
pnpm sim:false-memory
pnpm sim:offline-72h
pnpm sim:trip-share
pnpm sim:user-followup
pnpm sim:30-day-life
pnpm sim:checkpoint-conflict
pnpm sim:date-recall
```

每个输出：

```text
initial character
initial state
initial schedule
input
proposal
accepted/rejected effects
domain events
final state
memories
proactive candidates
token cost
```

---

# 10. P1 完成标准

- [ ] 30 天 FakeClock 模拟稳定通过
- [ ] Prompt 不随总消息数无限增长
- [ ] 原始消息没有因压缩丢失
- [ ] Autobiography 有证据链
- [ ] planned 不会被总结成 occurred
- [ ] date query 不跨时间范围乱召回
- [ ] FollowUpIntent 能自动解决 / 取消
- [ ] 主动消息不会在生成期间被用户消息“超车”
- [ ] Memory conflict 能 supersede
- [ ] 派生索引可完整重建
- [ ] ConversationService 不再承载新领域规则

---

# 11. P2：可选体验和生态扩展

P2 不作为单一大版本一次完成。

每项必须先有明确的产品问题。

---

# P2-A：Embedding + Reranker

只有在测试证明：

```text
FTS + 时间 + 标签
召回质量不够
```

之后启用。

接口：

```text
EmbeddingProvider
MemoryReranker
```

流程：

```text
lexical retrieval
+
optional semantic retrieval
→ temporal filter
→ rerank
→ EvidenceBundle
```

即使有 Embedding：

```text
仍然保留 minimum threshold
仍然允许 none
仍然最多注入小量证据
```

---

# P2-B：Worldbook-lite

适用于作品角色。

```ts
interface ContextEntry {
  kind:
    | "canon"
    | "persona_rule"
    | "relationship_memory"
    | "shared_experience"
    | "runtime_memory";

  triggers: string[];
  linkedEntryIds: string[];

  priority: number;

  status:
    | "active"
    | "dormant"
    | "archived";

  timelineScope?: TimeRange;
}
```

用于：

```text
只激活当前场景相关设定
```

而不是每轮塞全部世界观。

---

# P2-C：高级关系模型

在当前：

```text
closeness
trust
familiarity
valence
```

之上增加：

```text
relationship phases
unresolved conflict
repair event
reciprocity
disclosure boundary
commitment history
```

不要把关系变成纯数值养成系统。

必须继续由：

```text
events + evidence
```

支撑。

---

# P2-D：作息漂移和长期习惯变化

原修订计划延期项可以进入这里：

```text
sleep drift
habit formation
habit decay
activity affinity adaptation
seasonal behavior
```

原则：

```text
运行时变化
≠
自动改 CharacterSpec
```

长期变化保存为：

```text
runtime preference
habit projection
```

由用户选择是否“固化”进角色版本。

---

# P2-E：Daydream / Spontaneous Experience

P0 的 spontaneous 只保留 schema 和预算。

P2 才加入：

```text
角色完全没有用户触发的低风险临时活动
```

必须：

```text
seeded
bounded
low-risk
budgeted
persona-grounded
```

不能让 LLM 每小时自由幻想生活。

---

# P2-F：多模态活动分享

完整链路：

```text
ActivityEvent
→ visual scene descriptor
→ character visual consistency
→ image generation
→ ProactiveCandidate
→ user message
```

例如：

```text
角色旅行回来
→ 分享一张 AI 生成的“旅途照片”
```

必须明确：

```text
AI generated
```

不要伪装成真实摄像头照片。

---

# P2-G：桌面 / 移动渠道

后续可以增加：

```text
Electron
PWA
desktop notification
mobile web
messaging adapter
```

但：

> 所有渠道只负责显示和传输，不能各自拥有时间推进逻辑。

唯一真源仍然：

```text
SimulationCursor + SQLite
```

---

# P2-H：外部 Plugin SDK

当前 Trusted Plugin Runtime 足够。

只有需要第三方插件时再设计：

```text
permissions
sandbox
filesystem scope
network scope
version compatibility
migration ownership
signature / trust
```

不要直接把当前 trusted in-process plugin 变成“插件市场”。

---

# P2-I：模型训练 / LoRA

不是当前优先级。

先用结构化角色模型和长期运行数据验证：

```text
人格一致性
决策一致性
关系一致性
```

如果后续发现：

```text
风格提示仍然不足
token 成本过高
```

再实验 LoRA / adapter。

---

# 12. 三个参考项目的最终借鉴矩阵

| 能力 | DeepSeek Harness | Cyrene-Agent | Suzu Lives | ChatPLUS 当前 | 新优先级 |
|---|---|---|---|---|---|
| Microkernel | 强 | 中 | 弱 | 已完成 | 保持 |
| Service Registry | 强 | 中 | 弱 | 已完成 | 保持 |
| Bundle / Profile | 强 | 弱 | 弱 | 已完成 | 保持 |
| Persona Guard | 弱 | 强 | 中 | 已部分完成 | P0/P1 |
| 长期记忆证据 | 中 | 强 | 强 | 部分 | P0 |
| Memory Judge | 弱 | 强 | 强 | 基础 | P0 |
| Evidence-only Recall | 弱 | 中 | 强 | 缺失 live path | P0 |
| Conversation Checkpoint | 弱 | 中 | 强 | 缺失 | P1 |
| Autobiography | 弱 | 中 | 强 | 缺失 | P1 |
| 时间语义 | 中 | 中 | 强 | 部分 | P0/P1 |
| Schedule Simulation | 中 | 弱 | 弱 | 强 | 继续自研 |
| Personal Intent | 弱 | 中 | 中 | 缺失 | P0 |
| Proactive Candidate | 中 | 强 | 强 | 已有 | 增强 |
| Proactive stale guard | 中 | 强 | 中 | 缺失 | P0/P1 |
| One-shot Follow-up | 弱 | 中 | 强 | 缺失 | P1 |
| Care Cue | 弱 | 强 | 中 | 缺失 | P1 |
| Retrieval Inspector | 中 | 中 | 强 | 缺失 | P0/P1 |
| Multimodal | 弱 | 强 | 强 | 缺失 | P2 |
| External plugin ecosystem | 强 | 中 | 弱 | 暂不支持 | P2 |

---

# 13. 不应该借鉴的内容

## 不从 Cyrene-Agent 复制

```text
把角色宣称为真实人类
过度沉浸式身份欺骗
Electron / Live2D / TTS 整套壳
明文凭据存储方式
```

PersonaSim 继续：

```text
UI 明确显示 AI 虚拟角色
```

真实感来自：

```text
时间
记忆
因果
关系
自主生活
```

而不是身份误导。

---

## 不从 Suzu Lives 复制

```text
Claude Code Hook
Claude 专有 JSONL
链式后台 Timer 作为生活模拟
将第一人称摘要当事实
非商业许可证代码直接复制
```

只重新实现设计思想。

---

## 不从 DeepSeek Harness 复制

```text
当前阶段不需要完整外部工具执行 Harness
不需要任意代码插件
不需要重写已经存在的 PluginRuntime
```

---

# 14. 推荐实施顺序

## P0-A：Schedule 与 Effects 基础

```text
1. rebase 自主日程计划到 4ede0f0
2. ScheduleMutationBundle
3. PersonaTurnEnvelope
4. live state / relationship effects
5. server-owned source
```

## P0-B：Memory 正确性

```text
6. namespace
7. MemoryEvidence
8. TemporalMetadata
9. conservative Memory Judge
10. MemoryRecallService
11. EvidenceBundle
12. Memory Inspector
```

## P0-C：Personal Intent

```text
13. PersonalIntent contract
14. personal_intentions migration
15. PersonalIntentService
16. chat intent proposal
17. grounding
```

## P0-D：Self Planning

```text
18. deriveActivityAffinities
19. free-slot calculator
20. deterministic placement
21. ensureSelfInitiatedPlans
22. claim-before-effect
```

## P0-E：Night + State

```text
23. SelfPlanBundle
24. sleep adjustment
25. sleepDebtMinutes
26. next-day state effect
27. qualitative state prompt
28. fatigue reply strategy
```

## P0-F：Proactive + Product Trace

```text
29. proactive atomic claim
30. source badge
31. timeline lineage
32. intent → schedule → event → memory visualization
33. E2E / restart / DST tests
```

---

# 15. P1 推荐实施顺序

```text
1. Retention Policy
2. Conversation Checkpoint
3. Autobiography
4. Event Card
5. Date Query / Date Digest
6. Memory Lifecycle / Conflict
7. FollowUpIntent
8. CareCue
9. Proactive two-phase generation
10. Prompt Segment Registry
11. LLM Capability Profile
12. Calendar Scope
13. Retrieval Run / Inspector
14. ConversationService decomposition
15. 30-day simulation suite
```

---

# 16. P2 推荐实施顺序

不要固定全部执行。

根据数据选择：

```text
Embedding / Reranker
Worldbook-lite
Advanced Relationship
Habit Drift
Spontaneous Daydream
Multimodal Share
Desktop / Mobile
External Plugin SDK
LoRA
```

---

# 17. 建议新增文件

## Contracts

```text
packages/contracts/src/
├── personal-intent.ts
├── memory-evidence.ts
├── temporal.ts
├── follow-up.ts              # P1
├── autobiography.ts          # P1
└── retrieval.ts
```

## Features

```text
packages/features/src/
├── world-effects.ts
├── personal-intent.ts
├── self-planning.ts
├── activity-affinity.ts
├── free-slot.ts
├── self-plan-bundle.ts
├── memory-recall.ts
├── memory-judge.ts
├── runtime-state-description.ts
├── follow-up.ts              # P1
├── checkpoint.ts             # P1
├── autobiography.ts          # P1
└── prompt-segments/          # P1
```

## Server

```text
apps/server/src/services/
├── personal-intent-service.ts
├── self-planning-service.ts
├── memory-recall-service.ts
├── proactive-delivery-service.ts
├── checkpoint-service.ts     # P1
└── follow-up-service.ts      # P1
```

---

# 18. 建议新增 Domain Events

```text
personal_intent.created
personal_intent.merged
personal_intent.expired
personal_intent.claimed
personal_intent.consumed
personal_intent.rejected

schedule.self_plan_committed
schedule.self_plan_failed
schedule.sleep_adjusted

state.sleep_debt_changed

memory.created
memory.superseded
memory.merged
memory.recall_evaluated

followup.created
followup.resolved
followup.sent
followup.expired

checkpoint.created
checkpoint.invalidated
autobiography.updated

proactive.claimed
proactive.stale_discarded
```

关键事件保留：

```text
correlationId
causationId
idempotencyKey
```

---

# 19. Feature Flags / Rollout

不要一次切掉所有旧路径。

推荐：

```env
SCHEDULE_NEGOTIATION_MODE=shadow
SELF_INITIATED_PLANNING=off
LIVE_WORLD_EFFECTS=shadow
MEMORY_RECALL_MODE=legacy
AUTOBIOGRAPHY_MODE=off
PROACTIVE_COMMIT_MODE=atomic
```

上线顺序：

```text
shadow
→ developer compare
→ test parity
→ enforced
→ 保留一个版本 rollback
→ 删除 legacy
```

例如 Memory Recall：

```text
legacy：
按 importance / recency

shadow：
同时计算 Evidence Recall，但仍使用 legacy

enforced：
只向 Prompt 注入 EvidenceBundle
```

Developer Page 显示：

```text
legacy selected memories
new selected evidence
difference
```

这样真实 API 测试风险更低。

---

# 20. 成本控制

P0 原则：

```text
个人规划尽量 deterministic
memory recall 不调用 LLM
affinity 不调用 LLM
free slot 不调用 LLM
sleep debt 不调用 LLM
state transition 不调用 LLM
```

LLM 主要用于：

```text
chat
character compilation
schedule initial planning
important activity enrichment
```

P1 新增模型调用：

```text
checkpoint / autobiography
```

但只在上下文需要压缩时发生。

禁止：

```text
每小时做一次总结
每条 memory 单独判断一次 LLM
每个 self intent 单独调用 LLM 排时间
```

---

# 21. 最终验收：North Star

升级完成后，至少能够证明四条链。

## A. 时间会推进

```text
角色离开屏幕
→ FakeClock / 系统时间前进
→ 再次打开
→ batch settlement
→ 状态和经历变化
```

## B. 互动有后果

```text
用户聊天
→ 不是直接写日程
→ 形成 grounded intent
→ 角色之后自主安排
→ 活动真实发生
```

## C. 关系会积累

```text
用户目标 / 共同经历
→ evidence memory
→ future recall
→ relationship / care cue / follow-up
→ 后续自然行为变化
```

## D. 变化可追溯

```text
用户消息
→ PersonalIntent
→ SelfPlan
→ ScheduleItem
→ ActivityEvent
→ Memory
→ Proactive / Reply
```

任何关键节点都能从 Timeline / Developer Page 找到因果来源。

---

# 22. 最终产品演示脚本

## 场景一：共同协商

```text
角色有自习
用户邀请晚会
→ Schedule Negotiation
→ 角色同意 / 拒绝
→ server-owned command
→ 日程变化
```

这是：

```text
“我们一起改变计划”
```

---

## 场景二：角色自己的生活

```text
用户聊到河边夜景
→ 角色产生兴趣
→ PersonalIntent
→ 用户离开
→ 之后 hourly / activate planning
→ 角色自己安排夜景摄影
→ 必要时调整自己的睡眠
→ ActivityEvent
→ Memory
```

这是：

```text
“你来过，所以我的生活发生了变化；
但不是你替我安排了生活。”
```

---

## 场景三：角色主动分享

```text
夜景摄影完成
→ shareable ActivityEvent
→ ProactiveCandidate
→ quiet / relationship / limit / claim
→ 主动消息

“昨晚去河边拍了一会儿，
比我想的冷，不过灯倒映在水里挺好看的。”
```

---

## 场景四：长期关系

```text
用户：
“我下周作品集要交。”

→ User Model Memory
→ FollowUpIntent / CareCue

数天后：
用户主动说：
“总算交完了。”

→ FollowUp resolved
→ 不再机械询问

未来：
角色可以自然记得这件事
```

---

# 23. 对 Codex 的执行约束

开发时遵守：

1. **不要重写现有 PluginRuntime。**
2. **不要重写 CharacterSpec。**
3. **不要建立第二套 Schedule。**
4. **个人意向和共同协商不共享状态机。**
5. **LLM 不拥有 schedule source、ID、精确持久化时间和 commit 权。**
6. **所有角色写操作继续经过 Actor Queue。**
7. **模型 / 网络调用继续不放在 SQLite transaction 内。**
8. **所有最终日程变化使用 final projection validation。**
9. **计划、实际事件、记忆和角色解释保持不同对象。**
10. **所有新长期记忆必须有可验证 evidence。**
11. **没有可靠 recall 时返回 none。**
12. **Prompt repair 不允许丢失已经验证的 world effects。**
13. **不要求或保存隐藏 chain-of-thought。**
14. **不要把 P1/P2 功能提前塞进 P0。**
15. **新增业务优先进入独立 feature/service，而不是继续扩大 ConversationService。**
16. **每完成一个阶段运行 typecheck、lint、vitest 和相关 Playwright。**
17. **Fixture 必须覆盖所有关键新行为，真实 Provider 只做显式 smoke / integration 验证。**

---

# 24. 推荐版本节点

## v0.2 — Self Life Foundation

包含：

```text
P0
PersonalIntent
SelfPlanning
Night Bundle
Sleep Debt
Memory Evidence Foundation
Evidence Recall
State Closed Loop
Timeline Lineage
```

完成后角色首次真正拥有：

> **不是用户直接安排出来的个人生活。**

---

## v0.3 — Long-term Continuity

包含：

```text
P1
Checkpoint
Autobiography
Event Cards
Temporal Recall
FollowUp
CareCue
Memory Lifecycle
Proactive Two-phase
Prompt Segments
30-day simulation
```

完成后系统首次能够验证：

> **角色经过数周互动仍然保持可解释的连续记忆和关系。**

---

## v0.4+ — Experience Expansion

选择 P2：

```text
semantic retrieval
worldbook
advanced relationship
multimodal
desktop/mobile
external plugins
model adaptation
```

---

# 25. 最终判断

从目前 ChatPLUS 的代码状态看，早期 PersonaSim MVP 计划中的“大部分基础建设已经完成”。

下一阶段最不应该做的是继续增加孤立功能。

下一阶段应该完成两件真正决定项目差异化的事情：

## 第一件

让：

```text
CharacterSpec
```

真正通过：

```text
PersonalIntent
→ SelfPlanning
→ Schedule
→ Settlement
```

变成角色自己的生活。

## 第二件

让：

```text
ActivityEvent
User Message
Relationship Event
```

通过：

```text
Evidence
→ Memory
→ Recall
→ Autobiography
→ FollowUp
```

变成角色可靠的过去。

两条链合起来：

```text
人格决定未来
+
经历塑造过去
+
用户能够影响两者
```

才最终形成 PersonaSim 的核心：

> **他们的人生不会因为你离开而停止，却会因为你来过而发生改变；你的人生也同样如此。**
