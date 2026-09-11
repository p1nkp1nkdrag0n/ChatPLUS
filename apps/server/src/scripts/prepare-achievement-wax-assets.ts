import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import sharp from "sharp";
import {
  ACHIEVEMENT_WAX_BADGES,
  getAchievementWaxBadge,
} from "@personasim/contracts";

// This export step preserves generated PNG originals and their alpha. It does
// not synthesize artwork, recolor, mask or crop the source images.
const assetRoot = fileURLToPath(
  new URL("../../../web/public/dearvale/achievements/wax-v2/", import.meta.url),
);
const files = [];
for (const key of Object.keys(ACHIEVEMENT_WAX_BADGES)) {
  const sourcePath = resolve(assetRoot, `${key}.png`);
  const bytes = await readFile(sourcePath);
  const source = sharp(bytes, {
    failOn: "error",
    limitInputPixels: 16_000_000,
  });
  const metadata = await source.metadata();
  const { data, info } = await source
    .clone()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let clearPixels = 0;
  let cornerAlphaMaximum = 0;
  const cornerSize = Math.max(
    1,
    Math.floor(Math.min(info.width, info.height) * 0.03),
  );
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const alpha = data[(y * info.width + x) * info.channels + 3]!;
      if (alpha <= 2) clearPixels++;
      if (
        (x < cornerSize || x >= info.width - cornerSize) &&
        (y < cornerSize || y >= info.height - cornerSize)
      ) {
        cornerAlphaMaximum = Math.max(cornerAlphaMaximum, alpha);
      }
    }
  }
  const clearFraction = clearPixels / (info.width * info.height);
  // Permit insignificant 1–2/255 antialias/quantization residue in the source.
  if (
    !metadata.hasAlpha ||
    metadata.width !== metadata.height ||
    !metadata.width ||
    metadata.width < 1024 ||
    clearFraction < 0.15 ||
    clearFraction > 0.75 ||
    cornerAlphaMaximum > 2
  ) {
    throw new Error(
      `${key}: expected a square high-resolution transparent seal (${JSON.stringify({ hasAlpha: metadata.hasAlpha, clearFraction, cornerAlphaMaximum })})`,
    );
  }
  const primary = await source
    .clone()
    .resize(1024, 1024, { fit: "contain" })
    .webp({ quality: 88, alphaQuality: 100, effort: 6 })
    .toBuffer();
  const thumbnail = await source
    .clone()
    .resize(320, 320, { fit: "contain" })
    .webp({ quality: 86, alphaQuality: 100, effort: 6 })
    .toBuffer();
  await writeFile(resolve(assetRoot, `${key}.webp`), primary);
  await writeFile(resolve(assetRoot, `${key}.thumb.webp`), thumbnail);
  for (const [image, size] of [
    [primary, 1024],
    [thumbnail, 320],
  ] as const) {
    const actual = await sharp(image).metadata();
    if (!actual.hasAlpha || actual.width !== size || actual.height !== size) {
      throw new Error(
        `${key}: alpha or output dimensions were lost during export`,
      );
    }
  }
  files.push({
    key,
    ...getAchievementWaxBadge(key),
    png: `${key}.png`,
    sourceWidth: metadata.width,
    sourceHeight: metadata.height,
    width: 1024,
    height: 1024,
    thumbnailWidth: 320,
    thumbnailHeight: 320,
    sourceSha256: createHash("sha256").update(bytes).digest("hex"),
    sha256: createHash("sha256").update(primary).digest("hex"),
    bytes: primary.length,
    thumbnailBytes: thumbnail.length,
    hasAlpha: true,
    clearFraction: Number(clearFraction.toFixed(4)),
    cornerAlphaMaximum,
  });
}
await writeFile(
  resolve(assetRoot, "manifest.json"),
  `${JSON.stringify({ version: 2, style: "C gilded wax", generator: "built-in imagegen", files }, null, 2)}\n`,
);
process.stdout.write(
  `Prepared ${files.length} transparent wax seals: 1024px WebP + 320px thumbnails. PNG originals preserved.\n`,
);
