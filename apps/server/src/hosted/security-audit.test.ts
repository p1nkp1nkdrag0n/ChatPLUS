import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  createSecurityAudit,
  installSecurityAudit,
  type SecurityAuditEvent,
} from "./security-audit.js";

describe("hosted security audit", () => {
  it("records denied requests using server route templates without headers, query strings, or bodies", async () => {
    const app = Fastify();
    const records: SecurityAuditEvent[] = [];
    installSecurityAudit(app, "admin", (entry) => records.push(entry));
    app.post("/api/hosted/admin/users/:id", (_request, reply) =>
      reply.code(403).send({ error: "forbidden" }),
    );
    app.get("/healthy", () => ({ ok: true }));
    try {
      await app.inject({
        method: "POST",
        url: "/api/hosted/admin/users/secret-in-path?apiKey=secret-in-query",
        headers: { authorization: "Bearer secret-in-header" },
        payload: { password: "secret-in-body" },
      });
      await app.inject({ method: "GET", url: "/healthy" });
      await app.inject({ method: "GET", url: "/missing-secret-in-path" });
      expect(records).toHaveLength(2);
      expect(records[0]).toEqual({
        surface: "admin",
        method: "POST",
        route: "/api/hosted/admin/users/:id",
        status: 403,
      });
      expect(JSON.stringify(records)).not.toContain("secret-in-");
    } finally {
      await app.close();
    }
  });

  it("retains a bounded number of metadata log files", () => {
    const root = mkdtempSync(join(tmpdir(), "dearvale-audit-"));
    if (!resolve(root).startsWith(`${resolve(tmpdir())}${sep}dearvale-audit-`))
      throw new Error("Unexpected audit test cleanup directory");
    try {
      const write = createSecurityAudit(root);
      const file = join(root, "logs", "security-events.jsonl");
      for (let index = 0; index < 7; index++) {
        writeFileSync(file, " ".repeat(1024 * 1024));
        write({
          surface: "user",
          method: "GET",
          route: "/api/hosted/me",
          status: 401,
        });
      }
      expect(readdirSync(join(root, "logs"))).toHaveLength(4);
      expect(statSync(file).size).toBeLessThan(1024);
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
        surface: "user",
        route: "/api/hosted/me",
        status: 401,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
