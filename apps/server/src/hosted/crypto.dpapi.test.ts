import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type * as NodeFs from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  encodeHostedMasterKey,
  HostedCrypto,
  readPortableHostedMasterKey,
} from "./crypto.js";

const mock = vi.hoisted(() => ({
  failure: "none",
  arguments: [] as string[][],
}));

vi.mock("node:child_process", () => ({
  execFileSync: (
    _command: string,
    args: string[],
    options: { input?: string; env?: Record<string, string> },
  ) => {
    mock.arguments.push(args);
    if (options.env?.DEARVALE_ACL_PATH) return Buffer.alloc(0);
    const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
    const protecting = script.includes("::Protect(");
    if (mock.failure === (protecting ? "protect" : "unprotect")) {
      throw Object.assign(new Error("mock DPAPI failure"), {
        stdout: Buffer.from("sensitive-child-output"),
      });
    }
    const bytes = Buffer.from(options.input!, "base64");
    const prefix = Buffer.from("fixture-dpapi:");
    const transform = (value: Buffer) =>
      Buffer.from(value.map((byte) => byte ^ 0xa5));
    const result = protecting
      ? Buffer.concat([prefix, transform(bytes)])
      : mock.failure === "roundtrip"
        ? Buffer.alloc(32)
        : transform(bytes.subarray(prefix.length));
    return Buffer.from(result.toString("base64"));
  },
}));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof NodeFs>();
  return {
    ...fs,
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      if (mock.failure === "rename")
        throw new Error("simulated replace failure");
      return fs.renameSync(...args);
    },
  };
});

const platformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "platform",
)!;
let root: string;
let keyPath: string;
beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "win32" });
  mock.failure = "none";
  mock.arguments = [];
  root = mkdtempSync(join(tmpdir(), "dearvale-dpapi-fixture-"));
  mkdirSync(join(root, ".secrets"));
  keyPath = join(root, ".secrets", "master.key");
});
afterEach(() => {
  Object.defineProperty(process, "platform", platformDescriptor);
  rmSync(root, { recursive: true, force: true });
});

describe("Windows master-key failure recovery", () => {
  it.each(["protect", "roundtrip", "rename"] as const)(
    "keeps the legacy key after %s failure and can retry",
    (failure) => {
      const original = randomBytes(32);
      writeFileSync(keyPath, original);
      mock.failure = failure;
      expect(() => new HostedCrypto(root)).toThrow();
      expect(readFileSync(keyPath).equals(original)).toBe(true);
      expect(readdirSync(join(root, ".secrets"))).toEqual(["master.key"]);
      mock.failure = "none";
      const crypto = new HostedCrypto(root);
      expect(readPortableHostedMasterKey(keyPath).equals(original)).toBe(true);
      const stored = readFileSync(keyPath);
      expect(stored.includes(original)).toBe(false);
      expect(stored.toString()).not.toContain(original.toString("base64"));
      expect(crypto.open(crypto.seal("preserved", "test"), "test")).toBe(
        "preserved",
      );
      expect(
        mock.arguments.every(
          (args) => !args.join(" ").includes(original.toString("base64")),
        ),
      ).toBe(true);
    },
  );

  it("fails closed for an unavailable Windows identity without replacing the envelope or attaching child output", () => {
    const crypto = new HostedCrypto(root);
    const original = readFileSync(keyPath);
    const existing = crypto.seal("existing", "test");
    mock.failure = "unprotect";
    let failure: unknown;
    try {
      new HostedCrypto(root);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "invalid_master_key" });
    expect(failure).not.toHaveProperty("cause");
    expect(JSON.stringify(failure)).not.toContain("sensitive-child-output");
    expect(readFileSync(keyPath).equals(original)).toBe(true);
    mock.failure = "none";
    expect(new HostedCrypto(root).open(existing, "test")).toBe("existing");
  });

  it("accepts portable key bytes on Linux and does not silently reinterpret a Windows envelope", () => {
    const portable = randomBytes(32);
    const windowsEnvelope = encodeHostedMasterKey(portable);
    Object.defineProperty(process, "platform", { value: "linux" });
    expect(encodeHostedMasterKey(portable).equals(portable)).toBe(true);
    writeFileSync(keyPath, portable);
    expect(readPortableHostedMasterKey(keyPath).equals(portable)).toBe(true);
    writeFileSync(keyPath, windowsEnvelope);
    expect(() => readPortableHostedMasterKey(keyPath)).toThrow();
    expect(readFileSync(keyPath).equals(windowsEnvelope)).toBe(true);
  });
});
