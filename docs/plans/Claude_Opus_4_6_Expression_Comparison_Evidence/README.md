# Claude Opus 4.6 短测证据

本目录对应 [Claude 与 Qwen 的同场景比较评阅](../Claude_Opus_4_6_Expression_Comparison.md)。实际请求使用 `claude-opus-4-6`，成功响应返回相同模型标识。未修改本机原来的 Claude 命名配置。

| 文件                                       | 内容                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------- |
| [transcripts.json](transcripts.json)       | 三个完成分组的 18 条有效回复与实际表达视图                                            |
| [paired-replies.json](paired-replies.json) | 与旧 Qwen 在同分组、同轮次的 11 对有效回复                                            |
| [provenance.json](provenance.json)         | 参数、两次运行、20 次物理尝试、18 条有效回复、2 次 HTTP 524、已观测用量、原始文件哈希 |

两次 HTTP 524 都发生在 combined 首轮，没有可见模型输出；该组没有获得有效回复，不纳入语言比较。首跑和一次明确记录的补跑保留为不同运行，已返回的文本没有重新采样。

输出使用全新忽略目录。无付费预检：

```powershell
pnpm exec tsx apps/server/src/scripts/correction-expression-pilot.ts --fixture --profile claude --model claude-opus-4-6 --output artifacts/claude-expression-fixture-new
```

本轮真实执行命令如下，依赖本机已有 `claude` 命名配置及凭据。`--model` 只在当前试跑覆盖模型；支持环境代理的 Node 可使用以下参数：

```powershell
$env:RUN_PAID_CONTINUITY = '1'
node --use-env-proxy --import tsx apps/server/src/scripts/correction-expression-pilot.ts --profile claude --model claude-opus-4-6 --output artifacts/correction-expression-claude-opus-4-6-20260907
Remove-Item Env:RUN_PAID_CONTINUITY
```

首轮网关失败后的唯一补跑：

```powershell
$env:RUN_PAID_CONTINUITY = '1'
node --use-env-proxy --import tsx apps/server/src/scripts/correction-expression-pilot.ts --profile claude --model claude-opus-4-6 --arms combined --predecessor artifacts/correction-expression-claude-opus-4-6-20260907 --output artifacts/correction-expression-claude-opus-4-6-20260908-combined
Remove-Item Env:RUN_PAID_CONTINUITY
```

实际目录已存在，复现应另取新目录名并保留新一轮身份；以上命令不覆盖旧证据，也不自动形成同一实验的补抽结果。脚本的 `maxRetries` 为 0；本次唯一人工编排的网关补跑在来源文件中单独登记。进程退出码 0 只表示脚本完成收尾，是否完成全部分组必须检查 `result.json.completed`，本次两个原始运行均为 `false`。

公开证据不包含隐藏推理、凭据或完整物理请求。原始 manifest、ledger、transcript、result 和计量文件保留在对应忽略目录，用 SHA-256 核对；短测不能代替正式产品路径或真人体验验收。
