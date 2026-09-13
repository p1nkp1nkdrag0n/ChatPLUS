import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

// Format conversion only: preserve the original artwork and its alpha channel.
const directory = fileURLToPath(
  new URL("../../../desktop/build/", import.meta.url),
);
const sourcePath = join(directory, "icon-source.png");
const source = await readFile(sourcePath);
const metadata = await sharp(source).metadata();
if (
  !metadata.width ||
  metadata.width !== metadata.height ||
  metadata.width < 1024 ||
  !metadata.hasAlpha
) {
  throw new Error(
    "Desktop icon source must be a square PNG with alpha, at least 1024px.",
  );
}
await mkdir(directory, { recursive: true });
await sharp(source)
  .resize(1024, 1024)
  .png()
  .toFile(join(directory, "icon.png"));

// ICO stores an entry for each Windows shell size; PNG-encoded entries preserve
// antialiased transparent corners and work in all supported Windows releases.
const sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
const images = await Promise.all(
  sizes.map((size) => sharp(source).resize(size, size).png().toBuffer()),
);
const directoryBytes = 6 + 16 * sizes.length;
const header = Buffer.alloc(directoryBytes);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = directoryBytes;
images.forEach((bytes, index) => {
  const size = sizes[index]!;
  const entry = 6 + index * 16;
  header.writeUInt8(size === 256 ? 0 : size, entry);
  header.writeUInt8(size === 256 ? 0 : size, entry + 1);
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(bytes.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += bytes.length;
});
await writeFile(
  join(directory, "icon.ico"),
  Buffer.concat([header, ...images]),
);
console.log(`Dearvale PNG and Windows ICO generated (${sizes.join(", ")}px).`);
