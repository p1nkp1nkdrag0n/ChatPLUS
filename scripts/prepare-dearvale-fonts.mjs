import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Reproducible, local font assets. The deployed site never calls Google Fonts.
const directory = fileURLToPath(
  new URL("../apps/web/public/dearvale/fonts/", import.meta.url),
);
await mkdir(directory, { recursive: true });
const userAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";
async function get(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": userAgent },
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  return response;
}
const families = [
  {
    name: "noto-serif-sc",
    query: "Noto+Serif+SC:wght@400;500;600",
    license: "notoserifsc",
  },
  {
    name: "cormorant-garamond",
    query: "Cormorant+Garamond:wght@400;500;600",
    license: "cormorantgaramond",
  },
];
let css = "/* Self-hosted fonts. See the adjacent OFL license files. */\n";
for (const family of families) {
  let source = await (
    await get(
      `https://fonts.googleapis.com/css2?family=${family.query}&display=swap`,
    )
  ).text();
  const urls = [
    ...new Set(
      [...source.matchAll(/url\((https:\/\/[^)]+)\)/g)].map(
        (match) => match[1],
      ),
    ),
  ];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (cursor < urls.length) {
        const index = cursor++;
        const url = urls[index];
        const name = `${family.name}-${String(index).padStart(3, "0")}.woff2`;
        await writeFile(
          path.join(directory, name),
          Buffer.from(await (await get(url)).arrayBuffer()),
        );
      }
    }),
  );
  urls.forEach((url, index) => {
    source = source.replaceAll(
      url,
      `/dearvale/fonts/${family.name}-${String(index).padStart(3, "0")}.woff2`,
    );
  });
  css += source + "\n";
  await writeFile(
    path.join(directory, `${family.name}-OFL.txt`),
    await (
      await get(
        `https://raw.githubusercontent.com/google/fonts/main/ofl/${family.license}/OFL.txt`,
      )
    ).text(),
  );
  process.stdout.write(`${family.name}: ${urls.length} local font subsets\n`);
}
await writeFile(path.join(directory, "fonts.css"), css);
