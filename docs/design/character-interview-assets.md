# Character interview illustration assets

Generated with the built-in `image_gen` tool on 2026-09-11. The four production PNGs are image-tool outputs copied unchanged into the project; no scripted extraction, recoloring, resizing, or repainting was used.

## Reference and layers

The approved question and preview concepts are preserved beside this document as `character-interview-question-concept.png` and `character-interview-preview-concept.png`. The question concept is the strict composition/style source for all layers. Its canvas is 1672 × 941.

| Production asset | Canvas | Transparency | Content and placement |
| --- | --- | --- | --- |
| `/dearvale/art/creation/scene.png` | 1672 × 941 | RGB, opaque | Window/lake, plaster wall, wooden desk, books, letter, postcard, vase and daisies. All lettering and central paper/ink/quill removed. Use as the shared background for question and preview. |
| `/dearvale/art/creation/paper.png` | 1774 × 887 | RGBA, alpha 0–255 | Complete blank deckled paper stack. Sampled solid bounds approximately (52,36)–(1752,860). Match its visible bounds to reference scene approximately (330,390)–(1440,920). |
| `/dearvale/art/creation/ink.png` | 1254 × 1254 | RGBA, alpha 0–255 | Separate dark blue square open ink bottle. Sampled solid bounds (240,212)–(1020,1092). Mouth center approximately (635,278), normalized (50.64%,22.17%). Reference visible bounds approximately (1348,478)–(1490,641). |
| `/dearvale/art/creation/quill.png` | 1024 × 1536 | RGBA, background alpha 0; subject samples alpha 253 | Ivory feather with gold nib pointing down-left. Nib anchor approximately (126,1452), normalized (12.30%,94.53%). Feather top approximately (936,78). Parked nib in the scene approximately (1440,825). A displayed canvas around 300 × 450 preserves the reference's right-side diagonal pose. |

Coordinates are measured from each canvas's top-left; bounds include visible object pixels but exclude transparent padding. They are intended to guide responsive CSS placement, not to force fixed viewport dimensions. The reference has a slightly clipped upper feather tip; the production quill contains the entire feather so it can move and rotate without revealing a clipped edge. UI text, input lines, buttons, and paper transitions remain live DOM/CSS elements.

Alpha was verified with Windows `System.Drawing.Bitmap.GetPixel`; every production cutout has genuinely transparent perimeter samples, with visible subject samples close to or at opacity 255. PNG previews may expose RGB information beneath transparent pixels; that RGB is not an opaque background. For example, quill pixel (400,1100) has alpha 0, while feather pixel (700,400) has alpha 253. Check actual browser compositing rather than RGB-only preview appearance.

## Selected outputs and prompts

Source generation directory: `C:/Users/34080/.codex/generated_images/01a08c6a-b263-7711-ae6a-c93f55c98ee6/`.

### Scene — `exec-191e2a42-52e2-44aa-ae80-a2440441d5f0.png`

> Use case: precise-object-edit. Edit this exact image into a clean production background plate for a layered interactive scene. Keep its original landscape aspect ratio, camera framing and warm illustrated gouache/watercolor strokes exactly. Remove ONLY all text/UI (Dearvale logo, top right Chinese, center title, question, answer, line and buttons), the entire large center stack of paper, the black-blue square ink bottle on the right, and the feather quill on the far right. Fill the removed paper/bottle/quill region with the same continuous sunlit wooden tabletop and leaf light/shadows. Keep the left window, blue lake and mountains, leafy branches, warm plaster wall, shadows, books at lower left, envelope and postcard at lower left, and right vase of daisies EXACTLY in their current sizes and positions. No new objects, no writing, no UI, no papers in central region. Preserve the existing painted illustration style; not photo or 3D. This is the base layer, foreground paper and ink/quill will be layered separately. High fidelity to the supplied reference.

### Paper — `exec-5aa9622a-203c-46ac-a236-5f4830904d2b.png`

> Use case: background-extraction. Produce one separate game sprite from this image: ONLY the central stack of warm cream writing papers, in same warm watercolor gouache illustration style. Isolated on an empty transparent background. Landscape image 2:1; stack fills image with 5% clear padding. Include entire deckled edges with no clipping. Retain same exact paper object, perspective, stack layers and subtle light from reference. Remove all Chinese text, underline and buttons so paper center is entirely blank. No ink bottle, no feather, no scenery, no tabletop, no text, no cast shadow. This is a transparent sprite image with full transparent space around its perimeter.

### Ink — `exec-b7f3108f-3eef-4cd2-9e58-eec853251413.png`

> Use case: background-extraction. Produce one separate game sprite from this image: ONLY the dark blue-black square glass ink bottle to right of the paper, open round ink well neck, in same warm watercolor gouache illustration style. Isolated on an empty transparent background. Square image with 12% empty clear padding. Show entire bottle and exact reference perspective, dark blue reflective glass, warm golden sun highlights, visible opening for dipping a nib. Retain same exact ink bottle object appearance as the reference. No feather, no flowers, no scenery, no tabletop, no text, no cast shadow. This is a transparent sprite image with full transparent space around its perimeter.

### Quill — `exec-10262c8e-e98b-4d4a-99d1-c6107bf8126c.png`

Initial extraction `exec-03261414-219b-4386-974e-b423df176a91.png` used the approved question concept:

> Use case: background-extraction. Produce one separate game sprite from this image: ONLY the right-side feather quill, in same warm watercolor gouache illustration style, white ivory feather with visible gray barbs and golden nib. Isolated on an empty transparent background. It points down-left: writing nib point at 10% from left and 90% from top, full feather tip at 84% from left and 6% from top. Include the entire feather with no clipped extremities. Portrait image 2:3. Retain same exact feather object and golden nib appearance as the reference. No ink bottle, no scenery, no tabletop, no text, no cast shadow. This is a transparent sprite image with full transparent space around its perimeter.

Final refinement used that extracted quill:

> Use case: background-extraction. Keep this exact quill sprite, nib and feather shape/position/color/size unchanged. It is for a layered watercolor interface. Remove all outer soft glows, blur, halo, bloom, and cast shadow completely. Leave only the solid feather strands and golden nib, isolated on empty transparent background. Crisp natural feather silhouette and tiny transparent gaps between separated barbs. No aura around any edge. No ambient glow. No scenery. Preserve real transparent PNG alpha. Output same 1024x1536 with same anchors.

## Rejected variants

Paper attempts `exec-d3b5ceea-9483-414b-8c04-a86db51c1c6d.png` and `exec-043385bf-8d4a-4817-80b9-7bda59b87bbf.png` incorrectly contained an opaque checkerboard. Both were detected as RGB / corner alpha 255 and excluded from project assets. The selected third paper output uses real RGBA transparency.
