import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveHostedRootDirectory,
  startHostedRuntimeControl,
} from "./runtime-control.js";

// The hosted instance never reads the development checkout's private .env.
process.env.PERSONASIM_LOAD_ENV = "false";
const workspace = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const rootDirectory = resolveHostedRootDirectory();
const port = (key: string, fallback: number) => {
  const value = Number(process.env[key] ?? fallback);
  if (!Number.isInteger(value) || value < 1024 || value > 65535)
    throw new Error(`${key} must be a port between 1024 and 65535.`);
  return value;
};
const publicPort = port("DEARVALE_HOSTED_PORT", 3001);
const adminPort = port("DEARVALE_ADMIN_PORT", 3002);
if (publicPort === adminPort)
  throw new Error("User and administrator ports must be different.");
const publicOrigin =
  process.env.DEARVALE_PUBLIC_ORIGIN ?? `http://127.0.0.1:${publicPort}`;
const adminOrigin = `http://127.0.0.1:${adminPort}`;
const webDistPath = resolve(
  process.env.DEARVALE_WEB_DIST ?? join(workspace, "apps/web/dist"),
);
if (!existsSync(join(webDistPath, "index.html")))
  throw new Error("Build the web application first with pnpm hosted:serve.");
const { readConfig } = await import("../config.js");
const { buildHostedApps } = await import("./app.js");
process.env.CORRESPONDENCE_MODE ??= "enforced";
const baseConfig = readConfig({
  nodeEnv: "production",
  profile: "hosted",
  host: "127.0.0.1",
  port: publicPort,
  // The reused business configuration retains the standalone loopback boundary.
  // The authenticated hosted HTTP surfaces validate publicOrigin separately.
  webOrigin: `http://127.0.0.1:${publicPort}`,
  developerRoutes: false,
  clockMode: "system",
  selfHostedReverseProxy: false,
  databasePath: join(rootDirectory, "unused.sqlite"),
  instanceSecret: randomBytes(32).toString("base64"),
  llm: {
    provider: "fixture",
    baseUrl: "https://hosted.invalid",
    model: "unconfigured",
    timeoutMs: 120000,
    maxRetries: 0,
    maxOutputTokens: 8192,
  },
});
const hosted = await buildHostedApps({
  rootDirectory,
  publicOrigin,
  adminOrigin,
  baseConfig,
  webDistPath,
  allowLocalHttp: publicOrigin === `http://127.0.0.1:${publicPort}`,
});
let control: ReturnType<typeof startHostedRuntimeControl> | undefined;
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  try {
    await hosted.prepareShutdown();
    await hosted.close();
    control?.dispose();
    process.exit(0);
  } catch (error) {
    stopping = false;
    throw error;
  }
};
try {
  await hosted.userApp.listen({ host: "127.0.0.1", port: publicPort });
  await hosted.adminApp.listen({ host: "127.0.0.1", port: adminPort });
  control = startHostedRuntimeControl(rootDirectory, stop);
  process.stdout.write(
    `Dearvale 服务已启动\n用户入口：${publicOrigin}\n本机管理：${adminOrigin}/admin\n数据目录：${rootDirectory}\n仅将用户端口 ${publicPort} 接入 HTTPS 穿透，保留原 Host。\n`,
  );
} catch (error) {
  await hosted.close();
  control?.dispose();
  throw error;
}
const signalStop = () => {
  void stop().catch(() => {
    process.stderr.write(
      "Hosted graceful shutdown failed; review active work before retrying.\n",
    );
  });
};
process.on("SIGINT", signalStop);
process.on("SIGTERM", signalStop);
