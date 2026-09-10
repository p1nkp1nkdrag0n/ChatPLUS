# 交付说明

本包是对 ChatPLUS `780a7663582e4284202a8643492b7fd8ae37c87e` 的审查和测试设计，不是代码修改，也不是已经跑完的真实 API 验收。

## 阅读顺序

1. `01_分支审查报告.md`：已实现内容、五项优先问题、源码定位与验证边界。
2. `02_真实API长程验收方案.md`：现有42轮预演命令、新120轮runner设计、对照、预算、故障与评价规则。
3. `03_scenario.public.json`：120轮固定用户消息。是建议规格；当前仓库没有读取此文件的CLI。新driver只能把当前userText传给产品接口，不能把后续剧本传给角色。
4. `04_oracle.private.json`：评审专用事实、作用域与期望；不能提供给角色模型或用户模拟器。
5. `isolated-probes.cjs` 和 `isolated-probes-results.json`：本次实际运行的独立规则复现及结果，不是仓库Vitest或Fastify测试。运行 `node isolated-probes.cjs` 可重新得到结果。
6. `build_scenarios.py`：生成场景与私有oracle的脚本，不连接任何API。

原始稿件、数据库和API密钥都不包含在本包。未执行付费调用。模型自然回复可能弥补规划错误，也可能放大它；需真实API和服务层回归验证，不能把孤立分支结果当最终对话必然失败。
