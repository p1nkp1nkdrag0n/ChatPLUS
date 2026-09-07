# GPT-5.6 Sol 用户授权重试：公开证据

日期：2026-09-08。用户在原先四次 `GROUP_DISABLED` 拒绝后明确要求“重试一次”。本轮沿用本机 `gpt56-sol` 配置，显式请求 `gpt-5.6-sol`，没有由助手切换凭据、替代访问路径或修改 `.env`。

这轮四组各计划六轮，共 24 次物理尝试，23 次 HTTP 200 均通过输出对象校验；`combined/T6` 返回 HTTP 502，没有模型文本、模型标识或用量。前三组各六轮完成，联合组只有 T1–T5，因此整体 `completed=false`。未再次补跑失败位置。

- `transcripts.json`：本轮全部 23 条有效回复、合成用户输入和表达视图，逐条对应本地原始 transcript；不含模型隐藏推理。
- `comparisons.json`：固定 24 个分组／轮次位置的三模型可见文本。没有有效输出的位置保留 `null`，不以错误页、推测或别组输出补齐。
- `provenance.json`：本轮两个运行、原先被拒绝运行的关联、来源指纹、实际参数、逐次状态和用量、原始文件 SHA-256、比较分母及形态统计。
- [离线评阅](../GPT_5_6_Sol_Expression_Comparison.md)：解释具体语言表现与可比范围。

先仅运行基线组，确认前三次调用成功后启动其余三个独立分组。两进程短暂重叠，后者的上下文不读取基线组历史，组内仍顺序生成。命令中的 predecessor 只登记来源，不复制历史或恢复一个旧分组：

```powershell
$env:RUN_PAID_CONTINUITY = '1'
node --use-env-proxy --import tsx apps/server/src/scripts/correction-expression-pilot.ts --profile gpt56-sol --model gpt-5.6-sol --arms baseline --predecessor artifacts/correction-expression-gpt-5-6-sol-20260908 --output artifacts/correction-expression-gpt-5-6-sol-20260908-retry1-baseline
node --use-env-proxy --import tsx apps/server/src/scripts/correction-expression-pilot.ts --profile gpt56-sol --model gpt-5.6-sol --arms plain_only,questions_only,combined --predecessor artifacts/correction-expression-gpt-5-6-sol-20260908-retry1-baseline --output artifacts/correction-expression-gpt-5-6-sol-20260908-retry1-remaining
Remove-Item Env:RUN_PAID_CONTINUITY
```

以上命令记录实际参数；若复现，必须使用新的输出目录。脚本自动重试为 0。成功请求及供应商响应的模型标识均为 `gpt-5.6-sol`，参数为 `reasoning_effort=medium`、`response_format=json_object`、`max_tokens=2500`、非流式，未显式指定 temperature。模型标识是供应商返回值，不能据此独立核验供应商内部路由。

两运行均记录来源提交 `b1b1789d7859b412096ee76889997171da1de00c`，来源指纹与 dirty patch hash 相同；manifest 如实保留 `dirty=true`。启动时已有其他未跟踪的用户规划文件，本轮没有改动已跟踪生产代码。四组分别使用旧表达指导、仅新平实指导、仅新接话指导、两种新指导；旧指导来自 `8ce79cb`，规划器均为当前版本。六轮场景与此前测试相同，各组历史由实际回复形成。

23 个成功响应共报告 28,255 输入 token、2,837 输出 token，合计 31,092；HTTP 502 的用量未知。计入之前四次 HTTP 403 后，Sol 累计 28 次物理尝试，整体账单用量仍未知。这里不按零用量处理失败，也不估算金额。

对照来源为 [Qwen 17 条有效回复](../Correction_Expression_Pilot_Evidence/transcripts.json)和 [Claude 18 条有效回复](../Claude_Opus_4_6_Expression_Comparison_Evidence/transcripts.json)。Sol 与 Qwen 有 16 个共同有效位置，与 Claude 有 18 个；三方共同有效位置 11 个，其中三方用户输入逐字相同的有 9 个。两组 T2 的用户驱动措辞因上一条实际提问不同而变化。共同位置中除 `recentExpression` 外的表达字段逐项一致；历史不同，完整提示并不相同。

统计长度使用 Unicode code point，包括标点与换行；含问号、含“确实”按回复条数计。同一行只比较实际存在的文本，长度或问句更少均不是自然度评分。Sol 与 Qwen 使用兼容接口的 `json_object` 和 `reasoning_effort`，Claude 使用 `prompt_json` 和 `anthropic_output_config`；同为 medium 不保证推理预算相同。原始逐调用延迟保留，但这轮不做速度排名。

本地原始目录留有 `manifest.json`、`result.json`、`attempts.jsonl`、`provider-metrics.jsonl`、`transcript.jsonl`。公开证据只选择合成用户输入、可见回复及必要元数据，排除密钥、完整请求、认证头和隐藏推理。公开 transcript 可与本地原文逐条比对，其他原始文件通过 SHA-256 校验；原始账本保持在被忽略的 `artifacts/` 中。

本轮只运行生成提示短测，未触发正式产品最终修复、持久化、纠错保持、重启或压缩，也未调用付费评分模型。每组仅一条轨迹，缺失保留；不能据此判断统计显著性、长期满意度、服务可靠性或自然度验收已通过。
