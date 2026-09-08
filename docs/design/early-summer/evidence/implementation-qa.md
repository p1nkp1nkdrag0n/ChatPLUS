# 本轮实施验收记录

本记录区分已执行验证、已知实施中间态与尚未执行项。设计包中的历史 QA 不能替代本轮应用验收。

## 环境与隔离

- 日期：2026-09-08；Windows；Node v24.16.0；pnpm 11.19.0。
- 测试入口：仓库 Playwright `global-setup.ts`，临时 SQLite / assets 目录，fixture Provider，FakeClock，无 demo seed，无 scheduler。
- API / Web：`127.0.0.1:43174` / `127.0.0.1:43175`。未读取用户 `.env`，未连接真实数据库或真实模型。
- Browser plugin not available：会话没有 Browser plugin 的 `browser` skill；使用仓库现有 Playwright Chromium / Pixel 7 项目。
- 原始截图与失败 trace 保留在本机临时目录 / Playwright 输出中；本文只记录精简事实。

## 实施前基线

| 核查                            | 状态        | 实际证据                                                                                                                                                                                                                                                                                 |
| ------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm exec vitest run apps/web` | pass        | 23 文件、90 测试通过，14:15:51 开始，退出码 0。                                                                                                                                                                                                                                          |
| 原创建→发布→聊天桌面流程        | pass        | `character-v2-flow.spec.ts` 的 optional concerns 用例，桌面 7.0 秒通过。                                                                                                                                                                                                                 |
| 首次桌面截图                    | captured    | `%TEMP%/chatplus-early-summer-baseline/character-create-chromium.png`，1280 CSS px 宽；截图时已混入并行编辑的暖白/绿色 tokens，因此不用作纯基线。                                                                                                                                        |
| 原移动创建流程                  | interrupted | 同一运行的移动项目正好遇到并行编辑：main.tsx 已导入 early-summer.css，文件尚未创建；Vite overlay 导致等待角色名称超时。此项不记为基线产品缺陷或通过。                                                                                                                                    |
| 独立纯基线桌面 / 手机截图       | captured    | 随后用 `git archive dec1657 apps/web` 导出到被忽略的 `tmp/early-summer-baseline`，运行同一隔离 fixture setup；1440×1000 / Pixel 7 412×839，均正确显示 PersonaSim、创建角色和表单，无并行源码污染。截图 `pristine-create-desktop.png` / `pristine-create-mobile.png` 位于上述 TEMP 目录。 |

执行命令：

```powershell
pnpm exec vitest run apps/web
$env:CHATPLUS_E2E_API_PORT='43174'
$env:CHATPLUS_E2E_WEB_PORT='43175'
$env:CHATPLUS_QA_SCREENSHOT_DIR=Join-Path $env:TEMP 'chatplus-early-summer-baseline'
pnpm exec playwright test tests/e2e/character-v2-flow.spec.ts --grep 'creates and publishes a character with optional concerns left blank'
```

## 实施后验收

对独立导出的原版再运行新回归测试，实际复现两项原有问题：

- IME：composition Enter 已产生一次 `/messages` POST，期望为零；退出码 1。
- 历史阅读：45 条历史的 180 px 位置在 SSE 增量后开始滑动；连续采集 40 个 RAF 后最小位置为 189 px，期望全部仍为 180 px；退出码 1。此观察窗口用于避免只读立即值漏掉稍后启动的 smooth scroll。

原版失败 trace 保存到 `%TEMP%/chatplus-early-summer-baseline`。这里的失败是原版行为证据，不是实施后剩余缺陷。

| 核查                                                       | 状态               | 实际证据                                                                                                                                                                                                                                                |
| ---------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 显式创建/导入深链、IME/Shift+Enter、SSE 历史阅读、启封隐私 | pass               | `early-summer.spec.ts` 桌面 + Pixel 7 的日常组 8/8 通过，17.5 秒；45 条历史在 SSE 新增后连续 40 RAF 均维持 180 px；查看新消息按钮可返回底部；IME 不发，Enter 仅发一次。                                                                                 |
| 官网四章、首帧 CTA、后续对话、显式开信、纯公众访问         | pass               | 官网不产生 `/api/` 请求，包含预填虚构 active-character id 的情形；反滚后演示信件不重置；DOM 标题全部可访问。                                                                                                                                            |
| 系统/站点动效偏好与持久化                                  | pass               | normal→系统 reduced→站点 still→reload 保持 still→reduced→auto，桌面/移动复跑均通过；still 子树 running animation 数为 0。                                                                                                                               |
| native scroll 与锚点前后退                                 | pass               | End 到底、Home 回顶、原生锚点、浏览器后退/前进均通过；body/html 无 overflow:hidden 锁滚。最初测试过早在 End 滚动未完成时按 Home，已修正为等待真实到达底部，不改产品滚动。                                                                               |
| offscreen / document visibility                            | pass（事件级）     | 两画幅均确认 S01 滚出后 data-active=false、layer animation paused，S04 进入 active；通过 document.hidden 属性 + visibilitychange 事件 seam 确认暂停/恢复，不声称已测 OS 最小化调度。                                                                    |
| 1440×1000 / 1024×900 / 390×844 / 360×800 布局              | pass（DOM）        | 两个 Playwright 项目均检查四章 scrollWidth≤innerWidth+1，标题可见。美术资产未齐时的截图只作中间态，不作为最终视觉验收。                                                                                                                                 |
| 图像请求失败降级                                           | pass               | 中止所有 image 请求，四章标题、CTA 与进入应用路径仍可用。                                                                                                                                                                                               |
| `pnpm typecheck`                                           | pass               | 全部 6 个工作区项目通过，退出码 0。                                                                                                                                                                                                                     |
| `pnpm test:correspondence:focused`                         | pass               | unit 16 文件/166 测试；integration 17 文件/102 测试；web 12 文件/57 测试，总计 325 测试，退出码 0。                                                                                                                                                     |
| `pnpm lint`                                                | pass（修复配置后） | 原导入的三个 standalone `.mjs` 不在 TS project service；改为保留 JS lint 的 disableTypeChecked override 后全仓库通过，退出码 0。                                                                                                                        |
| `pnpm format:check`                                        | fail（既有基线）   | 首次 506 项多数是 Windows core.autocrlf=true 与默认 LF 的冲突；配置 endOfLine:auto 并排除保持原字节的原 handoff 后只剩 15 项，逐项 git show HEAD 验证 6 项已跟踪文件在原版也不合格式，另 9 项为任务开始前即存在的未跟踪参考文件；本轮更改文件全部通过。 |

最终全量 `pnpm test:e2e`：**pass，72/72**，桌面 Chromium + Pixel 7，2.3 分钟，退出码 0。包含原角色生成/发布/编辑/记忆检查、完整书信/纪念物/安全分享、新入口 14 项、场景/聊天/隐私回归、瞬态生命周期 4 项、禁用 JavaScript 2 项，以及首屏实际加载和使用文档返回官网 4 项。最终日志：`tmp/early-summer-e2e-final-72.log`。此前 62/68 项全量也通过；最终数字来自一次完整运行，没有拼接分批结果。

瞬态生命周期最终 4 项已全部包含在上述 72 项全量通过中。真实 1440×1000 / 390×844 画幅下，等待前景岸石图解码，用实际鼠标点击相对水域坐标：水面 (0.75, 0.75) 有波纹；位于河道曲线内的岸石 (0.776, 0.95) 与曲线外 (0.5, 0.75) 都无波纹。独立诊断确认水点 alpha=0、新石点 alpha=252；必要时先原生滚动到可点击的位置。冻结浏览器时钟，验证 still→auto 不恢复旧水波、离屏/hidden 清除且恢复不重现；演示信封展开时离屏直接可读、不抢原焦点，收起重开不重播。

保留的中间失败记录：首轮生命周期测试曾早于 IntersectionObserver 更新派发事件，已等待真实可见交集信号；新增资源测试在 React 挂载前对空数组执行 every，已加首章可见和图像非空等待；演示跳过按钮在 isVisible 与 click 之间因 600ms 自然结束消失，trace 中正文已正常显示，已改为冻结动画时钟并用键盘 Enter 实际跳过。最后岩岸下延 12% 消除接缝后，原石点 (0.78, 0.85) 变为透明水域，已依据实际 bank 边界重采样并更新为新石点；断言仍为真实水点可触发、真实石点不可触发，没有放宽成允许任意位置波纹。

禁用 JavaScript 的两个项目均可以阅读四章静态标题，点击本页 `#static-start`，取得实际项目 README 链接；`#root` 保持为空，没有 `/api/` 请求。此项只证明静态阅读和安装入口可用，不表示无 JavaScript 能聊天。

首屏加载用例在真实网络账本中确认 S02–S04 零请求，随后逐章进入并确认图像下载、解码成功；`/start` 页尾返回官网会回到 scrollY=0 且聚焦第一章标题。该两项均在桌面和手机通过。

最终静态检查：`pnpm typecheck` 全部 6 个工作区退出码 0；`pnpm exec vitest run apps/web` **24 文件 / 94 测试**，退出码 0；`pnpm lint` 全仓退出码 0。新增 E2E tsconfig 后，`pnpm exec tsc --project tests/e2e/tsconfig.json --noEmit` 及 `pnpm exec eslint tests/e2e scripts/measure-early-summer.mjs` 也退出码 0。新增测试使默认 TS project service 文件数超过 8 个上限，已改为正式 E2E TypeScript 项目，保留全部类型规则与 JS lint；现有测试只补充了三处已存在断言后的非空守卫。

启封隐私检查使用真实隔离 fixture 来信：未启封 GET 不带正文等字段，503 `/open` 失败后不显示正文，键盘启封后只在 reader DOM 显示；暂停 browser clock，让 900ms 定时器无法到期，切换 still 后仍立即进入可读正文，累计仅两次 open 请求（一次 fixture 失败、一次成功），不因偏好切换重发。检查实际 React Query singleton 的 Query/Mutation cache、local/session storage、console 和 URL，SPA 卸载 reader 后再次检查。缓存/存储检查展开字符串叶节点与嵌套 JSON，避免换行转义造成错误的“无正文”结论。

已知格式基线的 6 个已跟踪文件：

- `apps/server/src/db/stored-item-extraction-migration.test.ts`
- `apps/server/src/scripts/qwen-generation-controls.ts`
- `apps/server/src/scripts/qwen-repair-holdout.ts`
- `docs/plans/ChatPLUS_纠错优先验收与自然度改进计划.md`
- `docs/plans/ChatPLUS_Development_Implementation_Guide.md`
- `docs/reports/ChatPLUS_闻溪文本长程仿真验收报告_2026-09-05.md`

9 个任务开始前未跟踪参考文件位于原 continuity review、db446b8、Qwen 本轮修复计划及 Problem-2026-08-25 资料中，未重排或提交。逐项分类原始结果在 `tmp/early-summer-format-audit.json`。

美术视觉对照见 [visual-review.md](visual-review.md)，真实资源字节、解码估算和性能证据见 [runtime-qa.md](runtime-qa.md)；72 项 E2E 只代表相应功能断言通过。真实 200% 浏览器缩放、触屏旋转/pinch、OS 后台调度、低端真机帧率没有在本记录中自动视为通过。未明确列为 pass 的 ACCEPTANCE 项不能视为验收通过。
