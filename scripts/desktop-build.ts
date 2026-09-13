import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "esbuild";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopRoot = join(workspaceRoot, "apps", "desktop");
const outputRoot = join(desktopRoot, "dist");
const deployRoot = join(outputRoot, "server-deploy");
const runtimeRoot = join(outputRoot, "runtime");
const serverRoot = join(runtimeRoot, "server");
const nodeRuntime = join(runtimeRoot, "node.exe");

function assertInsideOutput(path: string): void {
  const child = relative(outputRoot, resolve(path));
  if (child.startsWith(`..${sep}`) || child === ".." || isAbsolute(child)) {
    throw new Error(`Refusing to modify a path outside desktop/dist: ${path}`);
  }
}

async function cleanDirectory(path: string): Promise<void> {
  assertInsideOutput(path);
  await rm(path, { recursive: true, force: true });
}

async function run(
  executable: string,
  args: string[],
  cwd = workspaceRoot,
): Promise<void> {
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(executable, args, {
      cwd,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else
        reject(
          new Error(`${executable} exited with ${String(code ?? signal)}`),
        );
    });
  });
}

async function pnpm(args: string[]): Promise<void> {
  const executable = process.env.npm_execpath;
  if (!executable || !/pnpm\.(?:m?js|cjs)$/i.test(executable)) {
    throw new Error("Run this script with pnpm desktop:build.");
  }
  // Invoke the CLI through Node so Windows .cmd quoting never changes paths.
  await run(process.execPath, [executable, ...args]);
}

async function assertPortableDirectory(path: string): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(path, entry.name);
    if ((await lstat(entryPath)).isSymbolicLink()) {
      throw new Error(
        `Desktop dependencies must not contain links: ${entryPath}`,
      );
    }
    if (entry.isDirectory()) await assertPortableDirectory(entryPath);
  }
}

const externalDependencies: Plugin = {
  name: "external-runtime-dependencies",
  setup(bundle) {
    bundle.onResolve({ filter: /^[^./]|^\.[^./]|^\.\.[^/]/ }, (args) => {
      if (args.kind === "entry-point" || isAbsolute(args.path)) return;
      if (args.path.startsWith("@personasim/")) return;
      return { path: args.path, external: true };
    });
  },
};

async function main(): Promise<void> {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error(
      "The desktop installer currently targets Windows x64. Build on Windows x64 so Node and native dependencies match the installer.",
    );
  }
  const [nodeMajor = 0, nodeMinor = 0] = process.versions.node
    .split(".")
    .map(Number);
  if (
    nodeMajor < 22 ||
    (nodeMajor === 22 && nodeMinor < 12) ||
    nodeMajor >= 25
  ) {
    throw new Error(
      "Desktop builds require Node.js 22.12 through 24, matching Electron and the workspace engines.",
    );
  }

  // Electron 44 downloads its binary on first require, not during pnpm install.
  // Ensure electron-builder's explicit electronDist exists on a fresh checkout.
  await run(process.execPath, ["-e", "require('electron')"]);
  await pnpm(["--filter", "@personasim/web", "build"]);
  await cleanDirectory(outputRoot);
  await mkdir(serverRoot, { recursive: true });

  // Use the modern frozen-lockfile deploy, scoped injection, and a hoisted tree.
  // Legacy deploy re-resolves versions; isolated node_modules uses Windows
  // junctions that can still point at the build machine after resources are copied.
  await pnpm([
    "--filter",
    "@personasim/server",
    "--config.node-linker=hoisted",
    "--config.inject-workspace-packages=true",
    "deploy",
    "--prod",
    deployRoot,
  ]);
  await assertPortableDirectory(join(deployRoot, "node_modules"));
  await cp(join(deployRoot, "node_modules"), join(serverRoot, "node_modules"), {
    recursive: true,
    filter: (source) => {
      const path = relative(join(deployRoot, "node_modules"), source);
      const topLevel = path.split(sep)[0] ?? "";
      // pnpm metadata and command wrappers include build-machine absolute paths.
      return !topLevel.startsWith(".") && topLevel !== "@personasim";
    },
  });
  await writeFile(
    join(serverRoot, "package.json"),
    `${JSON.stringify({ name: "dearvale-local-server", private: true, type: "module" }, null, 2)}\n`,
  );
  await cp(
    join(workspaceRoot, "apps", "server", "src", "db", "migrations"),
    join(serverRoot, "migrations"),
    { recursive: true },
  );
  await cp(
    join(workspaceRoot, "apps", "web", "dist"),
    join(runtimeRoot, "web"),
    { recursive: true },
  );
  await cp(
    join(desktopRoot, "build", "icon.png"),
    join(runtimeRoot, "icon.png"),
  );
  await cp(process.execPath, nodeRuntime);

  const licenseUrl = `https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`;
  const license = await fetch(licenseUrl, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!license.ok)
    throw new Error(
      `Unable to include the bundled Node license: ${license.status}`,
    );
  await writeFile(join(runtimeRoot, "NODE-LICENSE.txt"), await license.text());
  await writeFile(
    join(runtimeRoot, "build-info.json"),
    `${JSON.stringify(
      {
        platform: process.platform,
        arch: process.arch,
        node: process.versions.node,
        lockfileSha256: createHash("sha256")
          .update(await readFile(join(workspaceRoot, "pnpm-lock.yaml")))
          .digest("hex"),
      },
      null,
      2,
    )}\n`,
  );

  await build({
    absWorkingDir: workspaceRoot,
    entryPoints: ["apps/server/src/desktop-bootstrap.ts"],
    outfile: join(serverRoot, "desktop-bootstrap.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: `node${nodeMajor}`,
    plugins: [externalDependencies],
    logLevel: "info",
  });
  await build({
    absWorkingDir: workspaceRoot,
    entryPoints: ["apps/desktop/src/main.ts"],
    outfile: join(outputRoot, "main.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
    logLevel: "info",
  });

  await run(
    nodeRuntime,
    [
      "--input-type=module",
      "-e",
      `
    import Database from "better-sqlite3";
    import sharp from "sharp";
    const db = new Database(":memory:");
    db.exec("CREATE TABLE desktop_probe (value INTEGER)");
    db.close();
    await sharp({ create: { width: 1, height: 1, channels: 4, background: "white" } }).png().toBuffer();
    console.log("Bundled Node, SQLite, and image runtime verified.");
  `,
    ],
    serverRoot,
  );
  await cleanDirectory(deployRoot);
  console.log(`Desktop application prepared at ${outputRoot}`);
}

await main();
