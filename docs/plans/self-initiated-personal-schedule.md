# 计划书：角色自发型个人日程（Self-Initiated Personal Schedule）

- **状态**：已定稿，待实施
- **日期**：2026-08-17
- **基线分支**：`codex/schedule-negotiation-refactor`（b983e5f）
- **实施顺序**：阶段 1 → 阶段 1.5 → 阶段 2；阶段 3 本轮不做，仅预留扩展点
- **完成标准**：每阶段结束时 `pnpm typecheck` 六包全绿、`npx vitest run` 全量通过（现有 210 项不回归）后才进入下一阶段

---

## 1. 背景与目标

排程协商重构（ADR 0005）之后，聊天产生的日程修改仅限**与用户的共同约定**：模型返回有界对话动作，服务端规范化条款，两阶段确认后提交。用户必须先提议（"一起跑步吗"），角色只能接受、拒绝或反提议。

本计划补上缺失的另一半：**角色自主产生个人日程**。用户聊天中提到华山很好玩，角色可能在未来的空闲时间安排自己去华山；天文爱好者角色会自己去天文馆；这些安排不需要用户提议、不需要用户确认——"角色有自己的生活"是本产品的核心立意（README："他们的人生不会因为你离开而停止"）。

产品意图：

- 让用户不是唯一的输出方：角色过自己的日子，产生新话题，与主动消息能力对齐；
- 允许"自发型幻觉"（没人提过、角色自己长出来的欲望）——这是模拟行为，不是谎言；
- 仍然禁止对**共享现实**的虚构：声称用户说过没说过的话、声称存在与用户的约定、声称尚未结算的事"已经发生"。

## 2. 关键设计决策（讨论定稿）

| # | 决策 | 理由与被否方案 |
|---|---|---|
| D1 | 个人意向与共同协商是**两条独立通道**：新模型输出字段 `personalIntent`，不进 `ScheduleNegotiationAction`，不受 `SCHEDULE_NEGOTIATION_MODE` 影响 | 协商状态机为"双方契约+两阶段确认"设计；个人安排的契约方只有角色自己，用户无须批准。混入协商词表会污染 reducer 契约 |
| D2 | basis 五通道 grounding：`goal`/`preference`/`routine`（refId 引用已发布人格条目）、`chat`（逐字引文）、`spontaneous`（免校验但严预算） | 守门边界从"对话证据"挪到"人格一致性+可验证锚点"。`spontaneous` 通道保证创造力不被掐死，代价是频率更低 |
| D3 | 类别亲和向量**运行时惰性推导**，不持久化进 spec | 从 routines/goals/preferences 关键词确定性推导，编辑人格字段即间接控制倾向；避免改 CharacterSpec 契约、旧数据兼容、编辑器 UI 三项成本（约省 300–400 行）。升级路径见阶段 3 |
| D4 | 聊天回合只产生**意向**（时间窗口而非时刻），由规划边界**延迟落地** | "未来的空闲时间"这类模糊表达由确定性规划器对着权威日程解算，LLM 永不解析确切时刻（与 ADR 0005 "服务器拥有时间解析"一致）；"回头再安排"的延迟是拟真加分项 |
| D5 | **无全局活跃钟点**：空闲槽 = 角色自身日程（含其个人睡眠窗口）的补集；受限**夜行通道**允许偶尔与睡眠条目重叠（凌晨观星/夜跑），配对睡眠 reschedule 使代价显形 | 否决了早期草案的 09:00–21:00 全局对齐——那把"角色自己的作息"替换成了"产品规定的作息"。夜猫子行为由人格（nightOwlBias）与频控约束，而非禁止 |
| D6 | 阶段 1.5 状态感知闭环：live 决策补 `stateDelta`/`relationshipDelta`、prompt 状态定性化、回复策略读状态 | 现状检查结论：状态的模拟闭环成立（结算驱动+完成率反馈环），但感知闭环断裂——live 路径聊天不改状态、关系永久冻结（卡死主动消息 minimumCloseness 门槛）、prompt 只有裸数字无表达指令、reply-strategy 不读状态。夜行通道"熬夜代价显形"依赖此闭环 |

## 3. 核心不变量

1. 个人意向与共同协商是两条独立通道：意向不进入协商状态机、不受 `SCHEDULE_NEGOTIATION_MODE` 影响、不需要用户确认。
2. 聊天回合只写 `personal_intentions` 表；只有规划边界（`ensure72Hours`）能消费意向写日程。
3. 每条意向至多消费一次（幂等键 `schedule:${agentId}:self_plan:${intentId}`）。
4. basis 可验证：`goal`/`preference`/`routine` 的 refId 必须存在于已发布 spec；`chat` 引文必须逐字命中近期用户消息；`spontaneous` 免校验但受预算约束（7 天 < 2 条）。
5. 自发型条目只落空闲时段、`rigidity: "flexible"`、永不与 fixed/committed 冲突；夜行落位只可与**角色自己的睡眠条目**重叠，且必须配对睡眠 reschedule（"无重叠、睡眠存在"两条校验保持成立）。
6. 全链路确定性：抽样用 `seededUnit`，FakeClock 下可重放。
7. 回复只能表达意图；落地前不得声称"已安排"（truthful-reply 新增独立 issue code，不被 enforced 过滤器移除）。
8. 无全局活跃钟点约束；"活跃"完全由角色自身日程（含其个人睡眠窗口）定义。

## 4. 阶段 1：聊天产生意向并持久化

### 4.1 contracts（packages/contracts，~150 行）

- **新文件 `src/personal-intent.ts`**：
  - `TimePreferenceSchema = z.enum(["next_few_days", "next_weekend", "next_week", "any_free_time"])`
  - `PersonalIntentBasisSchema`：discriminated union on `kind`：
    - `{ kind: "goal" | "preference" | "routine", refId: string(1-64) }`
    - `{ kind: "chat", evidenceQuotes: string[].min(1).max(8) }`（每条 1-500）
    - `{ kind: "spontaneous" }`
  - `PersonalIntentProposalSchema = { activity: string(1-160), category: ScheduleCategorySchema, timePreference, durationMinutes?: int 5-1440, basis }.strict()`
- **`src/persona-chat-decision.ts`**：`PersonaChatDecisionShapeSchema` 加 `personalIntent: PersonalIntentProposalSchema.optional()`；preprocess 增加顶层/嵌套 reply 提取（照抄 `scheduleAction` 的 loose 模式，校验失败静默丢弃）。**不改** `ScheduleNegotiationActionSchema`。
- **`src/schedule.ts:41`**：`ScheduleSourceSchema` 枚举追加 `"self_initiated"`（全库无 exhaustive switch 消费 source，类型检查可证实无破坏；前端为宽泛字符串比较）。
- **`src/index.ts`** 导出；`personal-intent.test.ts` 覆盖 schema 接受/拒绝。

### 4.2 数据层（~260 行）

- **迁移 `apps/server/src/db/migrations/005_personal_intentions.sql`**（仿 004 与 `proactive_candidates` 结构原型）：

  ```sql
  CREATE TABLE IF NOT EXISTS personal_intentions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,  -- chat 产生有值；daydream 预留 NULL
    activity TEXT NOT NULL, category TEXT NOT NULL, duration_minutes INTEGER NOT NULL,
    earliest_at_utc TEXT NOT NULL, latest_at_utc TEXT NOT NULL,
    basis_kind TEXT NOT NULL, dedupe_key TEXT NOT NULL,
    record_json TEXT NOT NULL,   -- 含 basis 细节、来源消息 id、night 标记
    status TEXT NOT NULL CHECK (status IN ('active','consumed','expired')),
    created_at_utc TEXT NOT NULL, updated_at_utc TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS personal_intentions_active_dedupe
    ON personal_intentions(agent_id, dedupe_key) WHERE status = 'active';
  CREATE INDEX IF NOT EXISTS personal_intentions_agent_status_idx
    ON personal_intentions(agent_id, status, latest_at_utc);
  ```

  dedupe_key = `normalizeText(category) + ":" + normalizeText(activity)`（`normalizeText` 复用 features/shared.ts）。
- **`apps/server/src/db/store.ts`**：`StoredPersonalIntention` 类型 + 参数化方法（仿 schedule_negotiations 系列）：
  - `insertPersonalIntention`（撞 active 唯一索引→捕获并返回既有行，合并语义）
  - `listActivePersonalIntentions(agentId, nowUtc)`（`status='active' AND latest_at_utc >= nowUtc`）
  - `markPersonalIntentionsConsumed / markPersonalIntentionsExpired(ids, nowUtc)`
  - `countPersonalIntentionsSince(agentId, sinceUtc, kinds?)`（预算统计）
  - `db/personal-intentions.test.ts`：去重、窗口过滤、状态迁移。

### 4.3 服务层：新文件 `apps/server/src/services/personal-intent-service.ts`（~250 行）

`form(input)` 校验链（任一失败返回 rejection，**不抛错、不影响聊天回合**）：

1. **basis 校验**：goal/preference/routine → refId 存在于 `spec.persona.goals|.preferences` / `spec.routines`（三者均有稳定 EntityId）；chat → 逐条引文经 `evidenceQuoteIsExact` 命中当前或近期用户消息（**将 `evidenceQuoteIsExact`、`resolveOfferEvidence` 从 schedule-negotiation-service.ts:882-916 提取到共享模块 `apps/server/src/services/evidence.ts`**，两处引用避免复制）；spontaneous → `countPersonalIntentionsSince(agentId, now-7d, ["spontaneous"]) < 2`。
2. **夜语义标记**：activity 文本命中 `/观星|拍星|星空|夜跑|夜市|深夜|通宵|流星|night|stargaz|midnight/iu` → `record.night = true`。
3. **窗口解析**（纯函数，放 features 便于单测）：`next_few_days`→[now+2h, now+72h]；`next_weekend`→下个周六 09:00–周日 21:00（角色本地时区，当前即周末且已过周日则顺延）；`next_week`→下周一 00:00 起七天；`any_free_time`→[now+2h, now+14d]。
4. **duration 默认**：`DEFAULT_DURATION_MINUTES` 从 schedule-negotiation-service.ts:29-41 提取到 `packages/features/src/categories.ts` 两处共用。
5. **落库 + 审计**：`createEntityId("pintent")`；事务内 `insertDomainEvent({ streamType: "personal_intention", eventType: "personal_intention.formed", idempotencyKey: `personal-intent:${sessionId}:${correlationId}`, payload: { basis, window, merged, night } })`。

### 4.4 聊天回合接入（apps/server/src/services/conversation-service.ts）

- 构造函数实例化 `PersonalIntentService`（照 `ScheduleNegotiationService` 模式 :114-118）。
- 资格判定（与协商资格并列、**provider 无关，fixture 也启用**）：`chatEffectsMode !== "off" && capabilities.schedule && spec.tier === "high_fidelity" && spec.schedulePolicy.enabled`。
- `decidePersonaReply`：eligible 时 `effectsContract` 追加 `buildPersonalIntentContract()`（basis 五种取法、timePreference 枚举、"回复可表达意愿但不得声称已安排"）；返回值增加 `personalIntentProposal`。
- **fixture 路径**（`decideFixtureTurn`）：确定性规则——用户消息命中灵感关键词（`/天文馆|博物馆|华山|爬山|展览|电影|音乐会|旅行|跑步|游泳|星空|拍星/u`）→ chat basis（引文取用户原话，天然过逐字校验）；否则 `seededUnit(`fixture-intent:${agentId}:${clientMessageId}`) < 0.2` → spontaneous（活动取首个 goal/preference 标题关键词，类别经导出的 `categoryFrom` 映射）。
- **事务接线**（现有 `store.transaction` 内、`insertMessage(assistantMessage)` 之前）：accepted → formed 审计事件（幂等键绑定 clientMessageId，重放安全）；rejection → `insertRejectedProposal({ purpose: "chat_turn", reasonCode: "personal_intent_"+code })`（复用现有表）。
- **truthful-reply**：新 `personalPlanClaim(text)` 正则（"已经/已…安排(好/了)…"），issue code `uncommitted_personal_plan_claim`；`isUncommittedScheduleIssue`（:1968-1977）**不**过滤该 code，enforced 模式同样触发修复。
- **回复拼接**（仿 `appendNegotiationPresentation`）：`【心意已记下】${activity}（${本地窗口描述}）。到时候看自己的安排。`——明确"尚未排期"。

### 4.5 prompt-assembler（packages/features/src/prompt-assembler.ts）

- `AssemblePromptInput` 加 `personalIntentEligible?: boolean`；为 true 时 decisionInstructions（含 reply_only 模式文案）与输出契约允许 `personalIntent` 键，prompt 追加 `PERSONAL_INTENT_CONTRACT` 块。`compactCharacter` 不变（亲和为惰性推导）。

## 5. 阶段 1.5：状态感知闭环

> 现状检查结论（2026-08-17）：状态模拟闭环成立（settlement-engine.ts:100-130 结算驱动 + state-engine.ts:112-134 完成率反馈环 + schedule-planner.ts:53-68 昼夜恢复），但感知闭环断裂：live 路径 `PersonaChatDecisionSchema` 无 `stateDelta`/`relationshipDelta` 字段（fixture 路径的 `AgentTurnDecisionSchema` turn.ts:14-15 有），`applyTurnState` 早退导致 live 聊天对状态与关系零影响、**关系永久冻结**（卡死主动消息 `minimumCloseness=0.45` 门槛）；prompt 只有裸数字（compactRuntimeState）无表达指令；`deriveReplyStrategy` 不读状态。本阶段补全感知闭环，与阶段 1 触及同一批文件，紧跟着做避免二次返工；阶段 2 夜行通道的"代价显形"依赖本阶段。

### 5.1 live 路径状态与关系解冻（persona-chat-decision.ts + conversation-service.ts）

- **契约**：`PersonaChatDecisionShapeSchema` 新增：
  - `stateDelta: ScheduleStateEffectsSchema.optional()`——**不复用** `RuntimeStateDeltaSchema`（它含 `currentActivityId`/`locationContext` 服务器所有权字段，不能让模型写；`ScheduleStateEffectsSchema`（schedule.ts:50）恰好是六个数值字段）；
  - `relationshipDelta: RelationshipDeltaSchema.optional()`。
  - preprocess 照 loose 模式宽容提取（非对象/含非法值→丢弃该字段，不影响回复本体）。
- **接线**：`materializePersonaReply` / `materializeDecisionResponse` 把两个 delta 透传进内部 `AgentTurnDecision`（可选字段与 `applyTurnState` 消费逻辑**已存在**，fixture 路径在用——这是对齐而非新建）。
- **安全钳制**：`applyTurnState`（conversation-service.ts:2029-2089）在累加前先过 `clampStateDelta`（state-engine.ts:37-47，单次变更 ±0.5）——当前实现直接累加，模型返回 `energy: -5` 会瞬间砸穿到 0；relationshipDelta 继续按 `capabilities.relationshipDeltaScale` 缩放，与 fixture 路径同构。
- 测试：live 决策带 stateDelta 的应用与钳制、关系跨回合增长、fixture 回归不变、能力门控（lightweight tier 不生效）不变。

### 5.2 Prompt 状态定性化（prompt-assembler.ts，~60 行）

- 新增 `describeRuntimeState(state): string[]`：阈值映射为中文短语——energy<0.25"精力见底"/<0.45"有些疲惫"、stress>0.7"压力很大"、socialBattery<0.3"社交电量不足"、moodValence<-0.3"情绪低落"/>0.3"心情不错"、focus<0.3"难以集中"；空数组=一切如常时不注入。
- system prompt（dynamicState 能力开启时）追加："当前状态会以文字描述提供，让它自然影响你的语气、耐心和回复长度；不要直接报告或解释这些数值。"
- `compactRuntimeState` 增补 `currentActivity`：conversation-service 在组装前把 `state.currentActivityId` 解析为对应条目标题传入（"正在做的事"进入聊天上下文）；裸数值保留。
- `locationContext` 死字段清理**不**在本阶段（进阶段 3）。

### 5.3 回复策略读状态（reply-strategy.ts，~40 行）

- `deriveReplyStrategy(userMessage, dialogue, state?)` 新增可选第三参（向后兼容，现有调用不受影响）：
  - **疲劳调整**：`energy < 0.35 || focus < 0.35` → 各档目标长度 ×0.65（仍受档位下限保护）、`deliveryPreference` 收敛向 `prefer_single_block`；
  - 只做这一个确定性耦合，不做反向"亢奋加长"——规则少而可解释。
- prompt-assembler 在有 state 时传入。
- 测试：疲劳态长度收缩、分段收敛、无状态入参时输出逐字节不变（防回归）。

## 6. 阶段 2：亲和推导、作息感知落位与夜行通道

### 6.1 features 纯函数：新文件 `packages/features/src/self-planning.ts`（~500 行含测试）

- `deriveActivityAffinities(character): { affinities: Record<ScheduleCategory, number>; nightOwlBias: number }`——惰性推导：routines/persona 关键词匹配（复用导出后的 `CATEGORY_KEYWORDS`）计分归一化 0..1，无命中类别基线 0.1；nightOwlBias 从夜向关键词（`/熬夜|夜猫|星空|摄影|夜跑|失眠|night owl|insomni/iu`）扫描，默认 0.05，上限 0.4。
- `resolvePersonalIntentWindow(timePreference, timezone, nowUtc)`（阶段 4.3 第 3 步实现落点）。
- `planSelfInitiatedActivities(input: { character, intentions, existingItems, nowUtc, horizonEndUtc, affinities, nightOwlBias }): { placements, skipped }`：
  - **预算**：本次至多放置 1 条；活跃意向按 `亲和 × 新鲜度` 降序，同分按 created_at 升序。
  - **采样**：`seededUnit(`self:${intentId}:${localDayKey(now)}`) < 0.4 + affinity/2` 才落位（保留"这次没安排成"的随机感，确定性可重放）。
  - **默认通道（日间/一般）**：对 `[max(now+2h, earliest), min(horizonEnd, latest)]` 内非 cancelled 条目求补集得空闲槽，过滤 `gap ≥ duration + 30min 缓冲`，取满足条件的最早起。**无任何全局钟点对齐——"活跃时段"完全由角色自身日程（含其睡眠条目）的补集定义**（决策 D5）。
  - **夜行通道**：当 `record.night === true` 或 `seededUnit(`night:${intentId}`) < nightOwlBias` 时，候选槽额外允许与**睡眠条目**（category=sleep 的自有条目）重叠，但永不与 fixed/committed 非 sleep 条目重叠；夜行窗口限定本地 21:00–05:00（跨午夜判断参照 proactive-dialogue.ts:53-70 现成写法）；滚动 7 天夜行落位 ≤ 1 次（由调用方按已落位 self_initiated 条目的本地起始钟点 ∈ [21,05] 计数，传入 existingItems 判定）。
  - **夜行配对效果**：placement 返回 `sleepDisplacement?: { sleepItemId, newStartAtUtc, newEndAtUtc }`——受影响睡眠条目入睡点推至活动结束、起床时间不变（睡眠缩短）；活动条目 stateEffects 加码（energy -0.2、视类别 mood 微正），使熬夜代价在次日状态显形（经阶段 1.5 的感知闭环被角色与用户感知）。
  - **条目构造**：`source: "self_initiated"`、`rigidity: "flexible"`、`priority = 0.35 + affinity×0.3`、`adherenceProbability: 0.72`、`narrativeImportance: 0.6`、`shareable: true`（为阶段 3 主动消息预留）、`stateEffects` 复用 `categoryEffects`（夜行叠加如上）、title/description 注明"自己的安排：${activity}"。
- **`model-effects.ts`** 导出 `CATEGORY_KEYWORDS`、`categoryFrom`；**`schedule-planner.ts`** 导出 `categoryEffects`（如未导出）。

### 6.2 边界消费接线（schedule-service.ts `ensure72Hours`）

- 挂钩点：越过剩余时长闸门（:100 后）、现有事务（:185-218）内、计划条目 insert 完成之后（所有规划边界——publish / settleAndExtend / demo seed——都汇聚于 `ensure72Hours`）。
- 流程：
  1. `listActivePersonalIntentions(agentId, nowUtc)` 为空则跳过。
  2. `deriveActivityAffinities(spec)` + `planSelfInitiatedActivities({ existingItems: store.listSchedule(...) })`（同连接同事务，可见刚插入的计划条目）。
  3. placements → 构造效果数组：create（reasonCode `self_initiated_plan`）+ 夜行的配对 sleep reschedule；经 `validateEffectsPartial(agentId, effects, nowUtc, { allowSleepWindowOverlap: true })` → `applyValidatedEffects`。reschedule 排在 create 之后（前缀语义下校验时已能看到新条目占位）。
  4. **幂等消费**：逐 intent `insertDomainEvent({ streamType: "schedule", eventType: "schedule.self_plan_created", idempotencyKey: `schedule:${agentId}:self_plan:${intentId}`, payload: { intentId, itemId, basis, night } })`——INSERT OR IGNORE 返回 false 即已消费，跳过标记；true 才 `markPersonalIntentionsConsumed`。
  5. 窗口已过的活跃意向顺手 `markPersonalIntentionsExpired`。
- **`validateEffectsPartial` / features `validateScheduleProposals`**：加可选 `options.allowSleepWindowOverlap`（默认 false，行为完全不变），仅跳过 SLEEP_WINDOW_VIOLATION 单项检查，且仅此调用点使用；OVERLAP / OVERLAP_FIXED / 每日上限等其余校验全部保留。
- SSE 不新增事件：调用方已发 `settlement.completed`，前端据此 invalidate。
- 集成测试（`personal-intent.integration.test.ts`）：意向产生→FakeClock 越过规划边界→日间落位正确→**夜行落位配对睡眠 reschedule 且无重叠**→夜行 7 天频控→**重启数据库后重放不重复消费**→窗口过期→预算与去重→fixed 条目占用时寻找下一空档→`allowSleepWindowOverlap` 默认关闭回归→fixture 全链路确定性断言。

## 7. 阶段 3（本轮不做，扩展点已预留）

1. **承诺记忆回写**：记忆 schema 补 scheduleItemId/活动事件引用字段；结算完成对应日程时把 `kind: "commitment"` 记忆标记为已兑现（叙述从"我们约好了"演进为"那天我们去了"），避免旧承诺记忆在活跃集滞留到自然过期。
2. **daydream / 独处时刻**：挂 `settleAndExtend`，每日幂等键 `daydream:${agentId}:${localDateKey}` 门控；live 走新 LLM purpose（`LlmPurpose` 枚举 + providers 的两个穷尽 Record 是编译期检查点），fixture 确定性规则；意向表 `session_id NULL` 与 basis `spontaneous` 已预留。
3. **主动消息关联**：settlement-service.ts:492-499 候选门槛为 `self_initiated` 类别白名单放行（条目已置 `shareable: true`）；文案模板沿用。
4. **前端**：ScheduleRail.tsx:22,36-40 徽标（"自己的安排"）、TimelinePage meta 展示 source。
5. **作息弹性演化**（赖床/睡眠保持时长版本、次日 flexible 条目联动）——夜行通道的自然延伸。
6. **亲和向量持久化升级**：如需编辑器可见可改，发布时推断写入 spec（origin: model_inference），见决策 D3 的升级路径。
7. **locationContext 死字段清理**：全库无写入点，删除或实现（进 schema 变更批次）。
8. **过去时断言校验**（"上次我去了"）：以活动事件为真源的真话检查扩展。

## 8. 文件级改动清单汇总

| 区域 | 文件 | 阶段 | 规模（估） |
|---|---|---|---|
| contracts | personal-intent.ts（新）、persona-chat-decision.ts、schedule.ts、index.ts | 1 | ~150 行 |
| server db | 005 迁移、store.ts、evidence.ts（新，自协商服务提取） | 1 | ~260 行 |
| server services | personal-intent-service.ts（新）、conversation-service.ts | 1 | ~400 行 |
| features | prompt-assembler.ts、reply-strategy.ts | 1.5 | ~180 行 |
| contracts / server | persona-chat-decision.ts（delta 字段）、conversation-service.ts（钳制+透传） | 1.5 | ~170 行 |
| features | self-planning.ts（新）、categories.ts（新）、model-effects/schedule-planner 导出、schedule-validator.ts（选项） | 2 | ~500 行 |
| server services | schedule-service.ts（消费接线） | 2 | ~150 行 |
| 测试 | contracts / features / store / 集成 四层 | 全程 | ~650 行 |
| 文档 | ADR 0006、README | 2 完成后 | ~110 行 |

总计约 2450 行。

## 9. 测试与验证计划

1. **每阶段门禁**：`pnpm typecheck`（六包）+ `npx vitest run` 全量（当前基线 210 项全绿，2026-08-17 验证）。
2. **分层测试**：
   - contracts：新 schema 接受/拒绝、loose 提取；
   - features（纯函数单测）：窗口解析、亲和推导、空闲槽计算、夜行判定与配对 reschedule、seeded 确定性、reply-strategy 疲劳调整；
   - store：意向表去重/窗口/状态迁移；
   - 集成：端到端链路（产生→边界→落地→幂等→重启）、夜行频控、`allowSleepWindowOverlap` 回归、live delta 钳制与关系解冻。
3. **fixture 手动场景**（Fixture provider + FakeClock）：
   - 对演示角色说"听说华山很好玩"→回复出现【心意已记下】；
   - 推进 FakeClock 越过规划边界→日程出现 `self_initiated` 条目；
   - 对含"星空/拍星"话题或夜猫子人格的角色→凌晨槽位落位且睡眠条目被配对 reschedule、次日 energy 下降；
   - live 决策返回 `stateDelta: {socialBattery: -0.4}`→状态/UI 同步更新，连续对话的疲劳态回复长度收缩；
   - 开发者页时间线可见 `personal_intention.formed` 与 `schedule.self_plan_created` 审计事件。

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| spec 无关性 | 不改 CharacterSpec 契约，无旧数据兼容问题（意向是独立新表） |
| `ensure72Hours` 复杂度上升 | 消费逻辑全部收敛在事务内且幂等键保护；自发型放置失败只记 skipped，不参与计划覆盖校验，`schedule_fallback_invalid` 兜底路径不受影响 |
| `ScheduleSourceSchema` 扩枚举 | 全库无 exhaustive switch 消费 source（类型检查证实）；前端为宽泛字符串 |
| 睡眠窗口校验放宽的边界 | `allowSleepWindowOverlap` 仅单调用点、单检查项；配对 reschedule 保证"无重叠、睡眠存在"两条硬校验仍成立；频控防熬夜常态化 |
| 夜行窗口跨午夜判定 | 用 luxon 本地钟点区间判断，参照 proactive-dialogue.ts:53-70 跨午夜静默期现成写法 |
| live delta 被模型滥用 | `clampStateDelta` ±0.5 钳制 + 能力门控；`currentActivityId`/`locationContext` 不开放给模型 |
| 状态定性化误报 | 阈值保守（仅显著偏离才注入短语）；一切如常时不注入任何文案 |

## 11. 明确的非目标（本轮不做）

daydream、主动消息关联、前端徽标、亲和向量编辑器 UI、过去时断言校验、完整作息漂移、locationContext 清理——均列于阶段 3 清单，扩展点已在数据模型（session_id NULL、shareable、basis spontaneous）与代码结构上预留。

## 附录：关键代码触点索引（实施时参照）

| 触点 | 位置 | 用途 |
|---|---|---|
| 规划边界汇聚点 | apps/server/src/services/schedule-service.ts:60-220（`ensure72Hours`，:100 剩余时长闸门） | 阶段 2 消费挂钩 |
| 效果校验/应用 | schedule-service.ts:246-270（`validateEffectsPartial`）、:316-350（`applyValidatedEffects`，自身不开事务） | 落地复用 |
| 确定性抽样 | packages/features/src/shared.ts:41-50（`seededUnit`）、:28-35（`stableHash`） | 所有随机点 |
| 重叠/缓冲 | shared.ts:52-64（`overlaps`）、schedule-planner.ts:120-135（`collidesWithBuffer` 15min 缓冲） | 空闲槽计算 |
| 意向表结构原型 | migrations/001_initial.sql:131-144（`proactive_candidates`：窗口/状态/cooldown_key/部分唯一约束） | 迁移 005 模板 |
| 协商表结构原型 | migrations/004_schedule_negotiations.sql（部分唯一活跃索引） | 迁移 005 模板 |
| 审计事件模式 | schedule-service.ts:198-217、conversation-service.ts:657-684 | `self_plan_created` 事件模板 |
| 引文校验 | schedule-negotiation-service.ts:882-916（待提取至 evidence.ts） | chat basis |
| 类别关键词/时长默认 | model-effects.ts:117-128（`CATEGORY_KEYWORDS`）、schedule-negotiation-service.ts:29-41（`DEFAULT_DURATION_MINUTES`） | 亲和推导与 duration |
| 跨午夜区间 | proactive-dialogue.ts:53-70（`isWithinQuietHours`） | 夜行窗口判定 |
| 状态反馈环 | state-engine.ts:112-134、settlement-engine.ts:100-130 | 1.5 的机制基础 |
| fixture 决策 | conversation-service.ts:1398-1522（`fixtureDecision`）、providers/fixture-llm.ts:547-551（`chatFixture`） | fixture 规则接入点 |
| 灵感词表参考 | model-effects.ts:82-85（`SCHEDULE_INTENT_PATTERN`） | fixture 关键词设计参照 |
