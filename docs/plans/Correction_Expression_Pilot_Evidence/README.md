# 小范围表达生成试跑：证据与复现

日期：2026-09-07。此目录只收录合成角色、合成用户场景下的实际模型可见回复与表达视图，不包含隐藏推理、密钥或完整物理请求。

- [transcripts.json](transcripts.json)：17 条有效生成回复，按 `arm` / `turn` 定位，保留用户文本、模型回复和当轮表达视图。
- [provenance.json](provenance.json)：模型、参数、源码状态、物理调用与 token 统计，以及本地原始 manifest、ledger、transcript 的 SHA-256。
- [离线评阅](../Correction_Expression_Pilot_Review.md)：具体正反例与未覆盖项。此评阅由 Codex 完成，不是参与者满意度调查。

## 设计与实际完成情况

四组共用当前规划器、合成角色沈禾及六轮场景，只替换表达视图中的 `expressionGuidance`、`questionGuidance`；旧指导从源码基线 `8ce79cb` 读取。`baseline` 是旧指导对照，不是运行旧版完整产品。每组历史独立，后续用户文本可承接店名／饮品等开放问题，也包含主动邀请、跳过和明确结束；T4 的具体面条问题被跳过，不能声称这一处已验证回答后的承接。

模型为 `qwen3.8-flash`，`reasoning_effort=medium`，`response_format=json_object`，输出上限 2,500 token，重试为零，没有显式指定 temperature。默认总上限为 24 次物理调用、600,000 预留 token；预留预算不等于实际账单。

| 执行目录                                                  | 结果                                                                                         |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `artifacts/correction-expression-qwen-20260907`           | 未启用 Node 环境代理，第一次 TLS 连接失败；用量未知                                          |
| `artifacts/correction-expression-qwen-20260907-proxy`     | 使用环境代理；baseline 完成 T1–T4，T5 返回不合法结构并停止                                   |
| `artifacts/correction-expression-qwen-20260907-remaining` | 只运行尚未采样的三个独立组；plain_only 在 T2 结构失败，questions_only 与 combined 各完成六轮 |

总共 20 次物理尝试、19 次 HTTP 响应、17 条有效回复、2 次结构化失败。可观察用量 26,936 token，其中 prompt 20,734、completion 6,202；首个无响应失败不按零用量处理。没有重新采样失败组，也没有从多次回复中挑选更好的结果。

运行时正在分批提交其他实现，因此来源记录同时保留当时 HEAD、dirty 标记和 diff 哈希。每条有效回复还保留实际表达视图。哈希支持核对本机原始文件，但本目录没有提供全部当时未提交补丁或请求正文，不能据此声称可逐字重现远程模型输出。测试脚本最终纳入 `dc8b141`。

## 复现命令

从仓库根目录执行默认的无付费 fixture 试跑，输出应使用新的目录：

```powershell
pnpm exec tsx apps/server/src/scripts/correction-expression-pilot.ts --fixture --output artifacts/correction-expression-fixture-new
```

真实试跑读取本机已有的 `qwen` 命名配置，需要显式运行开关。以下命令适用于已配置环境代理、支持 `--use-env-proxy` 的 Node；直接联网时可去掉该参数：

```powershell
$env:RUN_PAID_CONTINUITY = '1'
node --use-env-proxy --import tsx apps/server/src/scripts/correction-expression-pilot.ts --output artifacts/correction-expression-qwen-new
Remove-Item Env:RUN_PAID_CONTINUITY
```

`--arms plain_only,questions_only,combined --predecessor <先前输出目录>` 可单独运行尚未采样的独立组，并登记前序来源。它不授权补抽失败组、修改其历史或把多个不完整组拼成完整对照。结构化失败保留原调用记录并停止该组。

此脚本只比较提示生成，没有完整产品的持久化、语义修复、纠错、重启或压缩路径，也不用于计算正式长期满意度。完整工程验收见[实施记录](../Correction_First_Implementation.md)。
