import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { chooseMobileHost, createMobileGateway } from "./mobile-gateway.js";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function buildWeb(): Promise<void> {
  const executable = process.env.npm_execpath;
  if (!executable || !/pnpm\.(?:m?js|cjs)$/iu.test(executable)) {
    throw new Error("请在仓库根目录运行 pnpm mobile:serve。");
  }
  await new Promise<void>((resolveBuild, reject) => {
    const child = spawn(
      process.execPath,
      [executable, "--filter", "@personasim/web", "build"],
      { cwd: workspaceRoot, stdio: "inherit", windowsHide: true },
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolveBuild();
      else reject(new Error("手机前端构建失败，请先处理上方构建错误。"));
    });
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((argument) => argument !== "--"),
    options: {
      host: { type: "string" },
      port: { type: "string", default: "3000" },
      "skip-build": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(
      "pnpm mobile:serve [--host <本机私有IPv4>] [--port 3000] [--skip-build]\n" +
        "构建前端、启动回环后台及需密码的局域网入口；Ctrl+C 停止全部服务。\n" +
        "默认读取项目 .env，数据仍保存在电脑上。详见 docs/MOBILE-SERVER.md。",
    );
    return;
  }
  const host = chooseMobileHost(values.host);
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error("--port 必须是 1024 到 65535 之间的整数。");
  }
  console.log(
    "正在准备 Dearvale 手机连接。局域网 HTTP 不加密，仅用于可信家庭 Wi-Fi；公网请使用 HTTPS 自托管。",
  );
  if (!values["skip-build"]) await buildWeb();
  const webDistPath = join(workspaceRoot, "apps", "web", "dist");
  await access(join(webDistPath, "index.html"));

  // Delay importing the backend until the build has succeeded. Its existing
  // config loader reads .env without printing or serializing any credentials.
  const [{ buildApp }, { readConfig }] = await Promise.all([
    import("../apps/server/src/app.js"),
    import("../apps/server/src/config.js"),
  ]);
  const config = readConfig({
    host: "127.0.0.1",
    webOrigin: "http://127.0.0.1",
    selfHostedReverseProxy: false,
    nodeEnv: "production",
    developerRoutes: false,
    serveWeb: true,
    webDistPath,
  });
  const app = await buildApp({ config, startScheduler: true });
  const password = randomBytes(18).toString("base64url");
  let gateway: ReturnType<typeof createMobileGateway> | undefined;
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    if (gateway !== undefined) {
      gateway.closeAllConnections();
      await new Promise<void>((resolveClose) =>
        gateway?.close(() => resolveClose()),
      );
    }
    await app.close();
  };
  const stop = () => {
    void close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const backend = app.server.address();
    if (backend === null || typeof backend === "string") {
      throw new Error("后台未取得回环端口。");
    }
    gateway = createMobileGateway({
      host,
      backendPort: backend.port,
      password,
    });
    await new Promise<void>((resolveListen, reject) => {
      gateway?.once("error", reject);
      gateway?.listen(port, host, () => resolveListen());
    });
    console.log(
      `\nDearvale 手机连接已就绪\n\n` +
        `服务器地址：http://${host}:${port}\n` +
        `用户名：mobile\n` +
        `连接密码：${password}\n\n` +
        `在 APK 的连接设置输入以上三项。密码只在本次运行有效。\n` +
        `电脑和手机需连接同一可信 Wi-Fi，电脑应保持唤醒。\n` +
        `如有 Windows 防火墙提示，只允许“专用网络”。\n` +
        `按 Ctrl+C 停止服务，详见 docs/MOBILE-SERVER.md。\n`,
    );
  } catch (error) {
    await close();
    throw error;
  }
}

void main().catch((error: unknown) => {
  // Config validation errors can contain rejected environment values. Avoid
  // dumping errors/stacks and offer useful non-sensitive startup diagnostics.
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const message =
    code === "EADDRINUSE"
      ? "连接端口已被占用；请使用 --port 3002 或停止旧的 mobile:serve。"
      : code === "ENOENT"
        ? "缺少已构建的前端或运行依赖；请先 pnpm install，再运行 pnpm mobile:serve。"
        : error instanceof Error &&
            (/^--(?:host|port)/u.test(error.message) ||
              /^(未找到局域网|请在仓库|手机前端|后台未取得)/u.test(
                error.message,
              ))
          ? error.message
          : "启动失败，请检查 .env 配置和数据库权限。连接口令不会写入文件；现有数据不会被覆盖。";
  console.error(`Dearvale：${message}`);
  process.exitCode = 1;
});
