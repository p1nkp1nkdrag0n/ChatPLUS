# 资料与证据

查阅日期 2026-09-08。设计选择、时长和资源预算为本次提案，不是资料来源声称的效果。

## 仓库事实

基线： https://github.com/p1nkp1nkdrag0n/ChatPLUS/tree/0a74341c491494f2ccb6bc1c2c41a3bbaabad5b5
重点路径：README.md、package.json、docs/architecture.md、docs/design-system.md；IMPLEMENTATION.md 列出的前后端入口。
本次通过 GitHub connector 再核对基线和 root package scripts。业务行为来自本对话前轮读取的同一快照；不宣称本轮运行了应用。

## 技术依据（官方）

- View Transition API： https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API/Using
  同文档增强与同源跨文档要求；必须功能检测和普通导航降级。
- 交互触发动效与减少动态： https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html
- 自动运动暂停： https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html
  不是所有运动一律受同一条款约束；本规范选择更保守的全局静止开关。
- 滚动时间线： https://gsap.com/docs/v3/Plugins/ScrollTrigger/
  scrub/pin 是能力，非必须使用整屏固定。
- Codex GitHub委派： https://learn.chatgpt.com/docs/third-party/github
  非 review 的 @codex PR 评论可作为任务入口，前提是仓库已设置 Codex；发送评论不证明接单。
- Codex cloud： https://learn.chatgpt.com/docs/cloud
  需要实际可用的仓库环境与授权。本次没有创建云任务。

## 艺术参考

https://exp-my-little-storybook.lusion.co/ 为用户给定方向；借风格化自然、空间与手作感，不复制源站美术或脚本。
用户给定 Fable Shorts 尚未取得连续可检验画面；不虚称已逐镜分析，不将未经核实的画面细节定为规格。
references/ 中是本对话前轮生成的三张原图；仅作方向，不作为生产图层。
