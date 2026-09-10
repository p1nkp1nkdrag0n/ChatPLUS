# 文件说明

- `implementation_plan.md`：固定提交的定位、最小修改方案、事务边界和验收步骤。
- `regression_cases.json`：28 项建议回归，非现有 runner 可直接运行的格式。
- `rule_probes.mjs`：本次实际运行的独立纯规则复现，可用 `node rule_probes.mjs` 执行。
- `rule_probe_results.json`：执行结果及限制。

没有付费调用、仓库改动、完整集成测试或独立最终数据库审计。模型原始请求与数据库细节来自用户及仓库预演记录；见方案证据边界。
