# Feature Flag Rollout Guide

> README 与 [ADR 0006](adr/0006-fuzzy-life-and-decision-causality.md) 定义纯模糊生活方向；[ADR 0007](adr/0007-temporal-correspondence.md) 定义分阶段书信、离线补算、封缄回信和纪念物边界。精确日程相关 flag 只服务于历史数据兼容和回归对照，不再具有产品晋级含义。

## 当前状态总览（2026-09-03）

| Flag                        | 取值                             | 默认       | 阶段                         | 说明                                                                                        |
| --------------------------- | -------------------------------- | ---------- | ---------------------------- | ------------------------------------------------------------------------------------------- |
| `LIFE_PLANNING_MODE`        | fuzzy / legacy_exact             | `fuzzy`    | 本地核心方向                 | 产品运行不注入未来精确日程；`legacy_exact` 只供旧测试和迁移回归                             |
| `SCHEDULE_NEGOTIATION_MODE` | off / legacy / shadow / enforced | `off`      | **产品路径已废弃**           | fuzzy 模式会强制归一化为 `off`；其余值仅在 `legacy_exact` 迁移回归中生效                    |
| `SELF_INITIATED_PLANNING`   | off / shadow / enforced          | `off`      | **旧精确排程已关闭**         | 历史 `PersonalIntent → ScheduleItem` 投影只供迁移回归；新的模糊生活上下文由独立领域模型承载 |
| `LIVE_WORLD_EFFECTS`        | off / shadow / enforced          | `enforced` | 本地核心闭环                 | 默认校验、限幅并事务化提交状态/关系 proposal；shadow/off 仅用于显式对照                     |
| `MEMORY_RECALL_MODE`        | legacy / shadow / enforced       | `enforced` | 已作为本地默认连续性路径     | 仅把带持久化、受支持来源的 EvidenceBundle 注入最终 Prompt；legacy/shadow 保留作回滚比较     |
| `AUTOBIOGRAPHY_MODE`        | off / shadow / enforced          | `enforced` | 已作为本地默认连续性路径     | 达到 retention 阈值时生成 checkpoint/autobiography/event cards，并在后续轮次注入验证快照    |
| `CORRESPONDENCE_MODE`       | off / shadow / enforced          | `off`      | **R1/R1.1 已实现，默认关闭** | off 暂停任务；shadow 仅提交确定性抵达/快照；enforced 启用生成、加密、启封和完整闭环         |
| `KEEPSAKE_MODE`             | off / shadow / enforced          | `off`      | **R2 已实现，默认关闭**      | off/shadow 只做读取或资格观察；enforced 才入队并生成有来源、可持久回看的纪念物              |
| ~~`PROACTIVE_COMMIT_MODE`~~ | 已移除                           | —          | 实现已收敛、运行已暂停       | 保留的主动消息实现统一走 `ProactiveGenerationService` 两阶段提交，legacy 单事务路径已删除   |

主动消息的产品能力当前统一为关闭：所有 tier 的 `proactiveDialogue` 都返回
`false`，新角色的 `proactivePolicy.enabled` 默认为 `false`，前端不提供主动对话编辑入口。
这不是可由 `.env` 绕过的 rollout 开关；底层表、历史消息类型和两阶段生成服务仅为兼容读取与后续修复保留。

## 书信首版配置与回滚边界

书信 Contracts、SQLite Repository、时间补算、快照、生成、加密启封、HTTP/SSE、前端以及 resident/worker 已接入同一领域内核。默认 `off` 仍保持现有聊天、记忆和 fuzzy-life 行为，不启动书信 scheduler，也不 claim 到期任务。

| 配置                                 | 首版取值/默认                               | 语义                                                |
| ------------------------------------ | ------------------------------------------- | --------------------------------------------------- |
| `CORRESPONDENCE_MODE`                | `off` / `shadow` / `enforced`；默认 `off`   | 领域变更授权；当前默认关闭                          |
| `CORRESPONDENCE_EXECUTION`           | `lazy` / `resident` / `worker`；默认 `lazy` | catch-up 触发驱动，不改变排序、幂等或领域结果       |
| `CORRESPONDENCE_TRANSIT_POLICY`      | 仅 `fixed_5d_v1`                            | 去程和回程各五个角色时区日历日，封缄时固化 due time |
| `CORRESPONDENCE_GENERATION_LEASE_MS` | 默认 `1800000`                              | 模型生成和 worker task claim 的 30 分钟租约         |
| `CORRESPONDENCE_MAX_OPEN_THREADS`    | 首版仅 `1`                                  | 每个角色只允许一个顺序书信线程                      |
| `KEEPSAKE_MODE`                      | `off` / `shadow` / `enforced`；默认 `off`   | 与书信独立 rollout；仅 enforced 入队并生成资产      |
| `ASSET_STORAGE_PATH`                 | 默认 `./data/assets`                        | 从 workspace root 解析的内容寻址资产目录            |
| `INSTANCE_SECRET`                    | 无默认值                                    | enforced 或数据库已有 fingerprint/密文时必须匹配    |
| `SELFHOSTED_REVERSE_PROXY`           | 默认 `false`                                | 仅 production + HTTPS Caddy 私网边界允许外网绑定    |
| `SERVE_WEB` / `WEB_DIST_PATH`        | 默认 `false` / `./apps/web/dist`            | 单镜像中由 Fastify 提供已构建 Vite 资源             |

运行时遵守 ADR 0007 的模式语义：

- `off` 不启动 scheduler、不 claim task，也不在角色入口偷偷 catch-up；已有列表/详情保持可读，已到达密文在匹配 secret 下仍可启封。
- `shadow` 可提交原信抵达、有效时间推进和不可变 snapshot 等确定性诊断，但不得 claim generation task、调用 LLM 或创建真实回信。模型任务保留，切回 enforced 后仍使用原 snapshot。
- `enforced` 才允许完整书信写入、生成、加密和到达闭环。

纪念物使用独立且更窄的模式边界：`off` 只保留既有纪念物的只读档案；`shadow` 执行确定性来源资格、冷却和去重判断，但不创建纪念物、任务或资产；`enforced` 才允许冻结故事/视觉规格、入队 `keepsake.generate`，并经模板或 `ImageGenerationProvider` 生成 WebP 主资产与缩略图。切回 `off` 不删除既有物件、来源链或内容寻址文件。

启动矩阵已经落地：

| 模式 / 数据状态                           | secret 要求                                 | 启动结果                                                              |
| ----------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------- |
| `off` / `shadow`，无 fingerprint 且无密文 | 可缺省；即使提供也不新建 metadata           | 不启用加密写入；shadow 只跑确定性任务                                 |
| `off` / `shadow`，已有 fingerprint 或密文 | 必须是匹配的规范 Base64（解码至少 32 字节） | 初始化 decrypt-only 能力；缺失、畸形或不匹配时 HTTP/worker 启动前失败 |
| `enforced`，新数据库                      | 必须提供有效实例独立 secret                 | 在 HTTP 或 scheduler 启动前原子写入不可逆 fingerprint                 |
| `enforced`，已有数据库                    | 必须与 metadata 匹配                        | 启用完整加密读写；不匹配时 fail-fast                                  |

错误码固定为 `CORRESPONDENCE_SECRET_REQUIRED`、`CORRESPONDENCE_SECRET_INVALID`、`CORRESPONDENCE_SECRET_MISMATCH` 和 `CORRESPONDENCE_KEY_METADATA_MISSING`。没有默认 secret，也不会静默生成只存在内存中的值。

执行驱动与 mode 独立：`lazy` 不启动常驻 timer，但在启动和相关角色入口调用同一补算服务；`resident` 与 `worker` 都从数据库全局查询最近 due/lease，启动即扫描，浏览器关闭或没有 SSE active agent 也继续处理。两者复用同一个 `TemporalCatchUpService`；跨进程竞争由 SQLite exact claim/lease 仲裁。`shadow` 的常驻查询只包含去程/回程确定性任务，模型任务原样保留；`off` 不启动。FakeClock set/advance 会在补算后唤醒 scheduler。

书信 rollback 是切回 `off` 并保留表和历史，不删除信件。`018_temporal_correspondence.sql` 与 `019_correspondence_key_metadata.sql` 建立书信数据和密钥元数据；`020_keepsakes.sql` 独立建立纪念物、来源、回信挂接、资产与生成运行，并扩展共享时间任务种类。关闭功能时保留这些历史表，不做破坏性降级。

## 纪念物、关系档案与本地分享

R2/R3 已实现但保持默认关闭的纪念物写入策略。纪念物只接受已发生/已确认的生活结果、关系里程碑、反思或已读信件；planned、unknown、未来有效时间和低显著性来源都会在确定性门控中被拒绝。语义签名、来源、故事字段和 `visualSpecHash` 在入队时冻结；重试与 Provider 切换不能改写故事含义。二进制资源不进入 SQLite，而是经 Sharp 去元数据、限制尺寸并以 SHA-256 内容寻址保存到 `ASSET_STORAGE_PATH`。

角色回信提交后最多异步挂接一件纪念物；入队或图像生成失败不会撤回或阻塞正文。只有进入 `ready` 的物件才会出现在回信、聊天/后续书信的有界证据投影、陈列柜和分享选择中。书信正文、密文、原始角色材料和完整 Prompt 不会进入图像 Provider。

关系档案聚合已寄出/已抵达信件、已确认的关系转折、生活事件和 ready 纪念物，并使用服务端游标分页。普通列表对未启封回信只投影信封状态；分享默认只包含信封、邮戳、等待天数和用户明确勾选的 ready 纪念物。正文摘录必须由用户主动开启、精确匹配已读/可分享信件并应用预览涂黑；导出由浏览器 Canvas 生成本地 PNG，不上传，也不创建公开 URL。

本地常驻、自托管 Caddy/HTTPS/Basic Auth、实例目录隔离以及 checkpoint/backup/restore 的操作步骤见[自托管与备份恢复指南](SELF_HOSTING.md)。备份 manifest 只保存 schema、数据库/资产哈希和不可逆 fingerprint；`INSTANCE_SECRET` 必须与数据库备份按同一恢复批次保管，但绝不写入 manifest。

现有场景隔离护栏 `apps/server/src/scenarios/acceptance-scenario-isolation.test.ts` 继续扫描正式 server/features 源码，防止“山鸣影像、许宁、9 月 14/16 日”等验收故事标记进入生产规则。本阶段不修改 `FuzzyLifeService`；故事专用匹配继续只存在于 scenario fixture、script 或 test 中。

## 验收证据索引

- 书信常驻/worker 与自托管：
  - `apps/server/src/runtime/temporal-task-scheduler.test.ts`：全局扫描、最近 due timer、错误隔离/退避、重复 tick 串行化、stop/dispose 与 lazy 不启动。
  - `apps/server/src/runtime/temporal-task-scheduler-composition.integration.test.ts`：resident/worker 无 SSE 仍处理、off/lazy 矩阵、FakeClock wake、停机跨 due 后与持续运行收敛到相同事实。
  - `apps/server/src/runtime/instance-backup.test.ts`：checkpoint backup、严格 manifest、secret/实例隔离、失败零残片、拒绝覆盖，以及恢复后重复 worker tick 不重复提交。
  - `apps/server/src/production-static.integration.test.ts`：Vite 静态资源和 SPA navigation 可用，同时未知 API/SSE 始终保持 JSON 404 边界。
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
