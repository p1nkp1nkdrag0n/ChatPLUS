import { fork, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  net,
  protocol,
  session,
  shell,
} from "electron";
import {
  APP_URL,
  isAppUrl,
  isExternalUrl,
  readReadyUrl,
  serverEnvironment,
} from "./runtime";

app.setName("Dearvale");
// A stable origin preserves browser drafts and conversation pointers even when
// the operating system assigns the backend a different port on the next launch.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "dearvale",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

const dataOverride = process.env["DEARVALE_DESKTOP_DATA_DIR"];
if (dataOverride && !isAbsolute(dataOverride))
  throw new Error("DEARVALE_DESKTOP_DATA_DIR must be absolute");
app.setPath(
  "userData",
  dataOverride ?? join(app.getPath("appData"), "Dearvale"),
);
app.setAppUserModelId("com.dearvale.desktop");

let mainWindow: BrowserWindow | undefined;
let backend: ChildProcess | undefined;
let quitting = false;
let shutdownFinished = false;
let backendOrigin: string | undefined;
const token = randomBytes(32).toString("hex");
const runtimeDirectory = app.isPackaged
  ? join(process.resourcesPath, "runtime")
  : join(__dirname, "runtime");
const dataDirectory = join(app.getPath("userData"), "data");

function showFailure(error: unknown) {
  if (quitting) return;
  dialog.showErrorBox(
    "Dearvale 暂时无法启动",
    `${error instanceof Error ? error.message : String(error)}\n\n运行日志保存在：${join(app.getPath("userData"), "logs", "server.log")}`,
  );
  app.quit();
}

function startBackend(): Promise<string> {
  const logDirectory = join(app.getPath("userData"), "logs");
  mkdirSync(dataDirectory, { recursive: true });
  mkdirSync(logDirectory, { recursive: true });
  const log = createWriteStream(join(logDirectory, "server.log"), {
    flags: "a",
  });
  log.on("error", () => {
    /* A log write error must not crash a working instance. */
  });
  const child = fork(
    join(runtimeDirectory, "server", "desktop-bootstrap.mjs"),
    [],
    {
      execPath: join(
        runtimeDirectory,
        process.platform === "win32" ? "node.exe" : "node",
      ),
      execArgv: [],
      cwd: dataDirectory,
      env: serverEnvironment(
        process.env,
        runtimeDirectory,
        dataDirectory,
        token,
      ),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      // fork forwards spawn options; Node's ForkOptions typings omit windowsHide.
      ...{ windowsHide: true },
    },
  );
  backend = child;
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  return new Promise((resolve, reject) => {
    let ready = false;
    const timeout = setTimeout(
      () => reject(new Error("本地服务启动超时，请查看运行日志后重试。")),
      60_000,
    );
    child.once("error", (error) => {
      clearTimeout(timeout);
      if (ready) showFailure(error);
      else reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      log.end();
      const error = new Error(`本地服务已退出（${String(code)}）。`);
      if (!ready) reject(error);
      else if (!quitting) showFailure(error);
    });
    child.on("message", (message: unknown) => {
      const url = readReadyUrl(message);
      if (!ready && url) {
        ready = true;
        clearTimeout(timeout);
        resolve(url);
      }
    });
  });
}

async function stopBackend() {
  const child = backend;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill();
      resolve();
    }, 8_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    if (child.connected)
      child.send({ type: "shutdown" }, (error) => {
        if (error) child.kill();
      });
    else child.kill();
  });
}

function openExternal(url: string) {
  if (isExternalUrl(url)) void shell.openExternal(url).catch(() => undefined);
}

async function openWindow() {
  const desktopSession = session.fromPartition("persist:dearvale");
  const window = new BrowserWindow({
    title: "Dearvale",
    icon: join(runtimeDirectory, "icon.png"),
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 740,
    backgroundColor: "#fbfaf6",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      session: desktopSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  mainWindow = window;
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = undefined;
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url)) {
      event.preventDefault();
      openExternal(url);
    }
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  await window.loadURL(APP_URL);
}

async function start() {
  await app.whenReady();
  Menu.setApplicationMenu(null);
  backendOrigin = await startBackend();
  const desktopSession = session.fromPartition("persist:dearvale");
  desktopSession.setPermissionRequestHandler(
    (contents, permission, callback, details) =>
      callback(
        permission === "clipboard-sanitized-write" &&
          contents === mainWindow?.webContents &&
          isAppUrl(contents.getURL()) &&
          isAppUrl(details.requestingUrl),
      ),
  );
  desktopSession.setPermissionCheckHandler(
    (contents, permission, origin) =>
      permission === "clipboard-sanitized-write" &&
      contents === mainWindow?.webContents &&
      isAppUrl(origin),
  );
  desktopSession.protocol.handle("dearvale", async (request) => {
    if (!isAppUrl(request.url) || !backendOrigin)
      return new Response("Not found", { status: 404 });
    const source = new URL(request.url);
    // Set pathname separately: a leading // must never redirect proxy requests
    // (and their private token) to another host.
    const target = new URL(backendOrigin);
    target.pathname = source.pathname;
    target.search = source.search;
    const headers = new Headers(request.headers);
    for (const name of [...headers.keys()]) {
      if (
        name.startsWith("sec-fetch-") ||
        ["host", "origin", "referer"].includes(name)
      )
        headers.delete(name);
    }
    headers.set("origin", backendOrigin);
    headers.set("x-dearvale-desktop-token", token);
    const response = await net.fetch(target.href, {
      method: request.method,
      headers,
      ...(request.method === "GET" || request.method === "HEAD"
        ? {}
        : { body: await request.arrayBuffer() }),
      redirect: "manual",
      signal: request.signal,
    });
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    );
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  });
  await openWindow();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.show();
    mainWindow?.focus();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("activate", () => {
    if (!quitting && backendOrigin && !mainWindow)
      void openWindow().catch(showFailure);
  });
  app.on("before-quit", (event) => {
    if (shutdownFinished) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    // Destroy the renderer first so active SSE streams cannot delay app.close().
    mainWindow?.destroy();
    void stopBackend().finally(() => {
      shutdownFinished = true;
      app.quit();
    });
  });
  void start().catch(showFailure);
}
