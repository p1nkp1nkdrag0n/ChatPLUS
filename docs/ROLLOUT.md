# Feature Flag Rollout Guide

> 配套计划：`docs/plans/ChatPLUS_PersonaSim_Integrated_Upgrade_Plan_v2.md` §19。
>
> 原则：**不要一次切掉所有旧路径。** 每个能力独立走
> `shadow → developer compare → test parity → enforced → 保留一个版本 rollback → 删除 legacy`。

## 当前状态总览（2026-08-22）

| Flag | 取值 | 默认 | 阶段 | 说明 |
|---|---|---|---|---|
| `SCHEDULE_NEGOTIATION_MODE` | legacy / shadow / enforced | `shadow` | 已具备 enforced 条件 | 服务端协商状态机完整；本仓库 `.env` 已在 enforced 运行 |
| `SELF_INITIATED_PLANNING` | off / shadow / enforced | `off` | 代码完成，待放量 | shadow 下 planner 只出 bundle 不落库，可在 Developer Page 对比 |
| `LIVE_WORLD_EFFECTS` | off / shadow / enforced | `shadow` | 已通过长跑验证 | enforced 下 live state/relationship delta 才实际生效 |
| `MEMORY_RECALL_MODE` | legacy / shadow / enforced | `legacy` | 已通过 30 天长跑 | enforced 下 Prompt 只注入 EvidenceBundle；shadow 记录对比但不改变 legacy 注入 |
| `AUTOBIOGRAPHY_MODE` | off / shadow / enforced | `off` | 已通过 30 天长跑 | 这是 checkpoint / event_cards / autobiography 的总开关 |
| ~~`PROACTIVE_COMMIT_MODE`~~ | 已移除 | — | 已收敛 | 主动消息统一走 `ProactiveGenerationService` 两阶段提交，legacy 单事务路径已删除 |

## 验收证据索引

- 30 天默认 retention（24h/8k/12k/3k/12 turns）+ 全 enforced 长跑：
  `apps/server/src/services/continuity-default-policy-long-run.integration.test.ts`
  （prompt 有界、原始消息全保留、checkpoint/autobiography 带证据、重启幂等）
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

## 已知边界（放量前注意）

- `MEMORY_RECALL_MODE=enforced` 且 `AUTOBIOGRAPHY_MODE=off` 时，event_cards 不会产生
  （唯一生产入口是 checkpoint 流水线），层级召回会退化到 verbatim / date digest。
  建议两者一起放量。
- 主动消息的 quiet hours / daily cap / cooldown 在 `ProactiveDeliveryService.loadPolicy`
  统一评估；`settlement-service` 不再承担投递职责。
- 记忆召回候选池 = importance 前 200 ∪ 关键词命中（`readRecallCandidateRecords`），
  关键词池上限 50；若召回质量不足，优先调池参数而不是直接上 embedding。
