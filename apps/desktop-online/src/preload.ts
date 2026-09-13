import { contextBridge, ipcRenderer } from "electron";

// Remote pages never receive this bridge; every IPC handler also validates the sender.
if (location.protocol === "file:" && location.pathname.endsWith("/connection.html")) {
  contextBridge.exposeInMainWorld("dearvaleConnection", {
    state: () => ipcRenderer.invoke("online:connection-state"),
    connect: (origin: string) => ipcRenderer.invoke("online:connect", origin),
  });
}
