# GPT-5.6 Sol 短测：供应商分组停用，未取得模型回复

日期：2026-09-08。按用户要求尝试同角色、同场景、四组各六轮的 `gpt-5.6-sol` 短测。四组首轮请求均被供应商返回 HTTP 403，具体错误为：

```json
{ "code": "GROUP_DISABLED", "message": "API Key 所属分组已停用" }
```

本轮没有任何模型输出，不能评价 Sol 的自然度、接话、建议遵从、结构输出质量或推理速度，也没有新增三模型质量排名。此前 [Qwen 与 Claude 的比较](Claude_Opus_4_6_Expression_Comparison.md)保持原样。

## 实际执行

- 命名配置：`gpt56-sol`；配置和实际请求中的模型名均为 `gpt-5.6-sol`，没有响应模型标识，不能确认实际执行了模型推理。
- 沿用 `reasoning_effort=medium`、`response_format=json_object`、单次输出上限 2,500 token、脚本内重试 0、相同角色与表达指导。
- `baseline`、`plain_only`、`questions_only`、`combined` 各在 T1 被拒绝，共 4 次物理尝试、4 次 HTTP 403、0 条有效回复、0 个语言比较机会。
- 供应商未报告 token，用量记为未知，不按零用量或免费处理。
- 已停止继续请求，没有尝试其他凭据或替代访问路径，也没有修改本机 `.env` 或生产代码。

模型名称及 medium 推理档位已根据 [official OpenAI documentation](https://developers.openai.com/api/docs/models/gpt-5.6-sol)核对。本次拒绝来自配置供应商的 API Key 分组状态，不是模型文本、提示质量或模型能力的测试结果。

执行命令：

```powershell
$env:RUN_PAID_CONTINUITY = '1'
node --use-env-proxy --import tsx apps/server/src/scripts/correction-expression-pilot.ts --profile gpt56-sol --model gpt-5.6-sol --output artifacts/correction-expression-gpt-5-6-sol-20260908
Remove-Item Env:RUN_PAID_CONTINUITY
```

原始结果在 `artifacts/correction-expression-gpt-5-6-sol-20260908/result.json`，其中 `completed=false`。脚本完成收尾并退出 0 不代表模型短测完成。公开的 [失败证据与原始文件哈希](GPT_5_6_Sol_Expression_Attempt_Evidence/provenance.json)保留请求模型、各次时间、错误代码、状态和用量未知标记，不包含凭据或请求正文。

继续条件：需要供应商恢复该 API Key 所属分组，或在本机将 `gpt56-sol` 更新为已有授权且可用的配置，然后以全新目录登记下一次运行。当前访问状态未恢复时，不继续重复请求。

后续记录（2026-09-08）：用户明确要求重试后，同一命名配置已能返回模型回复。本次新的 24 次尝试取得 23 条有效输出，联合组 T6 为 HTTP 502；详见 [Sol 重试与三模型比较](GPT_5_6_Sol_Expression_Comparison.md)。上述四次 403 及未知用量属于原运行，保持不变。
