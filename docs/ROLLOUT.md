# Feature Flag Rollout Guide

> 原则：**不要一次切掉所有旧路径。** 每个能力独立走
> `shadow → developer compare → test parity → enforced → 保留一个版本 rollback → 删除 legacy`。

## 当前状态总览（2026-08-23）

| Flag                        | 取值                       | 默认     | 阶段                                  | 说明                                                                                     |
| --------------------------- | -------------------------- | -------- | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `TURN_PIPELINE_MODE`        | legacy / shadow / enforced | `legacy` | 本地实现完成，待 shadow 证据          | 拆分理解、权威执行与 reply-only 生成；shadow 只记录安全 diff，不写第二份状态             |
| `PERSONA_CONTEXT_MODE`      | legacy / shadow / enforced | `legacy` | 本地实现完成，待 split 稳定后 shadow  | stable persona 常驻；goals/preferences/contradictions 按 ContextPlan 激活                |
| `SCHEDULE_NEGOTIATION_MODE` | legacy / shadow / enforced | `shadow` | 集成测试齐备，待 rollout              | 服务端协商状态机有独立测试；受版本控制的默认值仍是 shadow                                |
| `SELF_INITIATED_PLANNING`   | off / shadow / enforced    | `off`    | 代码完成，待 rollout                  | shadow 下 planner 只出 bundle 不落库，可在 Developer Page 对比                           |
| `LIVE_WORLD_EFFECTS`        | off / shadow / enforced    | `shadow` | enforced 集成路径通过，待 shadow 观测 | 30 天测试包含一次非空 state/relationship delta；不等于真实流量验证                       |
| `MEMORY_RECALL_MODE`        | legacy / shadow / enforced | `legacy` | 默认 retention 长跑通过，待 rollout   | 测试验证选中的 EvidenceBundle 进入最终 Prompt trace；shadow 不改变 legacy 注入           |
| `AUTOBIOGRAPHY_MODE`        | off / shadow / enforced    | `off`    | 默认 retention 长跑通过，待 rollout   | 控制 checkpoint、autobiography 及 checkpoint-derived event cards，不控制全部 event cards |
| ~~`PROACTIVE_COMMIT_MODE`~~ | 已移除                     | —        | 已收敛                                | 主动消息统一走 `ProactiveGenerationService` 两阶段提交，legacy 单事务路径已删除          |

## 验收证据索引

- Split pipeline 语义与原子性回归：
  `apps/server/src/services/turn-pipeline-regression.integration.test.ts`
  - 覆盖非日程隔离、问题/引用/假设无写入、回复措辞不授权 mutation、understanding no-op 降级、reply fallback 保留已验证 outcome，以及最终 CAS 失败整轮回滚。
  - enforced 模式断言只调用 `turn_understanding` / `reply_generation`，不调用 legacy `chat_turn`。
- ContextPlan 100 轮目标冷却：
  `packages/features/src/context-plan-long-run.test.ts`
  - 100 轮均经过真实 Prompt assembler 与 fixture `reply_generation`；输出文本测得主动目标回摆率 2.20%、显式目标召回率 100%、10 个话题领域、最大同领域连续 2 轮、总结式结尾率 4%。
  - 重复主动回摆被 fatigue 抑制，用户明确点名时重新激活。
- DeepSeek 验收 runner 的离线断言：
  `apps/server/src/scripts/deepseek-acceptance-flow.test.ts`
  - 覆盖五个新增 assertion ID、mode-aware Prompt trace、split purpose 审计与报告字段 allowlist；普通测试不访问网络。
  - 付费真实验收仍由操作者显式运行 `pnpm test:deepseek:acceptance` 并保存连续多次报告。
- 30 天默认 retention（24h/8k/12k/3k/12 turns）HTTP 集成长跑：
  `apps/server/src/services/continuity-default-policy-long-run.integration.test.ts`
  - 测试以 deterministic provider boundary 运行，五个 mode flags 均显式设为 enforced。
  - 验证非空 world effects、后续 29 轮 EvidenceBundle 召回注入、care cue continuity、持久化 `promptSegmentTrace` 的必要 segments/预算、checkpoint/autobiography evidence 与 restart idempotency。
  - 其中 `scheduleAction` 始终为 `none`；schedule negotiation mutation 语义由独立测试套件覆盖。
  - 这是 fixture/integration 证据，不是真实 provider 或 rollout 证据。
- P0 自主生活长跑（DST 夜行 / 29h 离线 / 重启）：
  `apps/server/src/services/personal-life-long-run.integration.test.ts`
- 场景级验收（10 个 sim 场景）：`pnpm sim:p1`（见 `apps/server/src/scenarios/p1-scenario-harness.ts`）

## 晋级检查单（每个 flag 通用）

1. **shadow 运行至少一个真实会话周期**（建议 ≥ 7 天 FakeClock 或真实使用）。
2. **Developer Page 对比**：
   - Memory Recall：`legacy selected memories` vs `new selected evidence` 差异
     （`POST /api/developer/agents/:id/memory-recall-preview` + Retrieval Runs 回放）；
   - Self Planning：bundle 提案 vs 实际日程差异；
   - World Effects：shadow 审计的 delta 分布是否合理（无越界、无频繁满 clamp）。
3. **测试 parity**：对应 integration 套件在 enforced 下全绿。
4. **切换 enforced**：一次只切一个 flag，保留至少一个版本的 rollback 窗口。
5. **删除 legacy**：rollback 窗口内无回滚需求后，删除旧路径并更新本表。

> 集成测试通过只代表技术门槛；未完成 shadow 真实会话/Developer 对比前，不应把状态写成已放量。

## Split pipeline 与 ContextPlan 晋级顺序

一次只晋级一个开关：

```text
TURN_PIPELINE_MODE=legacy
→ TURN_PIPELINE_MODE=shadow
→ Developer compare + fixture/integration parity + 多次真实模型验收
→ TURN_PIPELINE_MODE=enforced
→ PERSONA_CONTEXT_MODE=shadow
→ 目标激活/话题疲劳 trace 校准
→ PERSONA_CONTEXT_MODE=enforced
```

组合保护：

- `TURN_PIPELINE_MODE=enforced` 不得搭配 `SCHEDULE_NEGOTIATION_MODE=legacy`；配置加载会拒绝该组合。
- split shadow 的 understanding/execution/reply 是 dry-run，面向用户的回复仍由 legacy path 生成；除 LLM 调用审计和随权威 legacy 回合提交的安全比较事件外，不得写 schedule/state/memory/intent。
- `PERSONA_CONTEXT_MODE` 独立于 turn pipeline：shadow 只记录 ContextPlan trace；enforced 在当前权威路径（legacy 或 split）都要求 ContextPlan，并只注入 stable persona、相关的激活项与有界记忆/证据。
- `LIVE_WORLD_EFFECTS` 不是 `enforced` 时，split observation 可以被审计，但不得改变 next state 或持久化 world effects。
- 两条 legacy 路径至少保留一个版本；本轮不删除 rollback。

Developer Page / domain events 应核对：`turnPipelineMode`、`turnRoute`、`understandingOrigin`、observation confidence/rejected-field codes、schedule outcome、accepted/rejected effect counts、reply repair/fallback、ContextPlan activated/suppressed IDs、`totalChatLatencyMs`，以及 legacy/split shadow diff。分 purpose 的 token/latency 继续读取 LLM call audit；不得记录原始 Prompt、原始模型 JSON 或用户原文。

## 放量指标与回滚门槛

| 指标                                  | 晋级目标 / 回滚信号                                        |
| ------------------------------------- | ---------------------------------------------------------- |
| NonScheduleScheduleInterferenceRate   | 目标 `0`；任一非日程技术回复或 writer event 即停止晋级     |
| ReplyMutationDependenceRate           | 目标 `0`；仅改变回复措辞导致 command diff 即回滚           |
| UnderstandingFailureReplyAvailability | 目标 `100%`                                                |
| ReplyFailureOutcomeRetention          | 目标 `100%`，且最终 CAS 失败时整轮仍原子回滚               |
| UnsolicitedGoalPivotRate              | fixture 初始门槛 `<= 5%`，真实 shadow 后重新校准           |
| GoalActivationRecall                  | 用户明确询问目标时 `>= 95%`                                |
| TopicDomainCoverage                   | 100 轮至少 5 个生活领域；无持续引导时同领域主导不超过 3 轮 |

真实 DeepSeek 验收仍只由操作者显式运行 `pnpm test:deepseek:acceptance`。晋级不能只看一次 PASS：应保存连续多次报告，并人工抽查每轮 objective/reply alignment、非日程隔离、split purpose 审计和技术 fallback 文案。普通测试禁止访问真实网络。

长程伴侣验收使用版本化 `companion-long-run-v1` manifest。离线门禁运行
`pnpm test:companion:long-run`；显式付费真实运行使用
`RUN_PAID_DEEPSEEK_TESTS=true pnpm test:deepseek:long-run -- --turns 30 --runs 1 --pipeline target`。
真实报告与逐轮脱敏日志保存到本地忽略目录
`docs/reports/companion-long-run/`，详细操作与判定规则见
`docs/testing/companion-long-run.md`。`SKIPPED`、`PARTIAL` 或单次 `PASS` 均不能替代
Release Gate 要求的三次独立 100 轮证据。

## 已知边界（放量前注意）

- `AUTOBIOGRAPHY_MODE=off` 会停止 checkpoint、autobiography 和 checkpoint-derived event cards；
  settlement 仍会写入 activity-event cards，因此 event_cards 并非全局关闭。
- `MEMORY_RECALL_MODE=enforced` 且 autobiography 关闭时，仍可使用 verified
  verbatim/activity/date-digest evidence，但缺少 checkpoint/autobiography 来源；只有需要
  checkpoint 层次时才应耦合 rollout。
- `.env` 被忽略且属于本地状态；受版本控制的默认值来自 `.env.example`/config，
  文档不能据本地 `.env` 声称部署状态。
- 主动消息的 quiet hours / daily cap / cooldown 在 `ProactiveDeliveryService.loadPolicy`
  统一评估；`settlement-service` 不再承担投递职责。
- 记忆召回候选总池不超过 `candidateLimit`（默认 200）：
  关键词命中最多 50 条优先入池，剩余名额再由 importance 排序补齐；
  若召回质量不足，优先调池参数而不是直接上 embedding。
