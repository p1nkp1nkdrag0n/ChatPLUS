# Feature Flag Rollout Guide（纯模糊生活方向）

> README 与 [ADR 0006](adr/0006-fuzzy-life-and-decision-causality.md) 定义当前产品方向。精确日程相关 flag 只服务于历史数据兼容和回归对照，不再具有产品晋级含义。

## 当前状态总览（2026-09-03）

| Flag                        | 取值                             | 默认       | 阶段                     | 说明                                                                                        |
| --------------------------- | -------------------------------- | ---------- | ------------------------ | ------------------------------------------------------------------------------------------- |
| `LIFE_PLANNING_MODE`        | fuzzy / legacy_exact             | `fuzzy`    | 本地核心方向             | 产品运行不注入未来精确日程；`legacy_exact` 只供旧测试和迁移回归                             |
| `SCHEDULE_NEGOTIATION_MODE` | off / legacy / shadow / enforced | `off`      | **产品路径已废弃**       | fuzzy 模式会强制归一化为 `off`；其余值仅在 `legacy_exact` 迁移回归中生效                    |
| `SELF_INITIATED_PLANNING`   | off / shadow / enforced          | `off`      | **旧精确排程已关闭**     | 历史 `PersonalIntent → ScheduleItem` 投影只供迁移回归；新的模糊生活上下文由独立领域模型承载 |
| `LIVE_WORLD_EFFECTS`        | off / shadow / enforced          | `enforced` | 本地核心闭环             | 默认校验、限幅并事务化提交状态/关系 proposal；shadow/off 仅用于显式对照                     |
| `MEMORY_RECALL_MODE`        | legacy / shadow / enforced       | `enforced` | 已作为本地默认连续性路径 | 仅把带持久化、受支持来源的 EvidenceBundle 注入最终 Prompt；legacy/shadow 保留作回滚比较     |
| `AUTOBIOGRAPHY_MODE`        | off / shadow / enforced          | `enforced` | 已作为本地默认连续性路径 | 达到 retention 阈值时生成 checkpoint/autobiography/event cards，并在后续轮次注入验证快照    |
| ~~`PROACTIVE_COMMIT_MODE`~~ | 已移除                           | —          | 实现已收敛、运行已暂停   | 保留的主动消息实现统一走 `ProactiveGenerationService` 两阶段提交，legacy 单事务路径已删除   |

主动消息的产品能力当前统一为关闭：所有 tier 的 `proactiveDialogue` 都返回
`false`，新角色的 `proactivePolicy.enabled` 默认为 `false`，前端不提供主动对话编辑入口。
这不是可由 `.env` 绕过的 rollout 开关；底层表、历史消息类型和两阶段生成服务仅为兼容读取与后续修复保留。

## 验收证据索引

- 30 天默认 retention（24h/8k/12k/3k/12 turns）HTTP 集成长跑：
  `apps/server/src/services/continuity-default-policy-long-run.integration.test.ts`
  - 测试以 deterministic provider boundary 运行，证据召回、自传和 world effects 显式设为 enforced；遗留精确日程不参与产品验证。
  - 验证非空 world effects、后续 29 轮 EvidenceBundle 召回注入、care cue continuity、持久化 `promptSegmentTrace` 的必要 segments/预算、checkpoint/autobiography evidence 与 restart idempotency。
  - 其中 `scheduleAction` 始终为 `none`；schedule negotiation mutation 语义由独立测试套件覆盖。
  - 这是 fixture/integration 证据，不是真实 provider 或 rollout 证据。
- 历史 P0 精确日程长跑（DST 夜行 / 29h 离线 / 重启，仅作迁移回归）：
  `apps/server/src/services/personal-life-long-run.integration.test.ts`
- 场景级验收（10 个 sim 场景）：`pnpm sim:p1`（见 `apps/server/src/scenarios/p1-scenario-harness.ts`）
- 当前产品长程验收规格：[纯模糊生活与人生选择长程验证方案](plans/ChatPLUS_Fuzzy_Life_Decision_Long_Run_Plan_v3.md)。新的核心证据是困境、支持、决定、行动、结果和复盘链路，而不是 schedule mutation。

## 晋级检查单（每个 flag 通用）

1. **shadow 运行至少一个真实会话周期**（建议 ≥ 7 天 FakeClock 或真实使用）。
2. **Developer Page 对比**：
   - Memory Recall：`legacy selected memories` vs `new selected evidence` 差异
     （`POST /api/developer/agents/:id/memory-recall-preview` + Retrieval Runs 回放）；
   - Self Planning：模糊生活提案 vs 当日生活背景和长期主线差异；
   - World Effects：shadow 审计的 delta 分布是否合理（无越界、无频繁满 clamp）。
3. **测试 parity**：对应 integration 套件在 enforced 下全绿。
4. **切换 enforced**：一次只切一个 flag，保留至少一个版本的 rollback 窗口。
5. **删除 legacy**：rollback 窗口内无回滚需求后，删除旧路径并更新本表。

> 上述清单现在用于 regression/rollback 评估；memory recall 与 autobiography 已晋级为本地默认。World effects 与 self planning 的 shadow 只承担显式比较和诊断用途。Schedule negotiation 不再参加产品 rollout。

## 已知边界（放量前注意）

- 显式设置 `AUTOBIOGRAPHY_MODE=off` 会停止 checkpoint、autobiography 和 checkpoint-derived event cards；
  历史 settlement 仍可能存在 activity-event cards，但新普通生活不应继续通过精确 `ScheduleItem` 生成它们。
- `MEMORY_RECALL_MODE=enforced` 且 autobiography 关闭时，仍可使用 verified
  verbatim/activity/date-digest evidence，但缺少 checkpoint/autobiography 来源；只有需要
  checkpoint 层次时才应耦合 rollout。
- `.env` 被忽略且属于本地状态；受版本控制的默认值来自 `.env.example`/config，
  文档不能据本地 `.env` 声称部署状态。
- 主动消息恢复前，必须先修复主题归属、已解决事项仍被追问、辅助调用 token/思考预算和完整日志收集问题；恢复后的 quiet hours / daily cap / cooldown 仍由 `ProactiveDeliveryService.loadPolicy` 统一评估。
- 记忆召回候选总池不超过 `candidateLimit`（默认 200）：
  关键词命中最多 50 条优先入池，剩余名额再由 importance 排序补齐；
  若召回质量不足，优先调池参数而不是直接上 embedding。
