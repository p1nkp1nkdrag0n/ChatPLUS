import {
  appendFileSync,
  existsSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { protectDirectory } from "./crypto.js";

const MAX_FILE_BYTES = 1024 * 1024;
const RETAINED_FILES = 4;
export interface SecurityAuditEvent {
  surface: "user" | "admin";
  method: string;
  route: string;
  status: number;
  accountId?: string;
}

/** Bounded metadata-only log: never accepts URLs, bodies, headers, or exceptions. */
export function createSecurityAudit(rootDirectory: string) {
  const directory = join(rootDirectory, "logs");
  protectDirectory(directory);
  const file = join(directory, "security-events.jsonl");
  let lastFailureNotice = 0;
  return (event: SecurityAuditEvent): void => {
    try {
      if (existsSync(file) && statSync(file).size >= MAX_FILE_BYTES) {
        const oldest = `${file}.${RETAINED_FILES - 1}`;
        if (existsSync(oldest)) unlinkSync(oldest);
        for (let index = RETAINED_FILES - 2; index >= 1; index--) {
          const previous = `${file}.${index}`;
          if (existsSync(previous))
            renameSync(previous, `${file}.${index + 1}`);
        }
        renameSync(file, `${file}.1`);
      }
      const entry = {
        atUtc: new Date().toISOString(),
        surface: event.surface,
        method: event.method.slice(0, 10),
        route: event.route.slice(0, 200),
        status: event.status,
        ...(event.accountId
          ? { accountId: event.accountId.slice(0, 100) }
          : {}),
      };
      appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch {
      // A log failure never converts an authentication denial into access.
      if (Date.now() - lastFailureNotice > 60_000) {
        lastFailureNotice = Date.now();
        process.stderr.write("Dearvale security audit log unavailable.\n");
      }
    }
  };
}

export function installSecurityAudit(
  app: FastifyInstance,
  surface: "user" | "admin",
  write: (event: SecurityAuditEvent) => void,
): void {
  app.addHook("onResponse", (request, reply, done) => {
    // This is the server's registered template, never request.url: it cannot
    // contain credentials in query strings or user-provided path parameters.
    const route = request.routeOptions.url ?? "unmatched";
    if (
      reply.statusCode >= 400 ||
      route.startsWith("/api/hosted/auth/") ||
      (surface === "admin" &&
        route.startsWith("/api/hosted/admin/") &&
        !["GET", "HEAD", "OPTIONS"].includes(request.method))
    ) {
      write({
        surface,
        method: request.method,
        route,
        status: reply.statusCode,
        ...(request.hosted ? { accountId: request.hosted.user.id } : {}),
      });
    }
    done();
  });
}
