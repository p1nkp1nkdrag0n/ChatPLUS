# ChatPLUS LLM 状态闭环 WP0 基线报告

- 执行日期：2026-08-28
- 历史基线：`7082ee21296ebb1e458457921c7631f8d7687971`
- 计划文档提交：`b0009aa2bec43e93867f0e7185d4efb0698a5e22`
- 分支：`codex/llm-state-closed-loop-20260828`
- worktree：`E:\2026\ChatPLUS-state-closed-loop-20260828`
- Node：`v24.16.0`
- pnpm：`11.19.0`
- SQLite migrations：`001_initial.sql` 至 `014_retrieval_run_date_digest.sql`
- worktree `.env`：不存在；基线测试未读取原工作树密钥
- 真实 Provider：未调用

## 基线命令

| 命令                                       | 结果                                |
| ------------------------------------------ | ----------------------------------- |
| `pnpm install --offline --frozen-lockfile` | 通过；319 个包全部从本地 store 复用 |
| `pnpm typecheck`                           | 通过                                |
| `pnpm lint`                                | 通过                                |
| `pnpm test`                                | 通过；89 个文件、622 个测试         |
| `pnpm build`                               | 通过                                |

## Characterization 证据

新增测试只冻结基线行为，不修改生产公式：

| 缺口                         | 基线证据                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 默认 world effects 未落库    | 无显式环境变量时 `LIVE_WORLD_EFFECTS=shadow`；shadow proposal 有审计但 RuntimeState/relationship 不变                     |
| 默认 self planning 不运行    | 无显式环境变量时 `SELF_INITIATED_PLANNING=off`；既有 PersonalLifeService off-mode 测试确认不读取 intent、不规划、不写状态 |
| 普通无 delta 回合不积累关系  | enforced 空 `worldEffects` 回合不增加 revision、不更新 familiarity、不写 `lastInteractionAtUtc`                           |
| 离线批结算使用批次起始状态   | 构造前一活动显著降低 energy/提高 stress 的两活动批次，后一活动仍按 batch-start state 判定为 completed                     |
| world-effects audit 只有摘要 | committed 事件只有 delta 是否存在、候选数、rejection code 和 limits；没有 proposal、applied、before 或 after              |

Characterization 命令：

```text
pnpm vitest run apps/server/src/config.test.ts apps/server/src/services/conversation-real-path.integration.test.ts packages/features/src/schedule-settlement.test.ts
```

结果：3 个文件、35 个测试全部通过。

## WP0 结论

历史基线可重复且当前 V4 脏工作树未受影响。上述缺口均有可执行证据，下一步从默认闭环配置与状态语义开始修改生产行为。
