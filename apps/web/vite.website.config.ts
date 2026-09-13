import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const appRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, appRoot, "VITE_");
  const appUrl = env["VITE_APP_URL"]?.trim();
  if (command === "build" && !appUrl) {
    throw new Error(
      "Set VITE_APP_URL to the deployed application's /welcome URL before building the website.",
    );
  }
  if (appUrl && !/^https?:\/\//i.test(appUrl)) {
    throw new Error(
      "VITE_APP_URL must be an absolute http:// or https:// application URL.",
    );
  }
  return {
    root: fileURLToPath(new URL("./website", import.meta.url)),
    envDir: appRoot,
    cacheDir: fileURLToPath(
      new URL("./node_modules/.vite-website", import.meta.url),
    ),
    publicDir: fileURLToPath(new URL("./public", import.meta.url)),
    plugins: [react()],
    server: { port: 5174, strictPort: true },
    build: {
      outDir: fileURLToPath(new URL("./dist-website", import.meta.url)),
      emptyOutDir: true,
    },
  };
});
