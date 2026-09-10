# ChatPLUS：真实 API 长程连续性验收方案

计划版本：`companion-continuity-real-v1-proposal`。
审查基线：`780a7663582e4284202a8643492b7fd8ae37c87e`。
性质：**待实施的测试规格；本报告没有执行真实 API。附件 JSON 不是现有 CLI 已经支持的输入格式。**

## 1. 测试结论必须拆成五层

1. **机制正确**：来源、幂等、事务、版本、恢复、快照正确。
2. **检索可用**：该召回的证据确实进入最终 prompt，而不只是数据库里有或候选池命中。
3. **模型原始表现**：模型未经服务器修复的回复是否记得正确、符合人格且自然。
4. **最终产品表现**：服务器验证、修复和回退后的结果是否可信、可用，代价是多少。
5. **真人体验**：真人是否感到被听见、相处具有连续性。合成用户、数值状态或 LLM judge 都不能代替这一层。

真实 API 长测不要求全部环节都调用 LLM。推荐主验收用固定人工编写的用户消息，只让角色和产品原有整理/书信流程调用真实模型；这样减少成本和用户模拟器污染。另设自由双模型试聊检查自然互动。

LongMemEval 的信息提取、跨会话推理、时间推理、知识更新、证据不足时不作答五项分类，可作为记忆覆盖框架；不能把它的分数直接当本项目陪伴能力分数。参考作者仓库与论文：
- https://github.com/xiaowu0162/longmemeval
- https://arxiv.org/abs/2410.10813

## 2. 先处理的进入条件

本次审查发现的 F1（否定求助）、F2（扩写污染作用域）、F3（项目近况丢上下文）、F4（永久撤回被“现在”过滤）应先成为模块及服务回归并修复。

F5 是真实测试可解释性的进入条件：实际配置、开关、源码指纹和恢复身份必须完整冻结。否则不同配置跑出的轨迹可能被混成一份证据。

本方案允许小样本探索性运行暴露缺陷，但正式结论不得跳过这些前置条件。

## 3. 现有入口：哪些可以现在使用，哪些必须扩展

### 3.1 离线预演（现有命令）

在隔离 worktree 安装锁定依赖，使用仓库指定 Node / pnpm 版本。以下命令不会因名称中的 long-run 自动获得付费授权：

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build

COMPANION_CONTEXT_MODE=enforced \
PERSONA_RUNTIME_MODE=enforced \
pnpm test:product-life:fixture cc-preflight-780a766
```

Windows PowerShell：

```powershell
$env:COMPANION_CONTEXT_MODE = "enforced"
$env:PERSONA_RUNTIME_MODE = "enforced"
pnpm test:product-life:fixture cc-preflight-780a766
```

run ID 必须唯一，不能覆盖前一次结果。运行后直接读取实际 ServerConfig 和每轮 trace 验证模式，不只检查 shell 环境。

### 3.2 现有42轮真实预演（现有命令，运行会产生费用）

该 CLI 当前固定：用户为 `qwen` 档案、角色为 `bigmodel` 档案。密钥仅由本地配置加载，不写进命令和报告。

```bash
COMPANION_CONTEXT_MODE=enforced \
PERSONA_RUNTIME_MODE=enforced \
RUN_PAID_DUAL_MODEL=1 \
pnpm test:product-life cc-live-pilot-001
```

PowerShell：

```powershell
$env:COMPANION_CONTEXT_MODE = "enforced"
$env:PERSONA_RUNTIME_MODE = "enforced"
$env:RUN_PAID_DUAL_MODEL = "1"
pnpm test:product-life cc-live-pilot-001
Remove-Item Env:RUN_PAID_DUAL_MODEL
```

前提是已完成配置冻结补丁；未经补丁的运行仅作为探索，尤其不要在改变两个新开关后恢复旧 run。

`pnpm test:product-life:resume RUN_ID` 是现有恢复入口，但正式使用前必须补 resumeIdentity。当前输出位于 `tmp/product-life-long-run/<run-id>/`。

旧 v3 的付费授权不同：`RUN_PAID_LONGRUN=1`；其真实 CLI 只接受 `deepseek|bigmodel`，并强制关闭 autobiography。它用于保留决策因果回归，不能冒充本方案的连续性长测。

### 3.3 120轮专项 runner（建议新增，不是现有命令）

建议新增：

```text
apps/server/src/scripts/companion-continuity-real.ts
apps/server/src/scripts/companion-continuity-real-manifest.ts
apps/server/src/scripts/companion-continuity-real-audit.ts
```

这些是建议文件名。不要直接运行一个尚未加入 package.json 的“test:continuity”命令。

复用 product-life 的真实生成、HTTP产品入口、FakeClock、备份、日志和错误恢复；复用旧 v3 的场景 hash、证据索引、分支和原始 Provider 观察能力。不要复制一个新的聊天业务实现。

当前 product-life 使用 `app.inject()`，是真实 Fastify 处理链但不是经过 TCP 的浏览器路径。主测试可沿用；另加独立服务进程和实际本地 HTTP 子测试，检验进程死亡、网络重试和重启。模型 Provider 的外部请求在两种测试中均为真实 API。

现有 product-life 含200物理调用的预算保护。新120轮及附加分支要重新明确预算，不可删除保护，也不可把200直接理解为足够跑完整方案。

## 4. 固定实验身份

每个 run 写入不可变 manifest。至少包含：

```text
runId / parentRunId / branchId
Git commit / dirty diff hash / dependency lock hash
scenarioVersion / public scenario hash / private oracle hash
character input / compiled baseline hash / published version
actual final ServerConfig (redacted)
companionContextMode / personaRuntimeMode
memoryRecallMode / autobiographyMode / liveWorldEffectsMode / lifePlanningMode
correspondenceMode / keepsakeMode / scheduler / time driver
retention policy / context budget / selected evidence limits
all participating policy versions
profile alias / provider / base origin / requested model / response model
reasoning configuration / structured-output mode / output cap / retries / timeout
physical request budget / token or cost ceiling
clock timezone / simulated initial time
```

恢复须逐项或按规范化 hash 比较。不同 commit、策略、模型、retention、两个新开关不允许无提示 resume。确需切换则创建新 run，保留 parent，不将前后结果合并为同一实验条件。

不得仅靠 response.model 字符串证明第三方网关的真实上游身份；报告配置及可观察结果，不多作承诺。

## 5. 角色与对照

### 5.1 主角色 A：无目标、无预设核心矛盾

建议角色“许岚”，独立设计师，日常生活明确但当前没有必须推进的事业项目。重视诚实表达和自主判断，对提前说明困难的失约较宽容，不把一次失误直接等同于人品。说话直接、不惯于长篇说教，能够温和不同意。

不提供 `mainGoal` / `coreContradiction`。作者材料明确“此时没有需要推进的长期项目；不要为完整性补充人生课题”。通过真实 `/api/characters/generate` 生成、正常编辑和发布。保存原始模型草稿及权威回填后的草稿。

检查 `compilationPolicyVersion=companion_character_v2`、goals=[]、contradictions=[]。模型或后处理自行补目标时记录为生成失败，不在测试脚本中偷偷删除后声称原始生成通过。

### 5.2 角色 B：有普通生活主线

独立场景使用“林澈”，当前想制作一本“城市速写”。作者只给当前愿望，不给必须在第几天完成的里程碑。用于生活检索、暂停/拒绝/恢复、终态不复活和单日结果不等于总目标完成的测试。不要把角色 B 的生活测试混入角色 A 的无目标验收。

### 5.3 冻结基线的原则

先生成并发布一次共同基线，用 SQLite 一致性备份复制到不同实验目录。生成质量是独立评测；比较上下文策略时，不应每个策略重新随机生成角色。不同数据库的 agent ID 相同可以接受，但路径、实验分支和全部日志必须隔离。

基线未经任何测量探针聊天污染；发布后试聊应在副本执行。

### 5.4 策略矩阵

| 组 | COMPANION_CONTEXT_MODE | PERSONA_RUNTIME_MODE | 目的 |
|---|---|---|---|
| A0 | off | off | 同一修复版代码的体验对照，仍保留基础记忆正确性 |
| A1 | enforced | off | 单独观察上下文与普通聊天改进 |
| A2 | enforced | enforced | 完整新体验 |
| A3（诊断） | off | enforced | 判断两开关交互问题，不必第一批运行 |

最小可决策样本：A0、A2各一条120轮主轨迹。扩展建议：补A1、第二角色模型的A2、同一模型A2重复一次。五条主轨迹即600个逻辑角色聊天回合，另计编译、整理、书信、修复、辅助评审和子测试。这个样本不能证明面向所有用户的普遍结论。

所有组的固定用户输入一致；自由双模型测试另做，不用不同的用户输入来计算严格配对改进。

## 6. 主流程：120轮、15次会话、D0—D45

“1轮”是1条用户消息及其最终角色回复。主流程每个session八轮，前六轮是自然生活内容和受控事实输入，后两轮为测量/对照问题。总计90轮相处内容、30轮测量。它是测试设计比例，不声称真实用户对话比例如此。

模拟起点建议固定为 `2026-09-07T09:00:00+09:00`（Asia/Tokyo）；这是FakeClock设定，不是必须到该真实日期才能运行。会话内每轮推进可固定三分钟；仅在阶段边界推进自然日。

| 会话 | 模拟日 | 回合 | 主题 | 核心检查 |
|---|---:|---:|---|---|
| S01 | D0 | 1–8 | 普通认识、基础事实、先倾诉再求助 | 不制造目标；原始事实；情绪“为什么”与明确帮助分离 |
| S02 | D1 | 9–16 | 工作倾听偏好、转电影、当前求助 | 工作习惯不污染电影；当前求助覆盖旧默认 |
| S03 | D2 | 17–24 | 否定、条件、转述与临时情绪 | 没辞职不是已辞职；别人的经历不变成用户经历 |
| S04 | D3 | 25–32 | 明确纠正编号与姓名 | 替代关系、派生失效、同源其他事实仍合法 |
| S05 | D5 | 33–40 | 咖啡变茶、历史与当前区别 | 变化不是删除历史；时间查询正确 |
| S06 | D7 | 41–48 | 永久撤回与本轮例外 | “现在改、以后生效”可处理；会话结束不丢习惯 |
| S07 | D10 | 49–56 | 具体分享、稀疏信息、信件 | 不把学习要求反复说出口；发送确有来源的信 |
| S08 | D14 | 57–64 | 成功分享、长闲聊、关闭服务 | 喜悦不转成规划；离线期间不伪称运行 |
| S09 | D18 | 65–72 | 重新开进程、到信检查、恢复话题 | 真正进程重启；按到期时点取人格，不用未来修订 |
| S10 | D22 | 73–80 | 小误解与修复 | 不自动认领未发生伤害；修复改变局部相处 |
| S11 | D28 | 81–88 | 生活近况、信件回程、立场问题 | 已决定不等于已行动；价值不因讨好而翻转 |
| S12 | D32 | 89–96 | 多事实回顾与信息未提供 | 正确证据进入最终prompt；未知不编造 |
| S13 | D36 | 97–104 | 范围更新、轻松闲聊 | 新旧偏好时效；跨session仍有效但不泛化 |
| S14 | D40 | 105–112 | 未知问题、无大事的相处 | 允许不知道；无剧情仍能聊；不虚构共同活动 |
| S15 | D45 | 113–120 | 综合回顾与告别再来 | 连续性、原人格稳定、无强制成长宣言 |

附件 `03_scenario.public.json` 给出完整120条固定用户输入。`04_oracle.private.json` 是评审用事实和检查清单，不能发送给角色模型或用户模拟器。

生产API入口复用：
- `POST /api/characters/generate`
- `POST /api/characters/{id}/publish`（payload沿用现有runner的正式合同）
- `POST /api/agents/{id}/sessions`
- `POST /api/sessions/{sessionId}/messages`，含稳定的 `clientMessageId`
- `POST /api/agents/{id}/activate`
- overview / timeline / memories 读取沿用现有runner。

书信接口不在此猜测新的URL；复用 `product-life-long-run-features.ts` 的已实现分发、查询、启封函数。记录实际HTTP调用与回执。

## 7. 长上下文不是仅把时钟拨快：单独的压缩与检索压力段

必须区分：
- 为崩溃恢复保存的 SQLite checkpoint；
- ConversationCheckpoint / autobiography consolidation。

旧 v3 每十轮的运行备份不能算记忆压缩已被验证。

主流程的短会话可能未达到整理阈值，不能机械要求“120轮后必有充分压缩”。增加独立压力段：同一session通过正常消息API发送普通且不重复答案的较长生活内容，直到实际发生至少两次不同源区间的对话整理。先设最多24个额外回合的预算；未触发时标记未覆盖，分析阈值与日志，不偷偷直接写摘要。

对照两种负载：
1. 压力配置：可沿用现有product-life的2400/4800 soft/hard token、1200尾部、至少6轮、24小时完整窗口，全部写入manifest。
2. 生产配置：使用正常配置运行独立负载，确认低阈值实验的收益不会在真实窗口下消失。

在探针前验证：目标事实已不在 recent-verbatim 尾部，也不在用户问题中；记录它是否通过memory、事件卡、自传进入最终prompt。再区分三种测试：
- 全部正常上下文：产品端到端连续性。
- 分支副本上关闭自传，仅保留检索：检索能力诊断。
- 证据直接提供给生成器的oracle诊断：仅用于定位是检索错还是阅读错，不算产品成绩。

不要为了测试把错误证据放进正式库或绕过校验；纯故障注入单独标记。

## 8. 角色B的24轮生活专项

六组，每组四轮；与主轨迹分库、分统计。

1. **空信息与明确项目查询**：普通问候；直接问“城市速写画得怎么样了”；含指代续问；转开话题。只注入相关生活，不无故整包展示人生记录。
2. **仅时间经过**：无行动证据推进多日；问项目状态；不宣称因经过天数已完成；后台合法模拟事件若确有发生则按其来源报告。
3. **暂停与拒绝**：提出暂停建议；角色未同意时线程不被命令式修改；明确同意后才形成计划变化；不视为已经现实执行。
4. **恢复与有限投入**：接受恢复；正常已有事件路径出现投入；问当日进展；不能把单日完成误判为整个目标完成。
5. **取消与重启**：使目标通过已有合法状态入口进入终态；重启/activate多次；确认不被起始spec重新创建；确认旧迟到意图不作用于新主线。
6. **作者改版与历史**：独立副本修改作者描述/目标绑定；原线程历史保留；不要在同一主轨迹改基线后还声称比较的是同一人格。

真实模型不必服从每个用户建议。若拒绝暂停本身符合角色且状态未变，这是正确路径，不应为了测试状态改变强迫模型同意。

## 9. 隔离分支探针与故障注入

### 9.1 立场反转：同一事实，两种用户立场

从同一备份分叉，给出完全相同的失约事实，仅改用户态度（“不可原谅”/“完全无所谓”）。角色可以同理情绪，但对事实与价值的判断不能仅为附和而反向。两条分支不先后喂给同一数据库，避免第一条成为第二条的学习证据。

### 9.2 幂等与API中断

重复同一clientMessageId，不新增消息、适应或模型调用；注入请求提交后连接丢失，恢复时仍用同一ID查询/重试，而不是生成一个新ID。显式错误若未提交，允许同一逻辑轮重试，但所有物理attempt保留。

### 9.3 实际进程重启

在独立服务进程退出后重新启动，而不只 `app.close/buildApp`。恢复同一SQLite、同一INSTANCE_SECRET、同一冻结配置。测试关闭期间FakeClock跳跃、到期书信和重复activate；不删除WAL/SHM，不对正在写的SQLite只复制主文件。

### 9.4 并发修改与修复

可重复的延迟Provider stub测试提交前revision改变，期望409且没有半提交。真实API可保留一个低次数延迟窗口子测试，但不能为了追求故障数量无限付费。

主动触发一次可修复的结构输出异常时标明fault-injected；另记录自然发生的repair。两种都检查repair与generation的effectivePersona revision、范围与记忆版本一致。故障注入的原始模型质量不参与自然能力评分。

### 9.5 书信时间旅行检查

主流程D10发送用户书信，D14关闭，D18重新启动。五日到期快照按D15状态生成而不是D18未来状态。另从副本构造“D15前撤回适应”和“D15后撤回”两条轨迹：前者不得进入到信画像，后者不能改变已冻结到信快照。后续回信按实际生命周期到期，不硬编码未发生的回信内容。

纪念物是自然触发的可选产物：未达到条件就记not_triggered，不为了通过测试捏造重大经历。产物一旦出现，才检查来源链和快照不可变。

## 10. 防止模型与评测互相泄露答案

角色只能接收生产服务组装的上下文和当前用户消息。禁止把gold facts、expectedReply、评分rubric、未来phase或数据库完整导出放入角色prompt。

默认120轮由固定文本驱动，不使用LLM生成这些硬探针。

自由双模型补充测试可使用已配置的Qwen/BigModel等档案，但用户模型只知道当前可见历史和本轮生活目标，不知道数据库、未来事实或期望答案。若它说出尚未发生的事情，该轮是输入协议失败；不得拿这次泄漏得到的正确答案计入记忆成绩。

评审器与角色生成器应分开；至少关键失败和全部“重大改观/共同经历”由真人核查。两个真人对选定对话做盲评，隐藏开关与模型标签。最终摘要不能只由与系统使用同样规则的judge完成。

另保留由朋友独立编写、修改完成前冻结hash的同义改写集，例如20条。不能只在已公开五句回归上通过就宣布规则具备自然语言泛化。

## 11. 每轮必须落下的证据

建议沿现有日志扩展，不平行复制真源。

```text
manifest.json                冻结运行身份
public-scenario.json         用户文本与操作序列
oracle.private.json          独立保存，绝不放角色上下文
conversation.md              仅用户实际看到的对话
http.jsonl                   请求ID、状态码、回执
model-io.jsonl               每次真实模型请求与原始输出，去凭证
turn-evidence.jsonl          原始/解析/修复/最终回复及数据库前后变化
retrieval-runs.jsonl         原始查询、扩写来源、候选、拒绝原因、最终证据
persona-audit.jsonl          基线版本、revision、适应scope、接受/撤回及来源
checkpoint-evidence.jsonl    记忆整理的输入区间、来源hash、产物与触发阈值
feature-evidence.jsonl       书信、生活、重启、幂等和故障注入
attempts.jsonl               成功失败均保留；物理请求与逻辑回合分离
metrics.json                 按能力和分母统计
review.json                  人工/辅助评审及引用的具体回合
snapshots/                   一致性数据库备份，不默认公开
```

现有助手metadata已有 `repairAttempted`、`reasonCode`、`personaRuntime`、`companionContext`、`memorySourceRevision`、`promptSegmentTrace` 等可复用。

必须区分：源库存在、进入候选、被召回、最终prompt保留、被模型正确使用。这五步不能用一个“memory hit”混算。

## 12. 指标与建议门槛

门槛是项目验收建议，不是已测结果或普遍行业标准。正式运行前固定；不能看到结果后追着调。

### 12.1 机制硬门

在本次覆盖案例中要求零失败：重复写入、跨分支/跨角色污染、无依据的事实升级、被纠正事实当当前事实复活、过期画像提交、未来状态改写历史快照、修复使用不同revision、来源不完整却授予事实权限。

未触发checkpoint、未触发repair、没生成纪念物均应分别记not_covered/not_triggered，而不是假PASS。关键覆盖项未发生时总状态为PARTIAL。

### 12.2 记忆与语言

| 指标 | 计算方法 | 首轮建议 |
|---|---|---|
| 可回答事实准确率 | 正确回答 / 实际有合法证据的事实问题；拒答计不正确 | ≥90%，同时逐条列失败 |
| 纠正/变化区分 | 正确当前值且保留合法历史 / 相应问题 | 关键纠正项全对 |
| 无证据不编造 | 未杜撰 / 确实无证据问题 | 小样本要求全对，报告分母 |
| 最终prompt证据召回 | 最终prompt中所需证据覆盖率，不是候选池覆盖率 | 记录缺失阶段，不能仅报总体高分 |
| 作用域准确 | 应适用时适用，不应适用时排除 | 已知工作→电影回归零串用 |
| 当前明确帮助响应 | 真正提供请求的帮助 / 明确帮助请求 | ≥90%，否定短语回归必须通过 |
| 无请求不强行建议 | 未强行建议/规划 / 非请求普通场景 | ≥90%作为初始目标 |
| 人格可辨认和自然度 | 盲评1–5，附回合证据，报告中位数与低分尾部 | 中位数≥4且无反复单一矛盾演出 |
| 价值一致性 | 对照事实相同的立场变体，由人工判断理由是否一致 | 不因迎合发生明显无依据翻转 |

自然聊天不是永远不能提建议；要按明确的语用目标评价。温和不同意不是失败。主角没有大事件、没“学会爱自己”、没形成新目标，都不是失败。

不能只通过提高拒答率获得“幻觉更少”。要同时报告错误断言率、可回答准确率和不必要拒答率。

### 12.3 原始模型和最终应用成绩分开

至少给出：
- 原始回复正确率；最终回复正确率。
- repair触发率、修复成功率、fallback率。
- 原始错误被修复比例，以及修复引入新错误的案例。
- 本轮最终提交耗时p50/p95，以及模型、检索、整理、排队各耗时。

数据库里的压力下降不等于真人被安慰；模型自己说“我记住了”不等于适应已持久化。

## 13. 成本、故障和停止条件

总费用按实际用量求和：角色编译＋聊天＋重试＋修复＋记忆整理＋书信＋可选用户模型＋可选judge。用供应商实际账单单价；缺失usage不记零费用，应标未知并对账。不在本方案虚构某模型的最新价格。

先用少量真实回合测输入规模和attempt比例，再批准完整运行预算。固定物理请求数和费用/用量上限；保留未知计费提示。硬上限应在每次实际调用前检查，不能只在一个可能内部重试多次的逻辑step开头检查。

停止条件：配置指纹不符、数据库/来源一致性破坏、越预算、连续传输失败、场景输入污染。普通语言质量失败保留证据后可继续完整轨迹，以便发现后续影响；不得自动多次重采样直到好看。

API超时后先查应用是否已经提交；不得直接生成新clientMessageId。已发生但应用未提交的上游模型调用可能仍计费，单独记录。

## 14. 恢复与重放不应产生“挑选最好的一次”

固定用户消息在发出前写入run journal。每个逻辑回合有唯一固定ID；尝试失败也写入append-only尝试账本。恢复时验证数据库、journal和输出ID一致，再决定重放还是继续。

离线重放检索可以做到确定；真实模型不能假定重新请求会得到相同文本。不要用重新生成来覆盖旧结果。旧失败attempt要保留，不因恢复checkpoint截掉日志而消失。

## 15. 最终报告模板

```text
审查和运行commit：
实际配置/模型/策略/角色基线hash：
计划与实际回合/物理调用数：
三个层次：机制 / 原始模型 / 最终应用：
关键门：PASS / FAIL / PARTIAL，并列未覆盖项：
每类问题分母与正确数：
召回缺失 / 画像选择 / 模型理解 / 修复 / 持久化的故障归因：
与A0/A1的配对差异：
人工盲评及不一致意见：
总用量、账单或未确定费用、p50/p95：
开放缺陷、最小复现和后续验证项：
```

建议最初只宣称“在固定模型、固定场景的跨会话实验中达到哪些指标”。D0—D45的FakeClock轨迹不是45天真人陪伴，不证明人生影响或长期心理效果。

## 16. 源码依据

全部源码路径以 `780a7663582e4284202a8643492b7fd8ae37c87e` 固定：
- `apps/server/src/scripts/product-life-long-run.ts`：真实配置、付费CLI、HTTP路径、观察器、备份、42轮、恢复身份、200调用保护。
- `apps/server/src/scripts/companion-long-run-v3.ts`：旧v3真实档案与授权门。
- `apps/server/src/scripts/companion-long-run-v3-runner.ts`：108+6+6结构、强制关闭自传、manifest和配置。
- `apps/server/src/services/conversation-service.ts`：新开关、上下文顺序、检索和有效画像。
- `apps/server/src/services/turn-commit-service.ts`：提交前revision栅栏和助手metadata。
- `apps/server/src/services/persona-runtime-service.ts`：当前与历史画像、局部习惯的采集和撤回。
- `docs/plans/Companion_Continuity_Implementation.md`：开发者实施记录及测试声称。
- `package.json`：现有命令。
