# Feature Flag Rollout Guide

> 原则：**不要一次切掉所有旧路径。** 每个能力独立走
> `shadow → developer compare → test parity → enforced → 保留一个版本 rollback → 删除 legacy`。

## 当前状态总览（2026-08-22）

| Flag                        | 取值                       | 默认     | 阶段                                  | 说明                                                                                     |
| --------------------------- | -------------------------- | -------- | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `SCHEDULE_NEGOTIATION_MODE` | legacy / shadow / enforced | `shadow` | 集成测试齐备，待 rollout              | 服务端协商状态机有独立测试；受版本控制的默认值仍是 shadow                                |
| `SELF_INITIATED_PLANNING`   | off / shadow / enforced    | `off`    | 代码完成，待 rollout                  | shadow 下 planner 只出 bundle 不落库，可在 Developer Page 对比                           |
| `LIVE_WORLD_EFFECTS`        | off / shadow / enforced    | `shadow` | enforced 集成路径通过，待 shadow 观测 | 30 天测试包含一次非空 state/relationship delta；不等于真实流量验证                       |
| `MEMORY_RECALL_MODE`        | legacy / shadow / enforced | `legacy` | 默认 retention 长跑通过，待 rollout   | 测试验证选中的 EvidenceBundle 进入最终 Prompt trace；shadow 不改变 legacy 注入           |
| `AUTOBIOGRAPHY_MODE`        | off / shadow / enforced    | `off`    | 默认 retention 长跑通过，待 rollout   | 控制 checkpoint、autobiography 及 checkpoint-derived event cards，不控制全部 event cards |
| ~~`PROACTIVE_COMMIT_MODE`~~ | 已移除                     | —        | 已收敛                                | 主动消息统一走 `ProactiveGenerationService` 两阶段提交，legacy 单事务路径已删除          |

## 验收证据索引

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
