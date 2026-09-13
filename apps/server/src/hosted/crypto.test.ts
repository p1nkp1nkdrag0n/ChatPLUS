import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  decryptBackup,
  encryptBackup,
  HostedCrypto,
  readPortableHostedMasterKey,
} from "./crypto.js";
it("authenticates purpose, content and backup passphrases", () => {
  const root = mkdtempSync(join(tmpdir(), "dearvale-crypto-"));
  try {
    const crypto = new HostedCrypto(root);
    const cipher = crypto.seal({ text: "secret-value" }, "record1");
    expect(cipher).not.toContain("secret-value");
    expect(crypto.open(cipher, "record1")).toEqual({ text: "secret-value" });
    expect(() => crypto.open(cipher, "record2")).toThrow("authenticated");
    const corrupt = JSON.parse(cipher) as { ciphertext: string };
    corrupt.ciphertext = Buffer.from("tampered").toString("base64");
    expect(() => crypto.open(JSON.stringify(corrupt), "record1")).toThrow(
      "authenticated",
    );
    const backup = encryptBackup(
      Buffer.from("backup-secret"),
      "a-strong-backup-password",
    );
    expect(backup.toString()).not.toContain("backup-secret");
    expect(decryptBackup(backup, "a-strong-backup-password").toString()).toBe(
      "backup-secret",
    );
    expect(() => decryptBackup(backup, "incorrect-password")).toThrow(
      "incorrect",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("reads legacy records after protecting an existing key and keeps fingerprints stable", () => {
  const root = mkdtempSync(join(tmpdir(), "dearvale-legacy-key-"));
  const key = randomBytes(32);
  const secretDirectory = join(root, ".secrets");
  const keyPath = join(secretDirectory, "master.key");
  mkdirSync(secretDirectory);
  writeFileSync(keyPath, key);
  const payload = { text: "legacy-private-record" };
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("dearvale:legacy:v1"));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload)),
    cipher.final(),
  ]);
  const envelope = JSON.stringify({
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: encrypted.toString("base64"),
  });
  const fingerprint = createHmac("sha256", key)
    .update("dearvale:dedup:v1\0")
    .update(JSON.stringify(payload))
    .digest("hex");
  try {
    const crypto = new HostedCrypto(root);
    expect(crypto.open(envelope, "legacy")).toEqual(payload);
    expect(crypto.fingerprint(payload, "dedup")).toBe(fingerprint);
    expect(readPortableHostedMasterKey(keyPath).equals(key)).toBe(true);
    const stored = readFileSync(keyPath);
    if (process.platform === "win32") {
      expect(JSON.parse(stored.toString())).toMatchObject({
        format: "dearvale-master-key-dpapi-v1",
      });
      expect(stored.includes(key)).toBe(false);
      expect(stored.toString()).not.toContain(key.toString("base64"));
    } else expect(stored.equals(key)).toBe(true);
    expect(readdirSync(secretDirectory)).toEqual(["master.key"]);
    expect(new HostedCrypto(root).open(envelope, "legacy")).toEqual(payload);
  } finally {
    key.fill(0);
    rmSync(root, { recursive: true, force: true });
  }
});
