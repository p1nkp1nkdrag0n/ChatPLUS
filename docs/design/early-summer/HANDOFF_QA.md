# 本次交付包检查记录

日期：2026-09-08。检查对象是**设计交付包、技术分镜、导入脚本**，不是 ChatPLUS 官网成品或现有业务应用。

## 实际结果

| 检查 | 实际结果 | 范围与限制 |
| --- | --- | --- |
| 资产清单 | 39 项、全部 `planned`；3 张原始参考图 SHA-256 一致 | 独立生产美术尚未生成 |
| 文案与参数自检 | 通过 | 固定记忆标题、运动模式和资产层级 |
| motion-model 单元测试 | 19 通过，0 失败 | 纯函数分镜模型，不是生产动画或后端 |
| 安全导入测试 | 9 通过，0 失败 | 使用临时本地 Git 仓库，未操作真实 ChatPLUS 工作区 |
| HTML 分镜浏览器检查 | 14 组通过 | 四章各五帧、系统/手动减少动态、still、图层开关、手机幅度、横向溢出、页面错误、印刷边界 |
| PDF | 9 页，已逐页渲染检查 | 中文字形、图层表、页面边界与版式；不是生产网页截图 |
| 本包文件完整性 | `bundle.manifest.json` 列出文件大小和 SHA-256 | 导入前校验新设计目录完整性，不覆盖现有目标 |
| GitHub 远程写入 | **受阻：403 Resource not accessible by integration** | 没有创建远程分支、提交、PR 或评论 |
| Codex 任务 | **尚未启动** | 已提供可执行任务正文，需要在有权限的 Codex 工作区中提交 |
| ChatPLUS 业务测试与视觉验收 | **未运行** | 需后续按 ACCEPTANCE.md 对真实实现执行 |

## 浏览器和 PDF 方法

通过 Python Playwright 使用系统 Chromium `144.0.7559.96`。本会话没有可用的内置交互浏览器；Playwright 默认浏览器未安装，因此使用已存在的系统 Chromium。技术分镜是自包含 HTML，使用 `page.set_content` 载入，无需绕过被策略阻止的 file:// 导航，也不访问生产服务。

检查画幅：1440×1000、1024×900、390×844、360×800。手动查看桌面、手机和印刷渲染；9 页 PDF 另经 PyMuPDF 逐页渲染检查。完整数值检查见 `evidence/handoff-browser-qa.json`。

## 修正项

本次检查中修正了进度标签窄栏换行、封面参考图导致的印刷边界溢出，以及导入脚本判断不存在分支时的 Git 退出码处理。增加了对交付文件丢失的拒绝导入检查。系统减少动态的测试等待真实媒体查询事件更新，而非在异步事件前作断言。

## 可复查命令

在交付包根目录运行：

```sh
node docs/design/early-summer/tools/validate.mjs
node --test docs/design/early-summer/tools/motion-model.test.mjs
python tests/test_importer.py
```

浏览器记录、规范校验结果及测试输出位于 `evidence/handoff-*`。这些结果不可复制成产品上线验收结果。新生成的章节概念、分层资产、实际网页以及后端回归仍需各自证据。
