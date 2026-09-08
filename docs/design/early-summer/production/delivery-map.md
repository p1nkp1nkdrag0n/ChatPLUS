# 原计划与本轮资产交付对照

原 [assets.manifest.json](../assets.manifest.json) 保留导入时的 39 个设计资产 ID、建议路径和要求；它是原计划，不是本轮生产状态清单。本轮实际交付 **15 张独立栅格源图、15 份项目内 lossless WebP master、28 份运行时 WebP，以及 4 张仅供参考的概念图**。场景由这些素材、复用实例和 DOM/CSS 组合，不能将它们计作 39 张已独立制作的美术层。

下表逐项记录实际实现和差异。原清单的 39 项均标记 `required: true`，因此未制作的独立层、以合图承载的部件和技术替代都明确列出；不将这些差异重新解释为原计划的可选项，也不据此宣称原计划全部验收通过。

运行时路径统一相对于 `apps/web/public/art/early-summer/`。各 scene 图片另有同名 `-mobile.webp`，由同一 master 等比例缩小至宽度 768；UI 两图没有额外手机版。真实源文件、master、尺寸、透明通道统计与哈希见 [source-assets.json](source-assets.json) 和 [runtime-manifest.json](runtime-manifest.json)，生成、转换及弃用来源见 [生产说明](README.md)。

## S01：天空、远山与花坡（9 项）

实现入口：[MarketingPage.tsx](../../../../apps/web/src/marketing/MarketingPage.tsx) 的首章与 [Scene.tsx](../../../../apps/web/src/marketing/Scene.tsx) 的 `Layer` / `Flower`。

| 原资产 ID       | 本轮路径或实现                          | 交付形态与边界                                                                         |
| --------------- | --------------------------------------- | -------------------------------------------------------------------------------------- |
| S01-SKY         | `s01/sky.webp`                          | 独立不透明天空栅格。                                                                   |
| S01-CLOUD-FAR   | `s01/cloud.webp`，`.layer-cloud--far`   | 与近云复用同一张透明云图；远云为单独 DOM 实例，位置、尺寸、透明度和 CSS 周期分别设置。 |
| S01-CLOUD-NEAR  | `s01/cloud.webp`，`.layer-cloud--near`  | 与远云同源的另一实例；不是第二张独立绘制的云。                                         |
| S01-MOUNTAIN    | `s01/mountain.webp`                     | 独立透明远景组，包含山体、湖面和中景树林，整体进行轻微滚动位移。                       |
| S01-FOREST      | 合入 `s01/mountain.webp`                | 中景树林没有单独素材或运动实例；随远景组整体移动。                                     |
| S01-BRANCH      | `s01/branch.webp`                       | 独立透明枝叶组；整体位移和轻摆，没有将每片叶子拆开。                                   |
| S01-MEADOW      | `s01/meadow.webp`                       | 独立透明花坡组，草、花、石块合在一张图内；整体前景位移。                               |
| S01-FLOWER-STEM | `ui/botanical-mark.webp`，`Flower`      | 花茎、叶和花头是同一透明花枝。左右各一个实例，整枝围绕底部轻摆并对局部指针作响应。     |
| S01-FLOWER-HEAD | 与花茎共用整张 `ui/botanical-mark.webp` | 未制作单独花头；未实现原计划的花头延迟跟随、独立锚点或茎弯曲。                         |

`Flower` 的实际层名为 `S01-FLOWER-LEFT` / `S01-FLOWER-RIGHT`，表示左右两组整枝，不能用这两个名字证明花头与花茎已经分离。CSS 的环境轻摆和指针响应都作用于完整花枝。

## S02：森林溪流（8 项）

实现入口：[RiverSurface.tsx](../../../../apps/web/src/marketing/RiverSurface.tsx)、[riverGeometry.ts](../../../../apps/web/src/marketing/riverGeometry.ts)、[WaterRipple.tsx](../../../../apps/web/src/marketing/WaterRipple.tsx) 与 [river.css](../../../../apps/web/src/marketing/river.css)。

| 原资产 ID       | 本轮路径或实现                                              | 交付形态与边界                                                                                                           |
| --------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| S02-FOREST-BACK | `s02/forest.webp`                                           | 独立不透明森林后板，包含林木、树影、原有河床和石块；这些内部元素没有分别拆层。                                           |
| S02-BANK        | `s02/bank.webp`                                             | 独立透明溪岸组，包含植物与石块；在水面和涟漪之上遮挡。                                                                   |
| S02-WATER       | `s02/water.webp`，`RiverSurface`                            | 独立不透明水纹栅格，通过技术路径裁成河道并柔化边缘；不是原计划的透明水面美术。CSS 对整张水纹做小幅位移、缩放和亮度变化。 |
| S02-ROCKS       | 合入 `s02/bank.webp` 与 `s02/forest.webp`                   | 没有独立石头栅格或逐石运动；前景溪岸按实际透明像素遮挡水面并排除点击。                                                   |
| S02-CANOPY      | 复用 `s01/branch.webp`                                      | 森林上方独立放置的同源枝叶实例，使用轻摆 CSS；没有另画森林叶簇。                                                         |
| S02-SHADOW      | 合入 `s02/forest.webp`                                      | 树影烘焙在后板中，未制作独立透明树影层，也不独立移动。                                                                   |
| S02-FLOW-MAP    | 无方向图；`.layer-river img` 的 `stream-flow` CSS           | 未制作逐像素流向数据或 UV 流动。当前是整张水纹的小幅 CSS 变化，不能视为方向图求解。                                      |
| S02-HIT-MASK    | `RIVER_PATH`、`RIVER_EDGE_MASK`、`Path2D` 和溪岸 alpha 采样 | 技术几何替代外部命中遮罩文件；显示与点击共用归一化河道路径及画框，额外按前景溪岸的实际 alpha 排除被遮挡点。              |

`RIVER_PATH` 按森林后板里的河床建立。SVG `clipPath` 限制水面和涟漪的可见范围，同一路径生成的内联 SVG mask 处理轻微软边；`WaterRipple` 在同一坐标空间用 `Path2D` 命中，并检查溪岸遮挡像素。这里的 Canvas 仅作技术命中采样，不渲染新的美术，不是 WebGL 水面引擎。

点击涟漪是短时 CSS 椭圆环，保留滚动手势判断、触发冷却和最多三组的限制；没有生成整幅水面模拟、粒子或流向贴图。手机使用同一画框的 CSS 构图与同源低像素图片，没有另一张手机专用河道美术。

## S03：书桌、书本与信封（12 项）

实现入口：[MarketingPage.tsx](../../../../apps/web/src/marketing/MarketingPage.tsx) 的书写章、[DemoEnvelope.tsx](../../../../apps/web/src/marketing/DemoEnvelope.tsx) 和 [marketing.css](../../../../apps/web/src/marketing/marketing.css)。

| 原资产 ID          | 本轮路径或实现                                        | 交付形态与边界                                                                                             |
| ------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| S03-TABLE          | `s03/table.webp`                                      | 独立不透明桌面场景，桌面、背景、枝叶与投影合在同一张图内。                                                 |
| S03-BOOK-COVER     | `s03/book.webp` 的封皮与书脊                          | 四个原书本部件共同合入一张透明打开的书；运行时仅一个 `S03-BOOK` 层。                                       |
| S03-BOOK-BLOCK     | 同一 `s03/book.webp` 的书页厚度                       | 无独立页块图层，随整本书作刚体旋转。                                                                       |
| S03-PAGE-LEFT      | 同一 `s03/book.webp` 的左书页                         | 没有单独书页、页背或翻页关节；图中书页为空白，正文不烘焙到图片。                                           |
| S03-PAGE-RIGHT     | 同一 `s03/book.webp` 的右书页                         | 没有单独书页、页背或翻页关节；与封皮、页块、左页整体变换。                                                 |
| S03-LETTER         | `.envelope-letter` / `.demo-letter` + `ui/paper.webp` | 用 DOM 纸张表面和通用纸纹替代独立信纸美术，开信时上移；可读正文为真实 DOM 合成示例。没有另外绘制信纸背面。 |
| S03-ENVELOPE-BACK  | `.envelope-object` + `ui/paper.webp`                  | 独立 DOM 容器承载纸纹、边框和阴影，表示后片/内侧；没有单独绘制后片与内侧纹理。                             |
| S03-ENVELOPE-FRONT | `.envelope-front` + `ui/paper.webp`                   | 独立 DOM 面片，以 `clip-path: polygon(...)` 构成前折片。                                                   |
| S03-ENVELOPE-FLAP  | `.envelope-flap` + `ui/paper.webp`                    | 独立 DOM 三角封口，围绕上沿 `rotateX(180deg)`；没有单独绘制封口背面或真实纸厚度。                          |
| S03-QUILL          | `s03/quill.webp`                                      | 独立透明整组羽毛笔与墨水瓶，本轮静止；瓶子未与笔另行拆开。                                                 |
| S03-SPRIG          | 复用 `ui/botanical-mark.webp`                         | 书桌和信封处复用完整透明花枝，不是额外鲜花源图。                                                           |
| S03-SHADOW         | 合入 `s03/table.webp`，书自身阴影合入 `s03/book.webp` | 未制作独立纸面树影素材或独立移动的阴影层。DOM 纸张另有 CSS 投影，但它不等于树影美术。                      |

书本的轻微旋转由滚动进度驱动，变换对象是整张打开的书；不存在合书、封面打开或左右书页翻转。信封演示确有分开的 DOM 前片、封口和信纸，但这是纸纹配合 CSS 几何的实现差异，不是原计划要求的四套手绘分层及背面补画。

演示状态为 `closed → opening → readable`，普通模式一次约 600ms，减少动态/静止模式直接进入可读状态；示例文字留在 DOM 内。欢迎页的信封也由 [experience.css](../../../../apps/web/src/experience/experience.css) 中的渐变、边框和几何折面构成，配合植物图；不要将官网的通用纸纹用法等同于欢迎页实际背景实现。

## S04：海岸（6 项）

实现入口：[MarketingPage.tsx](../../../../apps/web/src/marketing/MarketingPage.tsx) 的海岸章与 [marketing.css](../../../../apps/web/src/marketing/marketing.css) 的 ocean 样式。

| 原资产 ID | 本轮路径或实现           | 交付形态与边界                                                         |
| --------- | ------------------------ | ---------------------------------------------------------------------- |
| S04-SKY   | 复用 `s01/sky.webp`      | 海边单独摆放同一片天空，未另画海岸专用天空。                           |
| S04-CLOUD | 复用 `s01/cloud.webp`    | 单独云实例与缓慢 CSS 平移，和首章共用一张云图。                        |
| S04-COAST | `s04/coast.webp`         | 独立透明海岸组，运行时保持稳定，不整体摆动。                           |
| S04-SEA   | `s04/sea.webp`           | 独立不透明海面纹理，当前保持静态；纹理中的明暗与波纹并非独立运动的层。 |
| S04-SHORE | 海面与海岸图中的原有浪纹 | 未制作单独近岸浪线图，也没有新增独立浪线动画。                         |
| S04-GRASS | 复用 `s01/meadow.webp`   | 海岸前景草花组复用首章花坡，以 CSS 调整位置和小幅滚动位移。            |

本章还额外复用 `s01/branch.webp` 作上角枝叶装饰，实际层名为 `S04-BRANCH`；它不是原清单新增的一张生产源图。

## UI：纸感与植物（4 项）

实现入口：[early-summer.css](../../../../apps/web/src/styles/early-summer.css)、[experience.css](../../../../apps/web/src/experience/experience.css) 与上述官网组件。

| 原资产 ID         | 本轮路径或实现                                          | 交付形态与边界                                                                                 |
| ----------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| UI-PAPER          | `ui/paper.webp`                                         | 独立 512×512 运行时纸纹，用于官网信封/信纸和日常页面指定的纸感表面；不覆盖所有主题的阅读纸张。 |
| UI-PAGE-EDGE      | `.app-shell .letter-paper...` 的边框与多重 `box-shadow` | CSS 替代独立页边图片，表示薄页叠层；没有额外页边栅格资产。                                     |
| UI-BOOKMARK       | 无新增书签美术或纸质书签组件                            | 本轮未制作。既有信件操作不应计为已交付的书签资产。                                             |
| UI-BOTANICAL-MARK | `ui/botanical-mark.webp`                                | 独立完整透明花枝，运行时 512×768，多场景和欢迎页复用；茎、叶、花头保持一张图。                 |

## 模块、响应式和验收范围

原建议的 `SkyMeadow` / `ForestStream` / `WritingDesk` / `Ocean` 四个 scene 文件，当前集中组合在 `MarketingPage.tsx`；共用的渲染和滚动生命周期在 `Scene.tsx`，河道和交互另有独立文件。官网为原生纵向滚动，单次 `requestAnimationFrame` 更新 CSS 进度，配合 IntersectionObserver 与页面可见性暂停场景运动。没有按建议目录名创建一套空模块来代替真实实现。

实际动态包括：云图平移、枝叶整组轻摆、远近景有限滚动位移、整枝花的局部响应、水纹 CSS 变化、受河道约束的点击涟漪、整书小幅旋转和信封 DOM 开启。`reduced` / `still` 偏好关闭相应动画和交互运动；这些动态不表示逐叶、逐花头、纸张网格或水体物理模拟。

手机由 CSS 重排、移动及裁切图片实例，使用同源 `-mobile.webp` 降低传输和解码成本。**没有单独绘制 4 张竖屏概念或 15 份手机构图 master**；4 张现有概念图是横屏参考，且不用于运行时。也未对每个原计划资产分别验证 12% overscan、遮挡后补画或纸背完整性。对本轮实际构图的浏览器检查不能替代这些未执行的原资产要求。

以下是原实施文档明确允许延后或按需采用的内容，本轮未引入：羽毛笔写字演示、GSAP/WebGL、`VITE_SURFACE=app|site` 双构建入口提案。页面转场使用轻量 CSS 和即时路由，未实现原生跨文档 View Transition 增强。这些与上表中未独立制作的必需资产差异分开记录。

生产文件接收时对真实 alpha、源 PNG 与 lossless master 的完整 RGBA8 像素一致性、运行时尺寸/字节/哈希和脱离生成缓存后的重建作了检查。此前三轮含烘焙棋盘格的候选未入库；最终透明前景在 Chromium 实际合成背景上检查，不以查看器黑底预览单独判断边缘质量。业务与界面检查结果另见 [implementation-qa.md](../evidence/implementation-qa.md) 和 [m4-visual-review.md](../evidence/m4-visual-review.md)，本文件只解释交付映射及已知差异。
