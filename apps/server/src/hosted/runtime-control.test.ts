import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  requestHostedStop,
  startHostedRuntimeControl,
} from "./runtime-control.js";

it("refuses to stop the requesting process and never removes another startup's control record", async () => {
  const root = mkdtempSync(join(tmpdir(), "dearvale-runtime-control-"));
  const control = startHostedRuntimeControl(root, () => Promise.resolve());
  try {
    await expect(requestHostedStop(root, 100)).rejects.toThrow("not running");
    expect(existsSync(join(root, "stop-request.json"))).toBe(false);
    const replacement = { pid: process.pid, bootId: randomUUID() };
    writeFileSync(
      join(root, "runtime-control.json"),
      JSON.stringify(replacement),
    );
    writeFileSync(
      join(root, "stop-request.json"),
      JSON.stringify({ bootId: replacement.bootId }),
    );
    control.dispose();
    expect(
      JSON.parse(readFileSync(join(root, "runtime-control.json"), "utf8")),
    ).toEqual(replacement);
    expect(existsSync(join(root, "stop-request.json"))).toBe(true);
  } finally {
    control.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

it("ignores a linked stop-request path instead of reading through it", async () => {
  vi.useFakeTimers();
  const root = mkdtempSync(join(tmpdir(), "dearvale-runtime-link-"));
  const onStop = vi.fn(() => Promise.resolve());
  const control = startHostedRuntimeControl(root, onStop);
  try {
    const target = join(root, "linked-directory");
    mkdirSync(target);
    symlinkSync(
      target,
      join(root, "stop-request.json"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(onStop).not.toHaveBeenCalled();
    expect(existsSync(join(root, "runtime-control.json"))).toBe(true);
  } finally {
    control.dispose();
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  }
});
