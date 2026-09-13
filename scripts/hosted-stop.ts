import {
  requestHostedStop,
  resolveHostedRootDirectory,
} from "../apps/server/src/hosted/runtime-control.js";

try {
  if (process.argv.length > 2)
    throw new Error(
      "Usage: pnpm hosted:stop (select the instance with DEARVALE_HOSTED_ROOT or DEARVALE_HOSTED_CONFIG).",
    );
  const result = await requestHostedStop(resolveHostedRootDirectory());
  process.stdout.write(`Dearvale 已安全停止（PID ${result.pid}）。\n`);
} catch (error) {
  process.stderr.write(
    `无法安全停止 Dearvale：${error instanceof Error ? error.message : "停止请求失败。"}\n`,
  );
  process.exitCode = 1;
}
