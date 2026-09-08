import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const productionDirectory = resolve(
  projectRoot,
  "docs/design/early-summer/production",
);
const configurationPath = resolve(productionDirectory, "source-assets.json");
const require = createRequire(import.meta.url);
const argumentsList = process.argv.slice(2);

function option(name) {
  const index = argumentsList.indexOf(name);
  return index === -1 ? undefined : argumentsList[index + 1];
}

const sharpModule =
  option("--sharp-module") ?? process.env["CHATPLUS_SHARP_MODULE"] ?? "sharp";
const sharp = require(sharpModule);
const sourceDirectory = option("--source-dir");
const configuration = JSON.parse(await readFile(configurationPath, "utf8"));
const excludedSources = new Set(
  (configuration.exclusions ?? []).map((entry) => entry.sourceFile),
);
for (const entry of [
  ...configuration.assets,
  ...(configuration.concepts ?? []),
]) {
  if (excludedSources.has(entry.sourceFile)) {
    throw new Error(
      `Rejected source cannot enter the asset pipeline: ${entry.sourceFile}`,
    );
  }
}
const runtimeManifestPath = resolve(
  productionDirectory,
  "runtime-manifest.json",
);
let previousManifest;
try {
  previousManifest = JSON.parse(await readFile(runtimeManifestPath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const manifest = {
  schemaVersion: 1,
  provenance: configuration.provenance,
  exclusions: configuration.exclusions ?? [],
  conversion: {
    pipeline: "scripts/build-early-summer-assets.mjs",
    configuration: "docs/design/early-summer/production/source-assets.json",
    sharpVersion: sharp.versions.sharp,
    webpVersion: sharp.versions.webp,
    masterEncoding:
      "Lossless WebP with exact=true; decoded RGBA8 bytes must match the source PNG, including RGB under zero alpha.",
    quality: 82,
    alphaQuality: 100,
    effort: 6,
    resize:
      "Proportional width resize, no enlargement, no crop, no flattening, no retouching.",
    metadataPolicy:
      "Source PNG filenames, byte hashes, dimensions and decoded pixel hashes are retained in the source manifest. Lossless WebP masters and runtime WebP outputs use sharp default metadata handling.",
  },
  assets: [],
  concepts: [],
};

function projectPath(pathname) {
  const absolutePath = resolve(projectRoot, pathname);
  const relativePath = relative(projectRoot, absolutePath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Asset path must remain inside the project: ${pathname}`);
  }
  return absolutePath;
}

function normalizedPath(pathname) {
  return relative(projectRoot, pathname).split(sep).join("/");
}

async function describeImage(pathname) {
  const bytes = await readFile(pathname);
  const metadata = await sharp(bytes).metadata();
  const { data, info } = await sharp(bytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let alpha;
  if (metadata.hasAlpha) {
    let minimum = 255;
    let maximum = 0;
    let transparentPixels = 0;
    let translucentPixels = 0;
    for (
      let index = info.channels - 1;
      index < data.length;
      index += info.channels
    ) {
      const opacity = data[index];
      minimum = Math.min(minimum, opacity);
      maximum = Math.max(maximum, opacity);
      if (opacity === 0) transparentPixels += 1;
      else if (opacity < 255) translucentPixels += 1;
    }
    const pixelCount = info.width * info.height;
    alpha = {
      minimum,
      maximum,
      transparentPixelFraction: Number(
        (transparentPixels / pixelCount).toFixed(6),
      ),
      translucentPixelFraction: Number(
        (translucentPixels / pixelCount).toFixed(6),
      ),
    };
  }
  return {
    path: normalizedPath(pathname),
    format: metadata.format,
    width: metadata.width,
    height: metadata.height,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    rgbaPixelSha256: createHash("sha256").update(data).digest("hex"),
    hasAlpha: Boolean(metadata.hasAlpha),
    ...(alpha ? { alpha } : {}),
  };
}

for (const asset of configuration.assets) {
  const masterPath = projectPath(asset.masterPath);
  if (sourceDirectory) {
    const sourcePath = resolve(sourceDirectory, asset.sourceFile);
    await mkdir(dirname(masterPath), { recursive: true });
    const sourceMetadata = await describeImage(sourcePath);
    delete sourceMetadata.path;
    asset.sourceMetadata = sourceMetadata;
    await sharp(sourcePath)
      .webp({ lossless: true, exact: true, effort: 6 })
      .toFile(masterPath);
  }
  const master = await describeImage(masterPath);
  if (
    !asset.sourceMetadata ||
    master.rgbaPixelSha256 !== asset.sourceMetadata.rgbaPixelSha256 ||
    master.width !== asset.sourceMetadata.width ||
    master.height !== asset.sourceMetadata.height
  ) {
    throw new Error(
      `Lossless master pixel equality failed for ${asset.id}; ingest the original PNG with --source-dir to record its hash.`,
    );
  }
  if (master.hasAlpha !== asset.expectedAlpha) {
    throw new Error(
      `Unexpected alpha channel on ${asset.id}: expected ${asset.expectedAlpha}, received ${master.hasAlpha}`,
    );
  }
  const variants = [
    { variant: "standard", width: asset.width, path: asset.runtimePath },
  ];
  if (asset.mobileWidth) {
    variants.push({
      variant: "mobile",
      width: asset.mobileWidth,
      path: asset.runtimePath.replace(/\.webp$/, "-mobile.webp"),
    });
  }
  const outputs = [];
  for (const variant of variants) {
    const outputPath = projectPath(variant.path);
    await mkdir(dirname(outputPath), { recursive: true });
    const previousAsset = previousManifest?.assets.find(
      (entry) => entry.id === asset.id,
    );
    const previousOutput = previousAsset?.outputs.find(
      (entry) => entry.path === variant.path,
    );
    let output;
    if (
      previousAsset?.master.sha256 === master.sha256 &&
      previousOutput?.width === Math.min(master.width, variant.width) &&
      JSON.stringify(previousManifest.conversion) ===
        JSON.stringify(manifest.conversion)
    ) {
      try {
        const existing = await describeImage(outputPath);
        if (existing.sha256 === previousOutput.sha256) output = existing;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    if (!output) {
      await sharp(masterPath)
        .resize({ width: variant.width, withoutEnlargement: true })
        .webp({ quality: 82, alphaQuality: 100, effort: 6 })
        .toFile(outputPath);
      output = await describeImage(outputPath);
    }
    if (output.hasAlpha !== master.hasAlpha) {
      throw new Error(`Alpha preservation failed for ${variant.path}`);
    }
    outputs.push({ variant: variant.variant, ...output });
  }
  manifest.assets.push({
    id: asset.id,
    sourceFile: asset.sourceFile,
    sourceMetadata: asset.sourceMetadata,
    losslessPixelEquality: true,
    master,
    outputs,
  });
  console.log(
    `${asset.id}: ${master.width}×${master.height} lossless WebP master (${master.bytes} bytes), source RGBA equality verified → ${outputs.map((output) => `${output.variant} ${output.width}×${output.height} WebP (${output.bytes} bytes)`).join(", ")}`,
  );
}

for (const concept of configuration.concepts ?? []) {
  const outputPath = projectPath(concept.referencePath);
  await mkdir(dirname(outputPath), { recursive: true });
  if (sourceDirectory) {
    const sourcePath = resolve(sourceDirectory, concept.sourceFile);
    const sourceMetadata = await describeImage(sourcePath);
    delete sourceMetadata.path;
    concept.sourceMetadata = sourceMetadata;
    await sharp(sourcePath)
      .webp({ quality: 85, alphaQuality: 100, effort: 6 })
      .toFile(outputPath);
  }
  const output = await describeImage(outputPath);
  if (
    !concept.sourceMetadata ||
    output.width !== concept.sourceMetadata.width ||
    output.height !== concept.sourceMetadata.height
  ) {
    throw new Error(
      `Concept dimensions or source metadata are missing for ${concept.id}`,
    );
  }
  manifest.concepts.push({
    id: concept.id,
    sourceFile: concept.sourceFile,
    sourceMetadata: concept.sourceMetadata,
    quality: 85,
    operation:
      "Full dimensions retained; WebP encoding only. Concept reference is not a runtime scene asset.",
    output,
  });
  console.log(
    `${concept.id}: concept reference ${output.width}×${output.height} WebP (${output.bytes} bytes)`,
  );
}

manifest.totals = {
  masterBytes: manifest.assets.reduce(
    (sum, asset) => sum + asset.master.bytes,
    0,
  ),
  runtimeBytes: manifest.assets.reduce(
    (sum, asset) =>
      sum +
      asset.outputs.reduce((subtotal, output) => subtotal + output.bytes, 0),
    0,
  ),
  masterCount: manifest.assets.length,
  runtimeCount: manifest.assets.reduce(
    (sum, asset) => sum + asset.outputs.length,
    0,
  ),
  conceptCount: manifest.concepts.length,
  conceptBytes: manifest.concepts.reduce(
    (sum, concept) => sum + concept.output.bytes,
    0,
  ),
};
await writeFile(runtimeManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
if (sourceDirectory) {
  await writeFile(
    configurationPath,
    `${JSON.stringify(configuration, null, 2)}\n`,
  );
}
console.log(JSON.stringify(manifest.totals));
