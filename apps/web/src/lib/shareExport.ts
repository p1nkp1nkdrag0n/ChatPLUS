import type { RelationshipShareProjection } from "@personasim/contracts";

export const RELATIONSHIP_SHARE_CANVAS = {
  width: 1400,
  height: 800,
  templateVersion: "relationship-share-v1",
} as const;

export interface ShareExportOptions {
  createCanvas?: () => HTMLCanvasElement;
  loadImage?: (url: string) => Promise<CanvasImageSource | undefined>;
  download?: (blob: Blob, filename: string) => void;
}

export async function exportRelationshipSharePng(
  projection: RelationshipShareProjection,
  options: ShareExportOptions = {},
): Promise<string> {
  const canvas = options.createCanvas?.() ?? document.createElement("canvas");
  canvas.width = RELATIONSHIP_SHARE_CANVAS.width;
  canvas.height = RELATIONSHIP_SHARE_CANVAS.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前浏览器无法创建分享图片");

  const keepsakeImage =
    projection.keepsake === undefined
      ? undefined
      : await (options.loadImage ?? loadSameOriginImage)(
          projection.keepsake.assetUrl,
        );
  paintRelationshipShare(context, projection, keepsakeImage);
  const blob = await canvasToPng(canvas);
  const filename = relationshipShareFilename(projection.generatedAtUtc);
  (options.download ?? downloadBlob)(blob, filename);
  return filename;
}

export function paintRelationshipShare(
  context: CanvasRenderingContext2D,
  projection: RelationshipShareProjection,
  keepsakeImage?: CanvasImageSource,
): void {
  const { width, height } = RELATIONSHIP_SHARE_CANVAS;
  context.save();
  context.fillStyle = "#f8f6ef";
  context.fillRect(0, 0, width, height);
  paintAirmailBorder(context, width, height);

  context.fillStyle = "#102945";
  context.font = '600 42px "Source Han Serif SC", "Noto Serif SC", serif';
  context.fillText("一封共同的回忆", 88, 105);
  context.font = '24px Inter, "Noto Sans SC", sans-serif';
  context.fillStyle = "#596775";
  context.fillText("仅在你的设备上生成", 90, 146);

  const imageFrame = { x: 90, y: 205, width: 430, height: 410 };
  context.fillStyle = "#fffdf8";
  context.strokeStyle = "#d9d3c6";
  context.lineWidth = 2;
  context.fillRect(
    imageFrame.x,
    imageFrame.y,
    imageFrame.width,
    imageFrame.height,
  );
  context.strokeRect(
    imageFrame.x,
    imageFrame.y,
    imageFrame.width,
    imageFrame.height,
  );
  if (keepsakeImage !== undefined) {
    paintImageContain(context, keepsakeImage, imageFrame);
  } else {
    paintEnvelope(context, imageFrame);
  }

  const rightX = 610;
  if (projection.envelope?.postmark) {
    context.save();
    context.translate(1090, 225);
    context.rotate(-0.08);
    context.strokeStyle = "#b94d25";
    context.fillStyle = "#b94d25";
    context.lineWidth = 3;
    context.beginPath();
    context.arc(0, 0, 86, 0, Math.PI * 2);
    context.stroke();
    context.font = '600 17px Inter, "Noto Sans SC", sans-serif';
    context.textAlign = "center";
    context.fillText("POSTMARK", 0, -8);
    context.font = '15px Inter, "Noto Sans SC", sans-serif';
    context.fillText(projection.envelope.postmark.slice(0, 24), 0, 22);
    context.restore();
  }

  context.fillStyle = "#102945";
  context.textAlign = "left";
  context.font = '600 30px "Source Han Serif SC", "Noto Serif SC", serif';
  const title = projection.keepsake?.title ?? "寄往远方的信";
  context.fillText(title, rightX, 330);

  if (projection.envelope?.waitingDays !== undefined) {
    context.fillStyle = "#b94d25";
    context.font = '600 22px Inter, "Noto Sans SC", sans-serif';
    context.fillText(`等待 ${projection.envelope.waitingDays} 天`, rightX, 382);
  }

  if (projection.redactedExcerpt !== undefined) {
    context.fillStyle = "#2f3b45";
    context.font = '25px "Source Han Serif SC", "Noto Serif SC", serif';
    drawWrappedText(
      context,
      `“${projection.redactedExcerpt}”`,
      rightX,
      450,
      675,
      43,
      5,
    );
  } else {
    context.fillStyle = "#66717b";
    context.font = '22px Inter, "Noto Sans SC", sans-serif';
    context.fillText("正文未包含", rightX, 450);
  }

  context.strokeStyle = "#d9d3c6";
  context.beginPath();
  context.moveTo(90, 690);
  context.lineTo(1310, 690);
  context.stroke();
  context.fillStyle = "#69747d";
  context.font = '16px Inter, "Noto Sans SC", sans-serif';
  context.fillText(
    `${projection.templateVersion} · ${projection.exportMode}`,
    90,
    735,
  );
  context.textAlign = "right";
  context.fillText("不上传 · 不创建公开链接", 1310, 735);
  context.restore();
}

export function relationshipShareFilename(generatedAtUtc: string): string {
  const stamp = generatedAtUtc.slice(0, 10).replaceAll("-", "");
  return `relationship-memory-${stamp}.png`;
}

function paintAirmailBorder(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
): void {
  const segment = 48;
  const thickness = 18;
  for (let x = 0; x < width; x += segment) {
    context.fillStyle =
      Math.floor(x / segment) % 2 === 0 ? "#315a78" : "#b64b25";
    context.fillRect(x, 0, segment - 8, thickness);
    context.fillRect(x, height - thickness, segment - 8, thickness);
  }
  for (let y = 0; y < height; y += segment) {
    context.fillStyle =
      Math.floor(y / segment) % 2 === 0 ? "#b64b25" : "#315a78";
    context.fillRect(0, y, thickness, segment - 8);
    context.fillRect(width - thickness, y, thickness, segment - 8);
  }
}

function paintEnvelope(
  context: CanvasRenderingContext2D,
  frame: { x: number; y: number; width: number; height: number },
): void {
  const x = frame.x + 52;
  const y = frame.y + 92;
  const width = frame.width - 104;
  const height = frame.height - 184;
  context.fillStyle = "#f2ead8";
  context.strokeStyle = "#b8aa8e";
  context.fillRect(x, y, width, height);
  context.strokeRect(x, y, width, height);
  context.beginPath();
  context.moveTo(x, y);
  context.lineTo(x + width / 2, y + height * 0.58);
  context.lineTo(x + width, y);
  context.stroke();
}

function paintImageContain(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource,
  frame: { x: number; y: number; width: number; height: number },
): void {
  const dimensions = imageDimensions(image);
  if (dimensions.width <= 0 || dimensions.height <= 0) return;
  const scale = Math.min(
    (frame.width - 34) / dimensions.width,
    (frame.height - 34) / dimensions.height,
  );
  const width = dimensions.width * scale;
  const height = dimensions.height * scale;
  context.drawImage(
    image,
    frame.x + (frame.width - width) / 2,
    frame.y + (frame.height - height) / 2,
    width,
    height,
  );
}

function imageDimensions(image: CanvasImageSource): {
  width: number;
  height: number;
} {
  if (image instanceof HTMLImageElement) {
    return { width: image.naturalWidth, height: image.naturalHeight };
  }
  if (
    image instanceof HTMLCanvasElement ||
    (typeof OffscreenCanvas !== "undefined" && image instanceof OffscreenCanvas)
  ) {
    return { width: image.width, height: image.height };
  }
  if (
    (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap) ||
    image instanceof HTMLVideoElement
  ) {
    return { width: image.width, height: image.height };
  }
  return { width: 0, height: 0 };
}

function drawWrappedText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number,
): void {
  let line = "";
  let lineIndex = 0;
  for (const character of text) {
    const candidate = line + character;
    if (line && context.measureText(candidate).width > maxWidth) {
      context.fillText(line, x, y + lineIndex * lineHeight);
      line = character;
      lineIndex += 1;
      if (lineIndex >= maxLines) return;
    } else {
      line = candidate;
    }
  }
  if (line && lineIndex < maxLines) {
    context.fillText(line, x, y + lineIndex * lineHeight);
  }
}

async function loadSameOriginImage(
  url: string,
): Promise<CanvasImageSource | undefined> {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { accept: "image/*" },
  });
  if (!response.ok) return undefined;
  const blob = await response.blob();
  if ("createImageBitmap" in globalThis) {
    return createImageBitmap(blob);
  }
  const objectUrl = URL.createObjectURL(blob);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("纪念物图片载入失败"));
      image.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("分享图片生成失败"));
    }, "image/png");
  });
}

function downloadBlob(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}
