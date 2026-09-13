# Dearvale 应用图标

设计延续欢迎页的植物水彩、奶油信纸、森林绿和白色小花。以信封作为主轮廓，花朵与两片叶子作为识别点；深绿圆角底使图标在明暗桌面背景上都能辨认。四角使用真实透明通道。

- `icon-source.png`：内置 ImageGen 生成的原始作品，1254 × 1254，保留透明度。
- `icon.png`：1024 × 1024 PNG，用于 Electron 窗口及通用应用素材。
- `icon.ico`：Windows 多尺寸图标，含 16、20、24、32、40、48、64、96、128、256 像素版本。
- 原始图像创作使用内置 ImageGen；PNG 缩放和 ICO 封装由 sharp 与项目转换脚本完成，无人工重绘。

更新原始作品后，在仓库根目录运行 `pnpm desktop:icon` 重新生成 PNG 和 ICO，再运行 `pnpm desktop:dist` 更新程序、快捷方式及安装器图标。

## 生成提示词

Use case: logo-brand. Asset type: a finished desktop application icon for Dearvale, an intimate literary companion app about characters, letters, memories and slow-growing relationships. Create ONE original square 1024 x 1024 icon, not a mockup, contact sheet or presentation. The established art direction is hand-painted botanical watercolor and gouache on warm ivory paper, gently irregular brush edges, creamy parchment, muted sage and olive foliage, forest-green accents, tiny ochre-yellow flower centers, warm and quiet storybook atmosphere. Primary design: a large simple closed ivory envelope, seen straight on with only a very slight human tilt, readable triangular flap, centered on a deep muted forest-green rounded-square tile (#355942 to #466c55). One beautiful small white wildflower with a golden center and just two broad sage leaves sits at the center-right of the envelope fold like a botanical seal. This flower and the envelope should read as a single strong emblem. Envelope takes about 65 percent of the tile width, flower about 22 percent; thick substantial silhouettes and warm subtle watercolor edges, no fine outlines needed. Keep generous breathing room, all details within the tile. Tile should fill 92 percent of square canvas, evenly centered, soft 20-percent rounded corners, actual transparent pixels outside rounded tile, no white matte, no drawn checkerboard. Surface has delicate pigment blooms and subtle handmade paper grain, but composition must be bold and legible at 32x32 and 16x16. Restrained sophistication, handcrafted, calm, luminous ivory emblem against green. Lighting flat illustrated, no 3D, no plastic/glass/metal embossing, no deep drop shadow. No text, letters, initials, wordmarks, border decorations, ribbon, extra bouquets, scattered petals, or surrounding scene. Draw the finished production asset edge to edge, isolated with real alpha transparency outside the rounded tile.
