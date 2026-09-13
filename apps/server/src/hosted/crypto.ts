import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { HostedError } from "./types.js";

interface Envelope {
  v: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

const DPAPI_MASTER_FORMAT = "dearvale-master-key-dpapi-v1";

function masterKeyError(): HostedError {
  return new HostedError(
    500,
    "invalid_master_key",
    "The encryption key is damaged or unavailable to this Windows account. Restore the portable key backup using its passphrase.",
  );
}

function windowsProtect(
  bytes: Buffer,
  action: "Protect" | "Unprotect",
): Buffer {
  // The script and command line contain no secret. Only anonymous pipes carry
  // the input/output bytes. Do not retain child-process errors: their stdout
  // could include an unprotected key if the child failed after writing it.
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $entropy=[Text.Encoding]::UTF8.GetBytes('dearvale:master-key:dpapi:v1'); $result=[Security.Cryptography.ProtectedData]::${action}($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))`;
  try {
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        input: bytes.toString("base64"),
        windowsHide: true,
        stdio: "pipe",
        timeout: 15000,
        maxBuffer: 64 * 1024,
      },
    )
      .toString("utf8")
      .trim();
    if (!output || !/^[A-Za-z0-9+/]+={0,2}$/u.test(output))
      throw masterKeyError();
    const decoded = Buffer.from(output, "base64");
    if (decoded.toString("base64") !== output) throw masterKeyError();
    return decoded;
  } catch {
    throw masterKeyError();
  }
}

/** Portable bytes are for in-memory password-encrypted backups only. */
export function readPortableHostedMasterKey(path: string): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024)
    throw masterKeyError();
  const stored = readFileSync(path);
  if (stored.length === 32) return stored;
  try {
    const envelope = JSON.parse(stored.toString("utf8")) as {
      format?: unknown;
      data?: unknown;
    };
    if (
      process.platform !== "win32" ||
      envelope.format !== DPAPI_MASTER_FORMAT ||
      typeof envelope.data !== "string"
    )
      throw masterKeyError();
    const protectedBytes = Buffer.from(envelope.data, "base64");
    if (
      !protectedBytes.length ||
      protectedBytes.toString("base64") !== envelope.data
    )
      throw masterKeyError();
    const key = windowsProtect(protectedBytes, "Unprotect");
    if (key.length !== 32) {
      key.fill(0);
      throw masterKeyError();
    }
    return key;
  } catch {
    throw masterKeyError();
  }
}

/** Protects a portable backup key for the current host before writing it. */
export function encodeHostedMasterKey(key: Buffer): Buffer {
  if (key.length !== 32) throw masterKeyError();
  if (process.platform !== "win32") return Buffer.from(key);
  const protectedBytes = windowsProtect(key, "Protect");
  const recovered = windowsProtect(protectedBytes, "Unprotect");
  try {
    if (!recovered.equals(key)) throw masterKeyError();
    return Buffer.from(
      JSON.stringify({
        format: DPAPI_MASTER_FORMAT,
        data: protectedBytes.toString("base64"),
      }),
    );
  } finally {
    recovered.fill(0);
  }
}

function migrateWindowsMasterKey(path: string, key: Buffer): void {
  const protectedBytes = encodeHostedMasterKey(key);
  const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  let created = false;
  try {
    const descriptor = openSync(temporary, "wx", 0o600);
    created = true;
    try {
      writeFileSync(descriptor, protectedBytes);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    protectWindowsPath(temporary, false);
    // Never remove the original first and never make a plaintext backup copy.
    // A failed replace leaves the old readable key at its original path.
    renameSync(temporary, path);
    created = false;
  } catch {
    throw new HostedError(
      500,
      "master_key_protection_failed",
      "Cannot protect the existing encryption key. The original key has been retained; fix storage access and retry.",
    );
  } finally {
    if (created) rmSync(temporary, { force: true });
  }
}

function protectWindowsPath(path: string, directory: boolean): void {
  // Paths travel through a child-only environment variable, never shell interpolation.
  // Replacing the DACL also removes pre-existing explicit Everyone/Users grants.
  const script = `$ErrorActionPreference='Stop'; $path=$env:DEARVALE_ACL_PATH; $acl=if($env:DEARVALE_ACL_DIRECTORY -eq '1'){[System.IO.Directory]::GetAccessControl($path)}else{[System.IO.File]::GetAccessControl($path)}; $acl.SetAccessRuleProtection($true,$false); foreach($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }; $current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $system=[System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'); $inherit=if($env:DEARVALE_ACL_DIRECTORY -eq '1'){[System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit}else{[System.Security.AccessControl.InheritanceFlags]::None}; foreach($identity in @($current,$system)){ $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($identity,[System.Security.AccessControl.FileSystemRights]::FullControl,$inherit,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow); $acl.AddAccessRule($rule) }; if($env:DEARVALE_ACL_DIRECTORY -eq '1'){[System.IO.Directory]::SetAccessControl($path,$acl)}else{[System.IO.File]::SetAccessControl($path,$acl)}`;
  try {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        windowsHide: true,
        stdio: "pipe",
        env: {
          ...process.env,
          DEARVALE_ACL_PATH: path,
          DEARVALE_ACL_DIRECTORY: directory ? "1" : "0",
        },
      },
    );
  } catch (error) {
    const failure = new HostedError(
      500,
      "storage_permissions_failed",
      "Cannot protect hosted storage permissions.",
    );
    failure.cause = error;
    throw failure;
  }
}

export function protectDirectory(directory: string): void {
  const path = resolve(directory);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())
    throw new HostedError(
      500,
      "unsafe_storage_path",
      "Storage must be a regular directory.",
    );
  if (process.platform === "win32") {
    protectWindowsPath(path, true);
  } else chmodSync(path, 0o700);
}

function encryptBytes(key: Buffer, bytes: Buffer, aad: string): Envelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}
function decryptBytes(key: Buffer, envelope: Envelope, aad: string): Buffer {
  if (envelope.v !== 1) throw new Error("Unsupported encryption version");
  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  if (iv.length !== 12 || tag.length !== 16)
    throw new Error("Invalid envelope");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);
}

export class HostedCrypto {
  readonly keyPath: string;
  private readonly key: Buffer;
  constructor(rootDirectory: string) {
    protectDirectory(rootDirectory);
    const secretDirectory = join(resolve(rootDirectory), ".secrets");
    protectDirectory(secretDirectory);
    this.keyPath = join(secretDirectory, "master.key");
    if (!existsSync(this.keyPath)) {
      const freshKey = randomBytes(32);
      try {
        writeFileSync(this.keyPath, encodeHostedMasterKey(freshKey), {
          flag: "wx",
          mode: 0o600,
          flush: true,
        });
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "EEXIST"
        ))
          throw error;
      } finally {
        freshKey.fill(0);
      }
    }
    const stat = lstatSync(this.keyPath);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new HostedError(
        500,
        "invalid_master_key",
        "The encryption key is not a regular file.",
      );
    if (process.platform === "win32") protectWindowsPath(this.keyPath, false);
    this.key = readPortableHostedMasterKey(this.keyPath);
    if (process.platform === "win32" && stat.size === 32)
      migrateWindowsMasterKey(this.keyPath, this.key);
    if (process.platform !== "win32") chmodSync(this.keyPath, 0o600);
  }
  seal(value: unknown, purpose: string): string {
    return JSON.stringify(
      encryptBytes(
        this.key,
        Buffer.from(JSON.stringify(value)),
        `dearvale:${purpose}:v1`,
      ),
    );
  }
  fingerprint(value: unknown, purpose: string): string {
    return createHmac("sha256", this.key)
      .update(`dearvale:${purpose}:v1\0`)
      .update(JSON.stringify(value) ?? "null")
      .digest("hex");
  }
  open<T = unknown>(envelope: string, purpose: string): T {
    try {
      return JSON.parse(
        decryptBytes(
          this.key,
          JSON.parse(envelope) as Envelope,
          `dearvale:${purpose}:v1`,
        ).toString("utf8"),
      ) as T;
    } catch {
      throw new HostedError(
        500,
        "encrypted_record_unreadable",
        "Encrypted data could not be authenticated.",
      );
    }
  }
}

export function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
export function randomOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function encryptBackup(bytes: Buffer, passphrase: string): Buffer {
  if (passphrase.length < 12)
    throw new HostedError(
      400,
      "weak_backup_passphrase",
      "Backup passphrase must contain at least 12 characters.",
    );
  const salt = randomBytes(16);
  const key = scryptSync(passphrase, salt, 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return Buffer.from(
    JSON.stringify({
      format: "dearvale-hosted-backup-v1",
      salt: salt.toString("base64"),
      ...encryptBytes(key, bytes, "dearvale:backup:v1"),
    }),
  );
}
export function decryptBackup(bytes: Buffer, passphrase: string): Buffer {
  try {
    const value = JSON.parse(bytes.toString("utf8")) as Envelope & {
      format: string;
      salt: string;
    };
    if (value.format !== "dearvale-hosted-backup-v1")
      throw new Error("Invalid backup");
    const salt = Buffer.from(value.salt, "base64");
    if (salt.length !== 16) throw new Error("Invalid salt");
    const key = scryptSync(passphrase, salt, 32, {
      N: 32768,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    });
    return decryptBytes(key, value, "dearvale:backup:v1");
  } catch {
    throw new HostedError(
      400,
      "backup_decryption_failed",
      "Backup passphrase is incorrect or the backup is damaged.",
    );
  }
}
