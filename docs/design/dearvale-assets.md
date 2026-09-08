# Dearvale production art manifest

生成日期：2026-09-08。资源目录：`apps/web/public/dearvale/art/`。

## 来源与制作方式

本批素材是通过内置 `image_gen.imagegen` 编辑本会话中已确认的 AI 视觉稿得到的生产插画。生成前读取本地输入图，生成后逐张目视检查，再复制选定结果到项目。未使用 Python、CLI 图像模型、重绘脚本或图片滤镜处理这些 PNG；保留内置工具的原生 PNG 输出。

场景的修改仅用于移除烘焙在视觉稿里的字标、气泡、导航圆点、箭头、按钮和外部白边，并补全被 UI 覆盖的绘画。文字、圆角、按钮和滚动交互由前端渲染。书桌画面中原有的装饰性手写书页纹理属于插画内容，不是产品文案。

输入视觉稿目录：`C:/Users/34080/.codex/generated_images/01a0805a-036c-77d2-81c1-cdebcff660bc/`。

本批工具输出目录：`C:/Users/34080/.codex/generated_images/01a08094-bd0c-7341-bbe2-c188f6ece468/`。

## 授权与 AI 生成说明

这些资源为用户已授权的 Dearvale 产品改版工作生成和编辑；其来源为本会话批准的视觉稿，没有从 Linear 或 Lusion 网站下载并打包其图片。Linear 与 Lusion 是页面排版、艺术氛围的参考，并非本目录内资源的文件来源。

本清单记录项目素材的制作来源，不宣称这些图片属于公共领域，也不额外授予第三方独立开源许可证。AI 图片按该项目现有的授权和分发约定使用。独立 SVG 字标所用字体的许可证应由字体/品牌资源实现一并保留；字体授权不由本 PNG 清单替代。

## 已交付 PNG

所有以下 PNG 都是独立艺术素材，不是整页 UI 截图。所有文件当前均为不透明 RGB PNG。

| 文件               | 原生尺寸    | 用途                           | 背景/接入说明                                                          |
| ------------------ | ----------- | ------------------------------ | ---------------------------------------------------------------------- |
| `mountain.png`     | 1671 × 941  | 官网山湖开场与山湖对话背景     | 满幅场景，无烘焙 UI 和白边                                             |
| `forest.png`       | 1670 × 941  | 官网林溪与接续记忆场景         | 满幅场景，无烘焙 UI 和白边                                             |
| `desk.png`         | 1671 × 941  | 官网书桌与往来书信场景         | 满幅场景，无烘焙 UI 和白边                                             |
| `coast.png`        | 1672 × 941  | 官网海岸夕照与共同经历场景     | 满幅场景，无烘焙 UI 和白边                                             |
| `night.png`        | 1670 × 941  | 官网独立星夜与结尾场景         | 满幅场景，无烘焙 UI 和白边                                             |
| `welcome.png`      | 1619 × 971  | 进入页顶部信封和花叶插画       | 暖白外沿约 #f8f6ef～#fbf8f3，适配 #faf8f2 面板                         |
| `letter-paper.png` | 1173 × 1341 | 书信阅读区空白信纸与右侧花枝   | 空白正文区、正直信纸；暖白细外沿；右侧保留花叶                         |
| `botanical.png`    | 887 × 1774  | 页面边角与头像可复用的纵向花枝 | 近纯白底；用 CSS `mix-blend-mode: multiply` 融入暖白页面，非真实 alpha |

## 透明输出核验与字标选择

内置 ImageGen 的字标和花枝首次“透明”输出，以及一次定向重试，实际均为 PNG color type 2 / `Format24bppRgb`，抽样 alpha 全为 255。其背景是绘制在图片中的棋盘格，不能用于生产透明叠图。失败图片保留在工具默认生成目录，未复制到项目。

- `botanical.png` 随后再次使用 ImageGen 把棋盘格替换为近纯白背景。前端采用 CSS multiply 与暖白底融合；不要把它声明为具有 alpha 通道，也不要用普通不透明图片叠放到深色背景。
- 金边 `Dearvale` 字标由主实现使用已确认的 Cormorant 真实字形轮廓创建独立 SVG 品牌资源 `apps/web/public/dearvale/art/wordmark.svg`，保持深绿字身、金色描边与轻阴影。这是原生矢量品牌实现，不是对失败 PNG 的编辑。本批没有交付 `wordmark.png`。
- `letter-paper.png` 原先可选的透明外沿同样未成功，已使用 ImageGen 改成干净的暖白外沿；纸张正文始终为空白。

失败透明输出（不属于生产目录）：`exec-4b0a8038-95ee-445d-bb81-c75d6280a570.png`、`exec-f61ec6f3-d7a9-46ef-9202-5f4b422f7b10.png`；定向透明重试：`exec-01d81b79-1a98-4df8-84a2-e966fdc6f1de.png`、`exec-c0f41f0e-5577-4618-aee4-67744c749fc2.png`。信纸中间稿：`exec-be93e7fb-31df-48ff-bfde-0d6cb5913a2e.png`。

## 完整生成记录与提示词

### mountain.png

- 编辑输入：`C:/Users/34080/.codex/generated_images/01a0805a-036c-77d2-81c1-cdebcff660bc/exec-3089c4e6-9cb2-44f4-b89d-7381165598db.png`
- 选定工具输出：`C:/Users/34080/.codex/generated_images/01a08094-bd0c-7341-bbe2-c188f6ece468/exec-a544a293-bdbe-4bad-a7fb-23d878296d79.png`
- 字节数：2613461
- SHA-256：`d1b4028605ad884ce594949f2aadcf22ebd70656f625e2e5be1602e51aad656e`

原始提示词：

```text
Use case: precise-object-edit. Asset type: production website scenic background. The attached image is the EDIT TARGET, not loose inspiration. Make ONLY the specified UI removal. Inpaint the covered areas by continuing the immediately surrounding original painting. Also remove the white outside margin and rounded-corner mask: extend existing painted scenery a few pixels to all rectangular canvas edges, no border, no framing, no white strips. Keep the same wide landscape aspect ratio, same crop, composition and major object positions, native resolution around 1672x942 or 1920x1080. Keep the already approved 2D hand-painted gouache/watercolor picture-book aesthetic, visible color-block brushwork, matte pigments, gentle warm nature colors. Do not restyle, redesign, regenerate the whole scene, add objects or flatten the palette. No logos, UI, bubbles, navigation, buttons, watermark, photographic rendering or 3D. Remove the central Dearvale wordmark and its shadow, the Chinese scroll instruction and chevron, and all five right-side navigation dots. Preserve the daylight lake, blue sky, mountain silhouettes, left tree canopy, right hill town, boats, foreground daisies and stone wall exactly.
```

### forest.png

- 编辑输入：`C:/Users/34080/.codex/generated_images/01a0805a-036c-77d2-81c1-cdebcff660bc/exec-b5d8919f-4ba7-4648-9141-f692e7e20d3f.png`
- 选定工具输出：`C:/Users/34080/.codex/generated_images/01a08094-bd0c-7341-bbe2-c188f6ece468/exec-a8cf6b6b-4bcb-4e65-9ecf-a84779493165.png`
- 字节数：2743425
- SHA-256：`b93b5bfd302a9c75c965172028cc08f0aecbdd1c4bf52558380f18428e7cf159`

原始提示词：

```text
Use case: precise-object-edit. Asset type: production website scenic background. The attached image is the EDIT TARGET, not loose inspiration. Make ONLY the specified UI removal. Inpaint the covered areas by continuing the immediately surrounding original painting. Also remove the white outside margin and rounded-corner mask: extend existing painted scenery a few pixels to all rectangular canvas edges, no border, no framing, no white strips. Keep the same wide landscape aspect ratio, same crop, composition and major object positions, native resolution around 1672x942 or 1920x1080. Keep the already approved 2D hand-painted gouache/watercolor picture-book aesthetic, visible color-block brushwork, matte pigments, gentle warm nature colors. Do not restyle, redesign, regenerate the whole scene, add objects or flatten the palette. No logos, UI, bubbles, navigation, buttons, watermark, photographic rendering or 3D. Remove both translucent Chinese conversation bubbles, all five right-side navigation dots, and the bottom chevron. Preserve the winding forest stream, right stone arch bridge, tree canopy, moss-covered rocks, white and purple wildflowers, and sunny forest depth exactly.
```

### desk.png

- 编辑输入：`C:/Users/34080/.codex/generated_images/01a0805a-036c-77d2-81c1-cdebcff660bc/exec-a2a47887-02b6-43a0-af44-916a2a02339a.png`
- 选定工具输出：`C:/Users/34080/.codex/generated_images/01a08094-bd0c-7341-bbe2-c188f6ece468/exec-f36d19a9-0d46-4689-9299-158c77b1eb8b.png`
- 字节数：2612464
- SHA-256：`db60341c43387a6dcf1985137e2c7373c776f717a1465340ac137f15b3983ec7`

原始提示词：

```text
Use case: precise-object-edit. Asset type: production website scenic background. The attached image is the EDIT TARGET, not loose inspiration. Make ONLY the specified UI removal. Inpaint the covered areas by continuing the immediately surrounding original painting. Also remove the white outside margin and rounded-corner mask: extend existing painted scenery a few pixels to all rectangular canvas edges, no border, no framing, no white strips. Keep the same wide landscape aspect ratio, same crop, composition and major object positions, native resolution around 1672x942 or 1920x1080. Keep the already approved 2D hand-painted gouache/watercolor picture-book aesthetic, visible color-block brushwork, matte pigments, gentle warm nature colors. Do not restyle, redesign, regenerate the whole scene, add objects or flatten the palette. No logos, UI, bubbles, navigation, buttons, watermark, photographic rendering or 3D. Remove both translucent Chinese conversation bubbles, all five right-side navigation dots, and the bottom chevron. Preserve the open illustrated botanical journal, envelope, lake-view postcard, books, black ink bottle, glass daisy vase, quill, wooden desktop, cream wall shadows and lake-facing window. Preserve small original handwritten journal texture as artwork but add no new readable text.
```

### coast.png

- 编辑输入：`C:/Users/34080/.codex/generated_images/01a0805a-036c-77d2-81c1-cdebcff660bc/exec-8c980441-abb3-42cb-b678-ac92e2e94027.png`
- 选定工具输出：`C:/Users/34080/.codex/generated_images/01a08094-bd0c-7341-bbe2-c188f6ece468/exec-6617c307-8ea7-4e92-b4b8-dca0142f0a77.png`
- 字节数：2784740
- SHA-256：`c5be80f660f325c3afd7e04f7ff0ce80e8d05fd2ed216a575099d8d8c59e4560`

原始提示词：

```text
Use case: precise-object-edit. Asset type: production website scenic background. The attached image is the EDIT TARGET, not loose inspiration. Make ONLY the specified UI removal. Inpaint the covered areas by continuing the immediately surrounding original painting. Also remove the white outside margin and rounded-corner mask: extend existing painted scenery a few pixels to all rectangular canvas edges, no border, no framing, no white strips. Keep the same wide landscape aspect ratio, same crop, composition and major object positions, native resolution around 1672x942 or 1920x1080. Keep the already approved 2D hand-painted gouache/watercolor picture-book aesthetic, visible color-block brushwork, matte pigments, gentle warm nature colors. Do not restyle, redesign, regenerate the whole scene, add objects or flatten the palette. No logos, UI, bubbles, navigation, buttons, watermark, photographic rendering or 3D. Remove both translucent Chinese conversation bubbles, all five right-side navigation dots, and the bottom chevron. Preserve the golden-pink sunset sky and sun on right, coast and sea, hillside village, descending central stone steps, left tree canopy, wildflowers and stone walls exactly.
```

### night.png

- 编辑输入：`C:/Users/34080/.codex/generated_images/01a0805a-036c-77d2-81c1-cdebcff660bc/exec-b09120d0-ba17-445c-ab37-7f31fa1dc184.png`
- 选定工具输出：`C:/Users/34080/.codex/generated_images/01a08094-bd0c-7341-bbe2-c188f6ece468/exec-eeb2d9db-b16e-408f-9cdd-db317e803cef.png`
- 字节数：2753663
- SHA-256：`ee597f37f59fbe0097495bdd243a3e5424b784b8b43f384c6f78d17b10782a1e`

原始提示词：

```text
Use case: precise-object-edit. Asset type: production website scenic background. The attached image is the EDIT TARGET, not loose inspiration. Make ONLY the specified UI removal. Inpaint the covered areas by continuing the immediately surrounding original painting. Also remove the white outside margin and rounded-corner mask: extend existing painted scenery a few pixels to all rectangular canvas edges, no border, no framing, no white strips. Keep the same wide landscape aspect ratio, same crop, composition and major object positions, native resolution around 1672x942 or 1920x1080. Keep the already approved 2D hand-painted gouache/watercolor picture-book aesthetic, visible color-block brushwork, matte pigments, gentle warm nature colors. Do not restyle, redesign, regenerate the whole scene, add objects or flatten the palette. No logos, UI, bubbles, navigation, buttons, watermark, photographic rendering or 3D. Remove both translucent Chinese conversation bubbles, all five right-side navigation dots and the bottom-right green 开始相遇 button with arrow. Preserve the DARK BLUE NIGHT SKY, hand-painted blue-purple Milky Way and stars, layered dark mountains, warm illuminated HILLSIDE VILLAGES, lantern-lined footpath and foreground daisies exactly. This is dry mountainous countryside AT NIGHT: DO NOT introduce any lake, sea, daylight, sun, blue daytime sky, or new scenery.
```

### welcome.png

- 编辑输入：`C:/Users/34080/.codex/generated_images/01a0805a-036c-77d2-81c1-cdebcff660bc/exec-2e2c0cd4-a85a-4133-9dfe-79b50d356370.png`
- 选定工具输出：`C:/Users/34080/.codex/generated_images/01a08094-bd0c-7341-bbe2-c188f6ece468/exec-45bb35f8-a803-43b7-843b-652a9208821c.png`
- 字节数：1806757
- SHA-256：`f352d3f290a47cb98413e738012624cfcf4d982d553171f41fcacaa49c98a92a`

原始提示词：

```text
Use case: precise-object-edit. Asset type: production welcome-card top illustration only, landscape approximately 1200x720. The attached image is the EDIT TARGET. Extract and enlarge ONLY the illustration occupying the top part of the central welcome panel: warm ivory closed envelope, white daisies and small pale-purple flowers with sage green leaves lying against its lower-right corner, small fallen petals, and a little of the leafy boughs entering the upper-left and upper-right corners. Preserve this exact approved 2D hand-painted watercolor/gouache design, object proportions and relative arrangement. Remove ALL Dearvale logo/text, Chinese headings and body text, buttons, links, card outline and rest of page. Reframe to the art region only: envelope and flower bundle clearly occupy the central approximately 70% of this small header illustration. Background should be a uniform very pale warm white hex #faf8f2, with only subtle hand-painted tonal texture close to the envelope that gently fades into that exact #faf8f2 at all outer edges for seamless integration into a card. No UI, no lettering, no frame, no new objects, no photorealistic depth, no 3D. Keep flowers delicate and youthful.
```

### letter-paper.png

- 编辑输入：`C:/Users/34080/.codex/generated_images/01a0805a-036c-77d2-81c1-cdebcff660bc/exec-381351df-09f7-4f38-a049-366f74a0b45a.png`
- 选定工具输出：`C:/Users/34080/.codex/generated_images/01a08094-bd0c-7341-bbe2-c188f6ece468/exec-b52b1665-8812-4f80-ab59-4d4d9c9d1041.png`
- 字节数：1781121
- SHA-256：`a7fceb8b62970c07ad4f58291009892d846ebcde5e22c367911940968b086d94`

原始提示词：

```text
Use case: precise-object-edit. Asset type: production blank letter paper illustration, portrait approximately 896x1024. The attached approved letters page is the exact EDIT TARGET. Extract ONLY the large upright rectangular cream paper sheet displayed in its right-hand reading panel, keeping the delicate hand-painted white daisy and sage-leaf branch on the right margin and its tiny fallen pale petals. Remove every title, date, Chinese paragraph, quotation, signature and every other mark of writing so that the whole central and left 75% of the paper is clean blank writing space. Remove all surrounding app UI, sidebar, thumbnails, buttons, panel, borders. Straight-on perfectly upright paper rectangle, no rotation, no perspective, no curled 3D pages. Preserve its pale warm-ivory watercolor paper appearance, subtle light paper grain and delicate handmade deckled paper edges; avoid dark stains or heavy texture that would interfere with readable overlaid text. The paper occupies nearly the full portrait image. Keep the entire sheet and botanical branch in frame, with a narrow genuinely transparent alpha margin outside the paper's natural edges. No fake checkerboard, no UI, no text, no new illustrations, no photorealism, no 3D.
```

选定版本的背景修正输入：`C:/Users/34080/.codex/generated_images/01a08094-bd0c-7341-bbe2-c188f6ece468/exec-be93e7fb-31df-48ff-bfde-0d6cb5913a2e.png`

背景修正提示词：

```text
Use case: precise-object-edit. The attached blank hand-painted daisy letter-paper asset is the exact EDIT TARGET. Change ONLY the narrow grey/white checkerboard area outside the paper: replace it with a uniform solid warm white #faf8f2. No checkerboard anywhere. Preserve the exact blank ivory paper, its deckle edges, right-side daisy foliage, tiny petals and upright portrait composition. Do not add any text, UI, title, date, border or shadow. Keep output opaque RGB PNG with this warm white margin. Do not redraw the artwork or alter colors.
```

### botanical.png

- 编辑输入：`C:/Users/34080/.codex/generated_images/01a0805a-036c-77d2-81c1-cdebcff660bc/exec-2e2c0cd4-a85a-4133-9dfe-79b50d356370.png`
- 选定工具输出：`C:/Users/34080/.codex/generated_images/01a08094-bd0c-7341-bbe2-c188f6ece468/exec-715408e7-d206-476b-98b4-077c4b162906.png`
- 字节数：1528338
- SHA-256：`9338d113d67ac9864992e945fc61c28338f1846927d9a60cdb115c6f1c87551f`

原始提示词：

```text
Use case: background-extraction. Asset type: reusable production botanical corner ornament, PNG with actual alpha transparency, tall portrait approximately 640x1280. The attached approved welcome illustration is the EDIT TARGET/style source. Isolate a single slender gently branching flower-and-leaf cluster matching the LOWER-LEFT corner ornament in that image: delicate white daisies with warm yellow centers, a few yellow buds, muted sage and olive leaves, slender curved stems. Keep the same refined 2D gouache/watercolor shapes and visible soft brushwork, not a 3D or photographic plant. The sprig rises vertically with an organic slightly diagonal curve, wider toward its lower portion, useful for a page corner or cropped botanical avatar. Keep every flower, leaf and stem tip inside the canvas with a small transparent padding; no clipped tips. Remove the original page, paper, envelopes, text and all UI. Background MUST be genuinely transparent with a real alpha channel, including holes between the leaves. No cream backdrop, no white square, no checkerboard painted in, no pot, vase, ground, rectangular border or drop shadow.
```

选定版本的背景修正输入：`C:/Users/34080/.codex/generated_images/01a08094-bd0c-7341-bbe2-c188f6ece468/exec-f61ec6f3-d7a9-46ef-9202-5f4b422f7b10.png`

背景修正提示词：

```text
Use case: precise-object-edit. Production botanical corner illustration. The attached vertical hand-painted daisy-and-leaf sprig is the exact EDIT TARGET. Replace ONLY the grey-and-white checkerboard background with perfectly clean uniform SOLID PURE WHITE (#FFFFFF). Also fill the spaces between leaves and stems with that same solid white. Preserve the existing complete slender botanical sprig, every leaf, flower petal, bud, stem, its size and placement, and the hand-painted watercolor/gouache colors and shapes. No checkerboard anywhere, no grey texture, no paper grain in the background, no border, no extra shadow, no typography, no new objects. Output an opaque RGB PNG on white, tall portrait same dimensions and composition as the target. The white background will be blended in CSS; do not simulate transparency.
```

## 视觉与文件核验

- 逐张检查五个场景没有残留按钮、气泡、导航点、字标或外部白框，绘本笔触与确认稿保持一致。
- 夜景保持深蓝星空、银河、山脉、山城暖灯与小径；没有替换成白天、湖面或海面。
- 进入插画只有信封、花叶、花瓣与暖白底，没有标题、按钮、面板外框。
- 信纸正直、正文为空白，花枝留在右侧，未恢复正文、签名或 UI。
- 花枝完整保留枝叶与花朵，没有棋盘格；已明确用混合模式接入，未假称 alpha 透明。
- 用系统图像读取检查原生尺寸、PNG 格式与 alpha，文件 SHA-256 见各条记录。
