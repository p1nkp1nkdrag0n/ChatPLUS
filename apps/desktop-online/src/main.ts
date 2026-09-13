import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain, Menu, net, session, shell, type IpcMainInvokeEvent } from "electron";
import { isSameServer, normalizeServerOrigin } from "./address.js";

app.setName("Dearvale Online");
app.setPath("userData", join(app.getPath("appData"), "Dearvale Online"));
app.setAppUserModelId("com.dearvale.online");
const settingsFile = join(app.getPath("userData"), "connection.json");
const connectionFile = join(__dirname, "connection.html");
const connectionUrl = pathToFileURL(connectionFile).href;
let connectionWindow: BrowserWindow | undefined;
let remoteWindow: BrowserWindow | undefined;
let lastError = "";
let connecting = false;
let quitting = false;

function savedOrigin(): string {
  try { return normalizeServerOrigin((JSON.parse(readFileSync(settingsFile, "utf8")) as { origin: string }).origin); }
  catch { return ""; }
}
function trustedSender(event: IpcMainInvokeEvent): void {
  if (event.sender !== connectionWindow?.webContents || event.senderFrame?.url !== connectionUrl)
    throw new Error("Connection request rejected");
}
function showConnection(message = ""): void {
  lastError = message;
  if (connectionWindow && !connectionWindow.isDestroyed()) {
    void connectionWindow.reload(); connectionWindow.show(); connectionWindow.focus(); return;
  }
  connectionWindow = new BrowserWindow({
    title: "Dearvale Online · 连接服务", width: 620, height: 760, minWidth: 460, minHeight: 650,
    backgroundColor: "#faf8f3", autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, "preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
  });
  connectionWindow.on("closed", () => { connectionWindow = undefined; });
  connectionWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  connectionWindow.webContents.on("will-navigate", (event, url) => { if (url !== connectionUrl) event.preventDefault(); });
  void connectionWindow.loadFile(connectionFile);
}

async function connect(origin: string): Promise<void> {
  const health = await net.fetch(`${origin}/api/health`, { redirect: "error", signal: AbortSignal.timeout(12_000) });
  if (!health.ok) throw new Error("服务暂时不可用，请确认服务地址并重试。");
  const status = await health.json() as { ok?: boolean; status?: string };
  if (status.ok !== true && status.status !== "ok") throw new Error("这个地址没有返回 Dearvale 的健康状态。");
  const partition = `persist:dearvale-online-${createHash("sha256").update(origin).digest("hex").slice(0, 24)}`;
  const browserSession = session.fromPartition(partition);
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  browserSession.setPermissionCheckHandler(() => false);
  browserSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isSameServer(origin, details.url) && !details.url.startsWith("data:") && details.url !== "about:blank" });
  });
  browserSession.on("will-download", (event, item) => { if (!isSameServer(origin, item.getURL())) event.preventDefault(); });
  const window = new BrowserWindow({
    title: "Dearvale Online", width: 1380, height: 940, minWidth: 900, minHeight: 650,
    backgroundColor: "#faf8f3", show: false,
    webPreferences: { session: browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
  });
  const previous = remoteWindow;
  remoteWindow = window;
  window.on("closed", () => { if (remoteWindow === window) remoteWindow = undefined; });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  const external = (url: string) => {
    try { if (new URL(url).protocol === "https:") void shell.openExternal(url).catch(() => undefined); } catch { /* Invalid links are ignored. */ }
  };
  window.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: "deny" }; });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isSameServer(origin, url)) { event.preventDefault(); if (url === "dearvale://connection" || url === "dearvale-online://connection") showConnection(); else external(url); }
  });
  window.webContents.on("will-redirect", (event, url) => { if (!isSameServer(origin, url)) event.preventDefault(); });
  window.webContents.on("did-fail-load", (_event, code, _description, _url, mainFrame) => {
    if (mainFrame && code !== -3 && !quitting) showConnection("连接中断，请检查网络后重新连接。原账号数据保存在服务器中。");
  });
  try {
    await window.loadURL(`${origin}/`);
    mkdirSync(app.getPath("userData"), { recursive: true });
    writeFileSync(settingsFile, JSON.stringify({ origin }), { mode: 0o600 });
    window.show();
    previous?.close();
    connectionWindow?.close();
  } catch (error) { window.destroy(); remoteWindow = previous; throw error; }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { const window = connectionWindow ?? remoteWindow; if (window?.isMinimized()) window.restore(); window?.focus(); });
  app.on("before-quit", () => { quitting = true; });
  app.on("window-all-closed", () => app.quit());
  void app.whenReady().then(() => {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: "Dearvale Online", submenu: [
        { label: "连接设置", click: () => showConnection() },
        { label: "重新加载", accelerator: "CmdOrCtrl+R", click: () => remoteWindow?.reload() },
        { type: "separator" }, { role: "quit", label: "退出" },
      ] },
      { label: "编辑", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    ]));
    ipcMain.handle("online:connection-state", (event) => { trustedSender(event); return { origin: savedOrigin(), error: lastError }; });
    ipcMain.handle("online:connect", async (event, value: unknown) => {
      trustedSender(event);
      if (connecting) return { ok: false, error: "正在连接，请稍候。" };
      connecting = true;
      try {
        if (typeof value !== "string" || value.length > 2048) throw new Error("服务地址无效。");
        await connect(normalizeServerOrigin(value));
        return { ok: true };
      } catch { return { ok: false, error: "连接未成功。请确认 HTTPS 地址、服务器状态和网络后重试。" }; }
      finally { connecting = false; }
    });
    showConnection();
  });
}
