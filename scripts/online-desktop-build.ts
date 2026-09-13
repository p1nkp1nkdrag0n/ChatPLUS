import { build } from "esbuild";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(workspace, "apps/desktop-online");
const output = join(root, "dist");
const packageMetadata = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
) as { version: string };
await mkdir(output, { recursive: true });
for (const entry of ["main", "preload"]) {
  await build({
    absWorkingDir: workspace,
    entryPoints: [join(root, "src", `${entry}.ts`)],
    outfile: join(output, `${entry}.cjs`),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
    logLevel: "info",
  });
}
for (const entry of ["connection.html", "connection.js"])
  await cp(join(root, "src", entry), join(output, entry));
await writeFile(
  join(output, "build-info.json"),
  JSON.stringify(
    {
      version: packageMetadata.version,
      appId: "com.dearvale.online",
      builtAt: new Date().toISOString(),
      mode: "remote-only",
      serverBundled: false,
      mainSha256: createHash("sha256")
        .update(await readFile(join(output, "main.cjs")))
        .digest("hex"),
    },
    null,
    2,
  ),
);
console.log(`Dearvale Online client prepared: ${output}`);
