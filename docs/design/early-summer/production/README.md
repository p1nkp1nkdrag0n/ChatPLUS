# 初夏来信生产资产

`masters/` 保存原尺寸的 lossless WebP master，不做描绘、补画、裁切或透明边缘修改。编码显式使用 `lossless: true, exact: true`，将原 PNG 与 master 解码到 RGBA8 后逐字节计算 SHA-256 并要求相等；完全透明像素下的 RGB 也保留。

`source-assets.json` 保留原生成 PNG 的文件名、尺寸、原始字节数、文件 SHA-256、像素 SHA-256 和项目内 master 路径；`runtime-manifest.json` 记录每个源图、master 和 runtime 的尺寸、字节、SHA-256 与透明通道统计。不将重复的原始 PNG 纳入项目。

转换器仅做等比例缩小与 WebP 编码，质量 82、透明通道质量 100，不放大、不裁切、不铺底。scene 图片额外生成宽度 768 的 `-mobile.webp`；手机构图由页面 CSS 调整。

在已提供 `sharp` 的 Node.js 环境中，可直接从项目内 master 重建：

```sh
node scripts/build-early-summer-assets.mjs
```

若运行环境的 sharp 不在项目依赖搜索路径中，传入明确模块路径（或设置 `CHATPLUS_SHARP_MODULE`）：

```sh
node scripts/build-early-summer-assets.mjs --sharp-module /absolute/path/to/sharp
```

只有首次接收生成文件或明确更新源文件时，需要额外指定 `--source-dir /absolute/path/to/generated_images`。它按 `source-assets.json` 的 `sourceFile` 建立项目内 lossless master，记录原 PNG 技术信息并验证像素相等，然后执行 runtime 转换。普通重建不需要 Codex 缓存或外部生成目录；已有 runtime 的来源与编码配置、字节哈希均吻合时直接复用。

这里记录技术来源和转换过程，不推断生成工具未给出的著作权归属、授权或权利保证。清单中的 alpha 统计只证明透明通道的技术保留，不替代视觉边缘与组合构图验收。

独立概念图若列于配置的 `concepts` 中，按原尺寸转换为质量 85 的 WebP，保存在 `references/concepts/`，并记录源 PNG 技术信息。概念图仅作参考，不进入页面 runtime，也不冒充可独立运动的场景层；它们没有另一份重复的项目内 master。

## 选图与排除记录

此前三轮出现将棋盘图案烘焙到 RGB 中的伪透明候选，它们没有纳入项目内 master、runtime 或概念图目录。配置仅包含执行负责人明确选定的来源；明确弃用的生成文件名另记于配置的 `exclusions`，转换器禁止将这些来源加入处理列表。

花坡、溪岸、海岸最终分别使用 `exec-892ec401-69d0-4e72-82a1-ed1796a19622.png`、`exec-78ede899-6a78-49a0-8046-18c7207f6dd6.png`、`exec-9250887d-08ae-47cf-a569-be311b5ed521.png`。接收时三者均验证为 1536×1024、4 通道、有真实 alpha，完全透明像素占比分别约 45.67%、62.48%、53.22%；未以棋盘颜色抠图或其他美术加工替代透明通道。
