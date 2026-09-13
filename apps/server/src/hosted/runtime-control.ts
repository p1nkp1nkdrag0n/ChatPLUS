import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { config as loadEnv } from "dotenv";

const MAX_CONTROL_BYTES = 1024;
const BOOT_ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
export interface HostedRuntimeIdentity {
  pid: number;
  bootId: string;
}

export function resolveHostedRootDirectory(): string {
  const configFile = process.env.DEARVALE_HOSTED_CONFIG;
  if (configFile) {
    if (!isAbsolute(configFile))
      throw new Error("DEARVALE_HOSTED_CONFIG must be an absolute file path.");
    if (loadEnv({ path: configFile, quiet: true }).error)
      throw new Error("Cannot read the hosted configuration file.");
  }
  return resolve(
    process.env.DEARVALE_HOSTED_ROOT ??
      join(process.env.APPDATA ?? homedir(), "DearvaleServer"),
  );
}
function rootPath(directory: string): string {
  const root = resolve(directory);
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Hosted control requires a regular local data directory.");
  return root;
}
function readRecord(path: string): Record<string, unknown> | undefined {
  const before = (() => {
    try {
      return lstatSync(path);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return undefined;
      throw error;
    }
  })();
  if (!before) return undefined;
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > MAX_CONTROL_BYTES
  )
    throw new Error("Invalid hosted runtime control file.");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > MAX_CONTROL_BYTES ||
      stat.ino !== before.ino ||
      stat.dev !== before.dev
    )
      throw new Error("Hosted runtime control file changed while reading.");
    const buffer = Buffer.alloc(MAX_CONTROL_BYTES + 1);
    const count = readSync(fd, buffer, 0, buffer.length, 0);
    if (count > MAX_CONTROL_BYTES)
      throw new Error("Hosted runtime control file is too large.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        buffer.subarray(0, count).toString("utf8"),
      ) as unknown;
    } catch {
      throw new Error("Invalid hosted runtime control JSON.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Invalid hosted runtime control record.");
    return parsed as Record<string, unknown>;
  } finally {
    closeSync(fd);
  }
}
function identity(
  record: Record<string, unknown> | undefined,
): HostedRuntimeIdentity | undefined {
  if (!record) return undefined;
  if (
    typeof record.pid !== "number" ||
    !Number.isSafeInteger(record.pid) ||
    record.pid < 1 ||
    typeof record.bootId !== "string" ||
    !BOOT_ID.test(record.bootId) ||
    Object.keys(record).some((key) => !["pid", "bootId"].includes(key))
  )
    throw new Error("Invalid hosted runtime identity.");
  return { pid: record.pid, bootId: record.bootId };
}
function requestBootId(
  record: Record<string, unknown> | undefined,
): string | undefined {
  if (!record) return undefined;
  if (
    typeof record.bootId !== "string" ||
    !BOOT_ID.test(record.bootId) ||
    Object.keys(record).some((key) => key !== "bootId")
  )
    throw new Error("Invalid hosted stop request.");
  return record.bootId;
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}
function removeOwned(path: string, bootId: string): void {
  try {
    if (readRecord(path)?.bootId === bootId) unlinkSync(path);
  } catch {
    /* Invalid or replaced records are not owned by this startup. */
  }
}

/** The control-store instance lock must already be held by this process. */
export function startHostedRuntimeControl(
  directory: string,
  onStop: () => Promise<void>,
): { identity: HostedRuntimeIdentity; dispose(): void } {
  const root = rootPath(directory);
  const controlPath = join(root, "runtime-control.json");
  const requestPath = join(root, "stop-request.json");
  const previous = identity(readRecord(controlPath));
  if (previous) {
    if (alive(previous.pid))
      throw new Error(
        "A live process already owns the hosted runtime control record.",
      );
    removeOwned(controlPath, previous.bootId);
  }
  const current = { pid: process.pid, bootId: randomUUID() };
  writeFileSync(controlPath, JSON.stringify(current), {
    flag: "wx",
    mode: 0o600,
  });
  let processing = false;
  const timer = setInterval(() => {
    if (processing) return;
    let requested: string | undefined;
    try {
      requested = requestBootId(readRecord(requestPath));
    } catch {
      return;
    }
    if (requested !== current.bootId) return;
    processing = true;
    void onStop().catch(() => {
      removeOwned(requestPath, current.bootId);
      processing = false;
      process.stderr.write(
        "Hosted graceful shutdown did not complete; the process was not forcibly terminated.\n",
      );
    });
  }, 500);
  timer.unref();
  let disposed = false;
  return {
    identity: current,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
      removeOwned(requestPath, current.bootId);
      removeOwned(controlPath, current.bootId);
    },
  };
}

/** Submit a local request and wait for graceful exit; never sends a kill signal. */
export async function requestHostedStop(
  directory: string,
  timeoutMs = 300000,
): Promise<{ pid: number }> {
  const root = rootPath(directory);
  const controlPath = join(root, "runtime-control.json");
  const requestPath = join(root, "stop-request.json");
  const current = identity(readRecord(controlPath));
  if (!current)
    throw new Error(
      "No hosted runtime control record exists. The server may be stopped or require the updated launcher.",
    );
  if (current.pid === process.pid || !alive(current.pid))
    throw new Error("The recorded hosted server process is not running.");
  const previous = requestBootId(readRecord(requestPath));
  if (previous && previous !== current.bootId)
    throw new Error(
      "A stale stop request belongs to another startup. Verify it before removing that request file.",
    );
  if (!previous) {
    const temporary = join(root, `.stop-request-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify({ bootId: current.bootId }), {
        flag: "wx",
        mode: 0o600,
      });
      const fresh = identity(readRecord(controlPath));
      if (fresh?.bootId !== current.bootId || fresh.pid !== current.pid)
        throw new Error(
          "The hosted server changed while preparing the stop request.",
        );
      const pending = requestBootId(readRecord(requestPath));
      if (pending && pending !== current.bootId)
        throw new Error("A conflicting stop request was created.");
      if (!pending) renameSync(temporary, requestPath);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const fresh = identity(readRecord(controlPath));
    if (!fresh && !alive(current.pid)) return { pid: current.pid };
    if (fresh && (fresh.bootId !== current.bootId || fresh.pid !== current.pid))
      throw new Error(
        "The hosted server restarted while waiting; no stop request was sent to the new startup.",
      );
    if (!alive(current.pid) && fresh)
      throw new Error(
        "The server exited without clearing its control record; review its shutdown log.",
      );
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    "Timed out waiting for graceful shutdown. No process was killed; inspect the server log and active requests.",
  );
}
