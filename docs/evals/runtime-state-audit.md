# 短时状态读出审查：冻结协议 v1

本协议在这批真实调用前写定。它检查当前角色主提示里的短时状态描述是否彼此独立、是否保持人格和任务完整性，以及每个维度在具体场景是否提供增量。结果可以支持删除、保留或继续观察某个维度，不预设新版本一定更好。

## 范围和规模

- 两个人格：既有确定性作者 fixture 的 `social-outward` 与 `social-private`。背景、关系和任务相同，表达偏好和例外不同。避免把角色生成随机性混入状态实验。
- 八个案例：情绪正负向、唤醒度、精力、压力、社交容量、专注、无有效睡眠来源、混合状态下的连续性和完整任务。案例和私有判据写在 `runtime-state-audit-cases.ts`。
- 每个人格 × 案例 × 组仅一个样本，共 48 个计划候选。当前 fuzzy 睡眠字段已省略，因此两个 sleep 参数消融是 no-op，只保留跳过记录，实际最多 46 个有效请求。
- 同一 GLM bigmodel 配置、相同输出上限（每次不超过 4,096）、完全相同历史、当前请求、人格、任务意图与非状态策略。三组都冻结使用同一人物/任务配上 neutral state 通过真实 assembler 生成的策略段，避免低社交容量等参数仍经 delivery/length 策略残留；另存原生产捕获和 neutral 策略捕获。并发 2；物理请求硬上限 46，预留单位上限 4,000,000。执行前核对有效候选数不超上限。预留单位是请求 UTF-8 字节加输出上限，不是实际 token 或费用。
- `maxRetries=0`，没有 schema retry、生产 repair、LLM 评审或失败补发。失败、超时、截断和未知用量都留证，不编造答案。

## 三组定义

| 组                     | 实际变动                                                                                                                                                                                            | 解释范围                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `legacy_state_readout` | 从固定提交 `4492a9cfb34bfc3c4a32d4298127ba86eda274f2` 的 TypeScript AST 提取原 `compactRuntimeState`、描述函数和 `stateGuidanceFor`，替换当前装配出的状态段，并在同一策略 JSON 补回旧 stateGuidance | 旧状态读出对照；其他全部是当前生产策略。绝不是完整旧版生产系统 |
| `current`              | 真实 `assembleChatPrompt` 的当前状态读出；策略段统一替换为相同人物/任务的 neutral-state 策略，其余片段保持                                                                                          | 受控的当前状态读出，非完整原样生产调用                         |
| `param_ablation`       | 从 current 已获准的状态 JSON 删除目标数值与对应 qualitative 文字；混合案例删除全部六个短时维度，保留位置等上下文                                                                                    | 已装配提示的读取端贡献，不是关闭整个状态引擎                   |

消融禁止残留 `stateGuidance`、`qualitative.summary`、被删维度的派生组合文字。执行器发现这些字段仍存在就拒绝开始实验。每对保存移除路径、原/新哈希、非状态片段相同证明和策略/预算相同证明。消融不重新检索，不因释放预算增加其他材料。

睡眠案例的同一份 fuzzy 原始状态默认值是零：旧读出会声称没有睡眠债，新读出省略无来源字段。不能把 current 的空消融解释为该参数没有价值。另存一个 `legacy_exact`、`sleepDebtMinutes=360` 的离线投影 fixture，证明有来源模式下字段仍被投影且能独立删除。此 fixture 是作者构造的已结算状态，不是实际运行睡眠结算；生产有效性和 availability 行为由另行集成测试验证，不伪称已经隔离进入本实验。

## 连续性、任务和评分

共同历史包括周三更正为周四、苏禾负责插画、用户负责组织、场地尚未确定，避免用只比较输出语气替代实际任务检查。低精力与高专注、低社交容量与正向情绪、高压力与高精力分别构成混合场景；最后一个案例联合多个状态并要求完整拟稿及发送前确认。

私有审阅维度：人格连续性与例外、明确任务完整性、状态分维表达与比例、事实/历史/行动归属、自然表达与无指标背诵。各维 0/1/2，分别表示违背或缺失、部分满足或有歧义、满足；必须引用可见输出。案例标题和评分要求不注入任何模型输入。

输出字符数、耗时、词面特征不能自动当成质量分数。每个条件仅一次采样，两个不同人格不是同条件的独立重复，不做显著性或普遍必要性的宣称。匿名候选只是隐去组名的审阅材料，没有用户参与就不能称为用户盲评；若由 AI 辅助审阅要明确标注。不同人格、任务、模型和随机采样均限制结论推广。

## 留证与运行

执行器沿用 `architecture-run-admission` 和 `continuity-metered-fetch`：仅写入全新、Git 忽略的工作区目录；离线模式不解析部署模型 profile、不发网络请求；必须按下方命令在进程启动时设置 `PERSONASIM_LOAD_ENV=false`，才能避免共享 config 模块导入时读取 `.env`。真实运行使用既有 bigmodel 配置；不在终端或 artifacts 暴露密钥。源代码哈希、旧源码提取、当前装配 trace、实际输入、可见原始输出、usage、错误和每个物理请求账本全部保存。隐藏推理内容不作为审阅材料。

主要 artifacts：`manifest.json`、`protocol.md`、`production-assembler-captures.json`、`prompt-cells.json`、`legacy-sleep-projection-fixture.json`、`attempts.jsonl`、`results.json`、`anonymous-candidates.json`、私有匿名映射和判据、`summary.json`。所有组只评主调用原始可见答案；没有生产后处理混入。

```powershell
pnpm exec cross-env PERSONASIM_LOAD_ENV=false tsx apps/server/src/scripts/runtime-state-audit-evaluation.ts --fixture --output tmp/runtime-state-audit-fixture-unique
pnpm exec cross-env PERSONASIM_LOAD_ENV=false tsx apps/server/src/scripts/runtime-state-audit-evaluation.ts --preflight-only --output tmp/runtime-state-audit-preflight-unique
# 真实运行由明确获授权的主任务执行；不会隐式补发失败请求。
$env:RUN_PAID_ARCHITECTURE_EVAL = '1'
pnpm exec tsx apps/server/src/scripts/runtime-state-audit-evaluation.ts --output tmp/runtime-state-audit-glm-unique
```

运行过程中只修执行器错误，不针对已看到的质量结果调整生产提示、案例或判据。修改后使用新目录，原失败批次保留。任何后续调参都必须与本次探索性证据分开。
