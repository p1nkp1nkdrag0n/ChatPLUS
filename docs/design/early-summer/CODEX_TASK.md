# Codex 执行任务：ChatPLUS 初夏来信

请实际修改、验证、落盘并提交，不只返回建议。

先读取仓库现有 AGENTS.md（如有），再读本目录 README、STORYBOARD、ASSET_SPEC、assets.manifest.json、motion.tokens.json、copy.zh-CN.json、IMPLEMENTATION 和 ACCEPTANCE。基线 0a74341；执行时有新工作必须保留。若本目录尚未导入，先运行交付包根目录的 apply-to-repo.mjs 预检，再显式 --apply；不要覆盖用户文件。

用户确认：艺术主要投官网，日常主要质感。天空、云、山林、树、鲜花、溪流、海洋、旧书与羽毛笔，初夏清透青春。每个主要元素独立动态，不是大背景图缩放。首次体验轻。不生成肖像、立绘、人偶、背影或剪影，但保留文字角色设定。
固定标题“不只是回答你，也记住你说过的话。”。参考图中的人像、猫、图片消息/附件、错误文案、额外英文标语不属于批准内容；不新增注册、付费、上传、签到浇水或关系积分。

按 M0—M5 连续执行：基线→S01真正纵向切片→全部四章→路由与生命周期→首次/日常→回归。每阶段提交可检查产物，不把任务拆分理解为仅列计划。
如有 build-web-apps/frontend-app-builder，请按其流程先制作清楚的独立章节概念，再制作可动资产与实现。用 references 三张原图确认方向，但它们只是总览。先做每章桌面/手机完整独立图，沿确认方向，不换风格。缺图像能力时继续完成路由、语义DOM、运动控制和测试，明确 blocked asset ID；不以粗糙代码几何、渐变或大图裁切冒充最终美术。

保留 React/Vite/Router/TanStack Query；官网在 AppShell 外，不触发 agent 激活/SSE；首版 /about，不重命名现有业务深链接。CTA 去真实配置入口或 /start 说明，不探测 localhost、不假注册。官网动画库和大资产懒加载，日常不下载。
SSE仅refetch、消息幂等、只读/开关、未启封信安全读取/局部解密/卸载、分页/来源/分享隐私都不变。不读真实 .env/数据库，不改领域、Provider、加密或feature flags。

使用 fixture 与隔离实例执行 ACCEPTANCE。检查1440×1000、1024×900、390×844、360宽；normal/reduced/still、快滚反滚、取消导航、IME、信件失败/缓存边界。截图不含真实用户数据。
保存每阶段 commit、实际命令退出码、对照截图、资产ID/哈希与实际测量到 evidence/。不强推、不覆盖工作、不自动合并main、不部署公网。
交付必须有实际文件与证据；storyboard.html 是技术说明，不是成品官网。未完成/受阻如实报告，不宣称“像素级完成”或未运行测试通过。
