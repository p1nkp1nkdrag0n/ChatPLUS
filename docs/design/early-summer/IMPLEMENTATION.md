# 实施路线与仓库约束

## 1. 基线证据与必读入口

基线 main 为 `0a74341`；若执行时已更新，先看 diff，不覆盖新行为。读取当前仓库 AGENTS.md（如有），本包不替换根级指令。

| 实际路径 | 不能丢掉的职责 |
| --- | --- |
| apps/web/src/app/App.tsx | 当前业务深链接、懒加载、AppShell 分界 |
| apps/web/src/components/AppShell.tsx | 激活/SSE/角色上下文，官网不能误触发 |
| apps/web/src/api/client.ts | API 适配、错误、只读、版本和消息发送 |
| apps/web/src/hooks/useAgentEvents.ts | SSE 是 refetch 提示，不是新事实 |
| apps/web/src/pages/ChatPage.tsx | 完整提交后的消息呈现、会话与草稿 |
| apps/web/src/pages/LetterDetailPage.tsx | 解密正文仅在已挂载阅读器局部 |
| apps/web/src/lib/correspondenceMutations.ts | 安全启封与减少动态流程 |
| apps/web/src/pages/CorrespondenceMailboxPage.tsx | 模式/只读/重试/分页 |
| apps/web/src/pages/RelationshipArchivePage.tsx | 来源、分页、精确条目链接 |
| apps/web/src/styles/tokens.css | 原有字体、颜色、圆角与过渡入口 |
| apps/server/src/http/routes.ts | 后端契约、归属与功能边界 |
| apps/server/src/services/conversation-service.ts | 幂等、生活推进、校验/提交 |

本轮只交接规范，未执行应用测试或修改业务文件。

## 2. 路由决定

第一阶段添加 `/about` 官网预览，独立 MarketingShell，不放在会触发 agent activate/SSE 的 AppShell 内。添加静态 `/start`，根据实际 README 展示安装/独立部署或真实可用演示路径。先保持原根路由与现有深链接。
后续可采用前端构建项 `VITE_SURFACE=app|site`（新增提案，默认 app）：site 根为官网，不导入用户业务模块、不请求用户 API；app 根处理首次或返回体验。`VITE_APP_URL`（提案）只能使用明确配置，缺值就去使用说明，不猜 URL、不探测 localhost、不假注册。
业务路径 `/characters/:id/chat`、`/letters/:id`、纪念物/档案路径保留。显式深链接优先于欢迎页。只有 app 根入口判断首次状态、现有示例角色和最近有效路由。旧用户不重播入场，示例角色不存在时走角色列表/创建，不硬编码 ID。
只存 UI 偏好和必要路由 ID，不持久化解密正文或复制聊天数据库。

## 3. 建议模块边界

```text
apps/web/src/marketing/
  MarketingPage.tsx / MarketingShell.tsx / content.ts
  scenes/SkyMeadow.tsx / ForestStream.tsx / WritingDesk.tsx / Ocean.tsx
  motion/MotionProvider.tsx / useSceneProgress.ts / useSceneVisibility.ts
  interactions/FlowerWind.tsx / WaterRipple.tsx / DemoEnvelope.tsx
apps/web/src/experience/WelcomePage.tsx / RouteTransition.tsx
apps/web/src/styles/early-summer.css
apps/web/public/art/early-summer/{s01,s02,s03,s04,ui}/
docs/design/early-summer/evidence/
```

这是新增建议，不是现有文件。服从仓库约定；状态适配、业务 mutation、景物渲染不要合到巨型 App。保留 React/Vite/Router/Query，不为美术更换框架或 UI 库。GSAP/WebGL 仅按需引入官网懒加载块；普通会话不能下载这些环境资源。

## 4. 状态与隐私不变量

官网 only decorative/demo state：固定合成示例，明确标识，不调用真实 mutation。
应用事实只来自服务端：SSE 只 refetch；重连不重复首播纪念物；clientMessageId 和现有重试规则保留。不要抢先展示未经服务端校验的 token。
实际开信保持 getCacheSafe/openLetterForMountedReader 路径；未启封正文不能先预取再遮住；不能进入共享查询、mutation cache、URL、日志、storage 或分享预览。卸载阅读器消除局部解密结果。
保留 off/shadow/enforced、只读、未到达、生成失败、可重试状态。真实请求不放在动画完成回调中，取消动效不重复提交或回滚已确认事实。
不改数据库、Provider、人格/记忆/加密/生活规则。不复活 72h 精确日程、不启用暂停的主动消息、不用花表示未发生的关系增长。公开文案区分数据存储位置与模型供应商上下文传输，不保留误导性的绝对本地承诺。

## 5. M0—M5 连续实施

**M0 基线。** 读取实际文件、检查干净工作区、记录原版 desktop/mobile 与 fixture 测试。隔离数据库，不读用户 .env/私信。独立实现分支，不强推或覆盖用户改动。

**M1 首章纵向切片。** 先制作 S01 独立桌面/手机完整概念，再产实际分层资产；实现 /about、语义标题/CTA、云/山/树/花、局部拂花、native scroll、motion 偏好和静态降级。保存各层开关与 p=0/.25/.5/.75/1 证据，证明不是整图。

**M2 四章。** S02 水面与 hit mask、真实 DOM 合成对话；S03 分层书信与显式演示；S04 稳定海洋。完成 T12/T23/T34，不整页 pin。接入锁定 copy；缺资产不以几何占位冒充完工。

**M3 切换与生命周期。** 同源功能检测式增强，跨源普通导航。取消在途转场、恢复焦点/滚动。支持 reduced/still、hidden、离屏、resize、context loss，释放无用资源。

**M4 首次与日常。** 欢迎、真实聊天、真实信件阅读优先。只继承纸感/字体/微反馈，保留文字角色设定，去掉概念图误带入的头像/附件。补 IME Enter 不误发、阅读历史时新消息不抢滚动；长中文、失败、短屏键盘等状态。遵循现有隐私边界，不为保存草稿另建敏感持久缓存。

**M5 验收。** 执行 ACCEPTANCE，逐项记录命令、退出码、截图、环境与偏差。每阶段独立 commit；实现完成需实际代码+资产+浏览器证据，不只更新文档状态。

## 6. 目标预算，不是实测保证

关键文字/CTA 不等待 3D；首屏图优先，后章按需解码。离屏暂停，最多一个活动 WebGL 上下文；卸载释放纹理、timer、RAF 和监听。pointer 只记录输入，单 RAF 批量更新，避免每帧 React setState。
新增官网首屏脚本 gzip 起点 ≤150KiB（不含已有共享基础块）；首屏 art 桌面 ≤1.8MiB / 手机 ≤900KiB；活动纹理解码预算起点 desktop ≤96MiB / mobile ≤48MiB。DPR cap 1.5/1.25。实际超预算先调低非核心纹理/层数，不降低文字可读性。
同一设备/浏览器记录 10秒 trace，桌面目标约60fps、手机约30fps；记录帧时而非只看 FPS 标签。LCP/CLS/INP 分别报告测量来源，不能把一次实验室分数当现场全设备证明。日常页 Network 应无 s01—s04 与 WebGL 请求。
