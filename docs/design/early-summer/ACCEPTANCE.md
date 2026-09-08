# 验收清单

全部实施条目初始 not-run，不能空白自动 pass。pass / fail / blocked / not-run 分开记录。

## 文案与视觉

固定标题“不只是回答你，也记住你说过的话。”；营销标题无“接住/接得住”。不盲目替换历史文档或聊天内容。
四章完整有次序，首帧有真实操作，无伪造定价/注册/社会证明/人物图像/图片消息。景物能独立隐藏、暂停、移动，运动极限不露洞，UI 是 DOM。
截图：1440×1000、1024×900、390×844、360宽与200% zoom；每章 p=0/.25/.5/.75/1，normal/reduced/still。对比构图、字体、色彩、留白、边缘/光影、图标、内容至少七项。build 通过不等于视觉通过。

## 动效与操作

native scroll、反滚、快滚、Home/End、锚点、前后退无锁定无补播；拂花局部回稳，山与CTA不跟鼠标；水域命中正确，冷却/并发上限有效；信封显式点击、键盘等价、可跳过，反滚不重置。
连续切换最后一次生效，无残留遮罩、焦点锁与重复订阅；重读旧内容不复演。offscreen/hidden 暂停，恢复不赶播，unmount 清理 RAF、timer、监听、资源。

## 首次与日常

首次可用示例角色/创建/导入文字，无视觉人物生成。显式深链接不被欢迎页抢走；已有用户、无示例、无发布角色、删除/归档角色分支均正确。
草稿、筛选、阅读位置保持，不新增敏感正文持久缓存。IME composition Enter、Shift+Enter、重复发送、发送中/失败、长中文和历史阅读时新消息覆盖。日常页不下载官网场景或 WebGL 包。

## 事实与隐私

不改契约、数据库、领域、Provider、flags。SSE 重连只 refetch，不产生新 mutation 或重复首次动画。
在隔离 fixture 中检查未启封正文不出现在 GET响应、DOM、Query/Mutation cache、storage、console、URL或分享预览。/open 失败不展示；成功只在已挂载 reader 局部持有，卸载消失。
真实请求取消动效不重发、不伪成功；幂等保留。只读/未启用/未到达/失败/重试清楚呈现。官网无用户 API 请求，不探测 localhost，不猜应用地址。

## 可访问性与性能

系统 reduced-motion 与站点设置实时生效；still 关闭全部装饰且静态完整。全部必要按钮/链接键盘可用；装饰不创建大量 tab stop；focus 清楚，reading heading 合理聚焦。
手机手势、pinch zoom、旋转、键盘不阻塞；文字对比/触控尺寸实际检查。图像、JS、WebGL加载失败仍可读可导航；无全屏强制 loader。
记录实际字节、纹理解码、trace、测试设备与 DPR；预算是目标，不伪造分数。

## 命令（先核对仓库最新配置）

基线 Node >=22 <25、pnpm@11.19.0。不要因本任务升级所有依赖。

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
pnpm test:correspondence:web
pnpm test:correspondence:focused
pnpm test:e2e
```

端到端先读 Playwright 配置，按现有方式启动隔离测试实例；不对生产运行。增加官网/偏好/首次路由/转场取消/IME/信件缓存测试。已有失败保留修改前后证据，不删断言。

## 完成报告

commit/branch；变更路径；asset ID、actualPath、sha256；命令/退出码/环境；浏览器/画幅/DPR；视觉对照；网络/帧trace；隐私与键盘证据；偏差与受阻项。
严格区分：规范落盘 / 请求提交 / Codex接单 / 实现提交 / 验收通过。评论成功不等于代理接单。
