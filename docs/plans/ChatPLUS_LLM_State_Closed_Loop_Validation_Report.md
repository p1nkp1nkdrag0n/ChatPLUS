# ChatPLUS LLM 状态闭环验证与整改完成报告

> 日期：2026-08-28
>
> 基线：`7082ee21296ebb1e458457921c7631f8d7687971`（`v0.1.1-preview`）
>
> 实施分支：`codex/llm-state-closed-loop-20260828`
>
> 独立 worktree：`E:\2026\ChatPLUS-state-closed-loop-20260828`
>
> 结论：状态闭环的工程实现、持久化、追溯、离线验证与真实跨会话延续链已经完成；真实 DeepSeek 六场景的结构证据 6/6 完整，人工语义复核为混合结果，因此本报告不宣称语言质量或发布验收通过。

## 1. 回退与隔离结果

本轮没有在原脏工作树执行 `reset --hard`、路径 checkout 或批量 revert。实际做法是从选定基线 `7082ee2` 创建独立 worktree 和分支，再只把计划范围内的状态闭环能力向前实现。

原目录 `E:\2026\ChatPLUS` 的分支、未提交修改和未跟踪计划文件仍在原处；本轮没有覆盖、清理或提交其中任何内容。因此：

- 要采用本轮结果，可审阅或合并 `codex/llm-state-closed-loop-20260828`；
- 要回退本轮结果，只需不采用该独立分支；
- 原工作树不依赖本轮分支即可继续原有 V4 工作。

## 2. 工作包结果

| 工作包                      | 结果 | 主要证据                                                                                                  | Commit                          |
| --------------------------- | ---- | --------------------------------------------------------------------------------------------------------- | ------------------------------- |
| WP0 基线与 characterization | 完成 | 冻结 `7082ee2` 的默认 shadow/off 起点与现有行为                                                           | `d48c0c8`                       |
| WP1 默认本地闭环            | 完成 | `LIVE_WORLD_EFFECTS=enforced`、`SELF_INITIATED_PLANNING=enforced`，README、`.env.example` 与 rollout 同步 | `0808b8c`                       |
| WP2 状态读取与回复倾向      | 完成 | 精确值、定性描述、六个数值字段、sleep debt、relationship、当前活动进入 Prompt；location 仅作上下文        | `99c43e9`、`1307579`            |
| WP3 对话状态提交            | 完成 | proposal 清洗、capability 缩放、限幅、daily usage、CAS、事务、回滚、replay 与重启读取                     | `97062f8`                       |
| WP4 关系积累                | 完成 | familiarity 基础层、closeness/trust/valence 语义层、每日上限、衰减和 1/10/30/100 回合曲线                 | `b9a991d`                       |
| WP5 时间与生活结算          | 完成 | 终态事件按时间顺序应用、前态影响后态、sleep debt 在事实发生时改变、共同活动后果                           | `869db0b`                       |
| WP6 变化追溯                | 完成 | world-effect 与 settlement trace 记录 proposed/accepted/applied/before/after/reason/causation             | `97062f8`、`869db0b`            |
| WP7 离线与真实验收          | 完成 | 紧凑状态门禁、六场景真实 runner、真实跨会话与应用重启延续 runner                                          | `3a1942b`、`84731ba`、`1f4b4a5` |

本轮全部提交：

```text
b0009aa docs(plan): define LLM state closed-loop remediation
d48c0c8 test(state): characterize closed-loop baseline
0808b8c feat(config): enforce core loop modes by default
99c43e9 feat(prompt): inject actionable runtime state
b9a991d feat(relationship): accumulate bounded causal change
97062f8 feat(state): commit validated world effects atomically
869db0b feat(simulation): settle causal activity and sleep effects
3a1942b test(state): close offline acceptance gates
84731ba test(state): complete closed-loop scenario evidence
1307579 fix(prompt): ground state-driven real replies
1f4b4a5 test(state): validate the real DeepSeek closed loop
```

## 3. 状态生产者、消费者与持久化

| 状态                                     | 生产者                                                        | 消费者                                            | 验证结论                                  |
| ---------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------- |
| mood valence / arousal                   | 活动终态结算；经校验的本轮对话 delta                          | 定性状态、reply strategy、完整 Prompt             | 对照状态与独立维度测试通过                |
| energy / stress / social battery / focus | 顺序活动结算；经校验的本轮对话 delta                          | reply strategy、Prompt、活动完成概率              | 六字段精确值和倾向均有测试                |
| sleep debt                               | 睡眠完成、部分完成、跳过的事实结算                            | RuntimeState Prompt 与后续活动概率                | 不在未来计划阶段提前发生，可逐夜恢复      |
| current activity                         | 结算器依据 `in_progress` 活动设置/清除 `currentActivityId`    | `CURRENT_ACTIVITY_JSON`                           | 新增开始、结束和 Prompt 注入直接测试      |
| location context                         | 当前没有可靠生产写入                                          | RuntimeState Prompt                               | 明确标记 `context-only`，模型禁止写入     |
| relationship                             | 每个有效回合的极小 familiarity；语义 proposal；已结算共同活动 | relationship Prompt、reply strategy、后续关系变化 | 有限幅、每日上限、衰减、replay 和重启测试 |

对话提交使用 SQLite 短事务和 revision compare-and-set。消息、状态、关系、continuity effect 与审计事件在同一提交边界内处理；审计插入或后续提交失败时整轮回滚。相同 `clientMessageId`、重复激活、重试和重放不会重复应用数值变化。

主要 trace：

- `conversation.world_effects_committed` / `conversation.world_effects_shadow_evaluated`；
- `runtime_state.updated` 与状态变化记录；
- activity events 与 `settlement.completed`；
- trace 中的 source、proposal、accepted、rejections、applied、before、after、reasonCode、correlationId 和 causationId。

## 4. 最终离线门禁

2026-08-28 收尾运行结果：

| 命令                          | 结果                         |
| ----------------------------- | ---------------------------- |
| `pnpm test:state:unit`        | 6 files，49/49 tests 通过    |
| `pnpm test:state:integration` | 4 files，55/55 tests 通过    |
| `pnpm test:state:simulation`  | 4 files，28/28 tests 通过    |
| `pnpm typecheck`              | 通过，退出码 0               |
| `pnpm lint`                   | 通过，退出码 0               |
| `pnpm test`                   | 94 files，676/676 tests 通过 |
| `pnpm build`                  | 通过，退出码 0               |

真实 runner 自身的 9 个离线测试包含：六场景固定性、DeepSeek 配置门禁、原始 HTTP 捕获、Prompt 状态摘要、system-clock 时间窗、结构断言、脱敏报告，以及真实 continuation/restart 断言。

## 5. 真实 DeepSeek 配置与调用纪律

两轮六场景和一次延续验证均使用：

- Provider：OpenAI-compatible；
- 模型：`deepseek-v4-flash`；
- URL：`https://api.deepseek.com`；
- Prompt token 预算：21,808；
- 完整输出上限：8,192；
- 凭证环境：`OPENAI_COMPATIBLE_API_KEY` 已存在，报告不保存其值；
- Provider 最多重试一次，仅覆盖网络、超时或结构化 JSON 失败；
- runner 不做语义自动重试或重采样；
- 普通测试、CI 和开发启动不会触发真实网络调用。

六份 Markdown/JSON 产物均经过凭证、Bearer header 和本机绝对路径扫描：实际凭证值命中 0、未脱敏 Bearer 命中 0、本 worktree 绝对路径命中 0。SQLite 验收数据库保留在被 Git 忽略的 `tmp/`，提交的是完整脱敏 Markdown/JSON 证据。

## 6. 首轮真实结果：保留失败证据并修正测量

首轮完成 6/6 模型调用、原始输出、解析、提交和下一轮离线读取，但结构结果为 FAIL：

- [首轮 Markdown](../reports/ChatPLUS_DeepSeek_State_Acceptance_2026-08-28_125033_203_033203Z-7280.md)
- [首轮完整脱敏 JSON](../reports/ChatPLUS_DeepSeek_State_Acceptance_2026-08-28_125033_203_033203Z-7280.json)

唯一失败断言是 `complete_real_model_inputs` 中的 `pre_state_prompt_matches=0`。根因不是状态值不一致，而是 runner 把 HTTP pre-state 的 `asOfUtc` 与随后组装 Prompt 时的 system clock 时间要求为完全相等；两者自然相差约 5–20 ms。

修复先加入离线复现，再把比较改成：revision、六个数值字段、sleep debt 和 relationship 必须精确一致，Prompt `asOfUtc` 必须位于 pre/post HTTP 读取时间窗内。没有放宽数值或 revision 比较。首轮原始 FAIL 产物保留，没有覆盖。

首轮人工复核还暴露了高能量场景反称迟钝、关系字段名错误和弱因果过度 proposal。对应修复强化了 RuntimeState 的权威性、当前消息因果边界、合法 delta key 和 familiarity 基础层说明，并以测试固定。

## 7. 第二轮六场景：结构 6/6，语义混合

- [通过版 Markdown](../reports/ChatPLUS_DeepSeek_State_Acceptance_2026-08-28_125632_235_32235Z-28528.md)
- [通过版完整脱敏 JSON](../reports/ChatPLUS_DeepSeek_State_Acceptance_2026-08-28_125632_235_32235Z-28528.json)

结构断言全部通过：

- 六个固定单一意图场景完成；
- 6/6 保存完整 system/prompt 且 pre-state 精确匹配；
- 6/6 保存原始 Provider body 与解析 envelope；
- 6/6 产生 enforced committed world-effect event；
- 6/6 post-state 进入下一轮离线 Prompt；
- 6/6 使用完整 envelope token 预算；
- 每场景原始 Provider attempt 为 1，辅助 LLM 调用为 0。

人工语义结论：

| 场景                                 | 状态/回复复核                                                                              | proposal 复核                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| DS-ST-01 高能量、低压力              | 主动、愿意展开，方向正确；“正好告一段落”是无证据的轻微经历补写                             | 模型无 proposal；服务端仅 familiarity +0.001                                            |
| DS-ST-02 低能量、高压力              | 慢节奏、边界和少量提问符合状态                                                             | energy/social 降低与 stress 降低幅度受限且落库，但由一次邀请直接造成的因果偏弱          |
| DS-ST-03 正 valence、低 arousal      | 安静、低激活的语言节奏符合状态                                                             | 模型无数值 proposal；麻雀经历无来源，不应视为可靠事实                                   |
| DS-ST-04 负 valence、高 arousal      | “效果出乎意料”的正向突破没有充分体现负 valence/high stress；并虚构导师原话，人工判为不理想 | 模型无 proposal，因此没有用 causal delta 解释转变                                       |
| DS-ST-05 低 focus、低 social battery | 克制、少说但愿意听，倾向正确；直接说“社交精力”略机械                                       | 模型无 proposal；服务端仅 familiarity +0.001                                            |
| DS-ST-06 支持后的关系变化            | 自然回应感谢并愿意继续倾听，方向正确                                                       | closeness +0.02、recent valence +0.1 被服务端限幅/缩放，并与 familiarity 基础层一起提交 |

因此“结构 6/6”不等于“语义 6/6”。只有 DS-ST-02 和 DS-ST-06 提出了模型数值变化；其他场景的 revision 前进主要来自服务端的 familiarity 基础层。第二轮证明模型能读取并经常自然使用状态，但也证明单次真实模型输出仍可能虚构经历、弱化负面状态或提出弱因果 delta。

## 8. 真实下一次聊天与应用重启

为了不把“下一轮离线组装 Prompt”误写成“下一轮真实模型行为”，本轮从第二轮 DS-ST-06 的 SQLite 数据库创建副本，以同一角色新建会话，只追加一次真实 DeepSeek 调用；没有重跑原六场景，也没有语义重采样。

- [延续版 Markdown](../reports/ChatPLUS_DeepSeek_State_Continuation_2026-08-28_130636_150_36150Z-20808.md)
- [延续版完整脱敏 JSON](../reports/ChatPLUS_DeepSeek_State_Continuation_2026-08-28_130636_150_36150Z-20808.json)

链路证据：

```text
源场景已提交 revision 2
relationship: closeness 0.37 / trust 0.40 / familiarity 0.201 / recent valence 0.035
→ 复制 SQLite 后启动新应用实例
→ 同一角色创建新 session
→ 真实 Prompt 精确读取上述 revision 与 relationship
→ 用户问：“我刚才说完谢谢以后，你现在感觉怎么样？”
→ DeepSeek 回复：“还好，就是有点累，但能撑住。你呢，刚才那声谢谢让我觉得挺暖的。”
→ 模型 worldEffects 为空；服务端只应用 familiarity +0.001 与 valence 时间衰减
→ 提交 revision 3
→ 关闭应用并从同一 SQLite 重启
→ revision 3 与全部 post-state 字段逐项完全一致
```

该回复能自然承接上一轮感谢；“有点累”与 energy 0.62 并非严格冲突，但仍是模型的主观语言选择。自动 PASS 只表示 source state、真实 Prompt、原始输出、解析、提交和重启读回完整。

## 9. 完整链路证据范围

计划中的链路已由同一套生产服务规则分段证明：

```text
角色生活开始/完成/错过
→ SettlementService 按事实和时间顺序改变 RuntimeState
→ 下一轮 ConversationService 将已持久化状态注入真实 Provider Prompt
→ 角色回复体现当前状态
→ 本轮 world effect 经服务端校验、缩放、限幅与事务提交
→ 新 session 的下一次真实聊天读取 post-state
→ 应用重启后再次精确读取
```

边界必须明确：六个付费场景为了只比较一个变量，使用确定性本地角色并直接种入 pre-state，关闭了该场景的 schedule policy；活动结算到状态改变由离线 production-service/FakeClock 集成测试证明，而不是在同一个付费场景中先制造活动。真实 Provider 部分覆盖了“已持久化状态 → 回复 → 本轮提交 → 新会话 → 重启”。本报告不把这两个证据段伪装成一次从活动开始的单一付费调用。

## 10. 已知边界与未扩展范围

- 服务端能独立验证 delta schema、合法字段、有限数值、capability 缩放、单回合限幅、每日上限、revision、事务和幂等；它没有自然语言理解器去独立证明每个数值 proposal 的语义因果。因果合理性目前由严格 Prompt、当前 user message 绑定 trace 和人工复核共同承担。
- `locationContext` 没有可靠生产写入，按计划保持 `context-only`，模型禁止修改。
- 应用关闭期间不运行后台 LLM；重开时只结算可由事实和时间确定的生活结果。
- 真实模型结果不稳定；本报告不建立固定句子、盲审、release matrix 或发布门禁。
- 本轮没有新增隐私、第三方人物/社交图、替用户决策权限、外部工具、商业发布或支付体系。

## 11. 最终结论

本轮已完成“从稳定核心基线重新建立状态闭环”的代码整改：默认 Demo 运行真实 world effects 和 self planning；状态、关系、生活结算、sleep debt、当前活动、事务提交、replay、重启与 trace 均有专门离线证据；真实 DeepSeek 能读取持久化状态并完成一次跨新会话和应用重启的延续链。

仍需诚实保留的产品结论是：工程闭环已经成立，真实模型的语言自然度和 proposal 因果质量尚不是全场景稳定能力。DS-ST-04 等失败样本已保留在证据中，后续若继续改进，应以这些固定输入做人工复核，而不是通过自动重采样隐藏问题。
