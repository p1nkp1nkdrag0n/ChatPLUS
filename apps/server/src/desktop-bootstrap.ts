import {
  readDesktopRuntimeOptions,
  startDesktopRuntime,
} from "./desktop-runtime.js";
import type { PersonaSimApp } from "./app.js";

// Do this before the runtime's dynamic imports, including in the bundled build.
process.env.PERSONASIM_LOAD_ENV = "false";

let app: PersonaSimApp | undefined;
let stopping = false;

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 10_000);
  deadline.unref();
  try {
    await startup;
    // End long-lived event streams before Fastify waits for open requests.
    app?.personasim.sse.close();
    await app?.close();
    process.exitCode = 0;
  } catch {
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    if (process.connected) process.disconnect();
  }
}

process.on("message", (message: unknown) => {
  if (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === "shutdown"
  ) {
    void shutdown();
  }
});
process.once("disconnect", () => void shutdown());
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

const startup = (async () => {
  if (!process.send || !process.connected) {
    throw new Error(
      "Desktop backend must be launched by the Dearvale desktop application.",
    );
  }
  const started = await startDesktopRuntime(readDesktopRuntimeOptions());
  app = started.app;
  if (!stopping && process.connected) {
    process.send({ type: "ready", url: started.url });
  }
})();

try {
  await startup;
} catch (error) {
  process.stderr.write(
    `Dearvale desktop backend failed: ${error instanceof Error ? error.message : "Unknown startup error"}\n`,
  );
  await app?.close();
  process.exitCode = 1;
  if (process.connected) process.disconnect();
}
