import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import type { ServerConfig } from "../config.js";
import { HostedControlStore } from "./control-store.js";
import { HostedAuthService, type HostedLoginResult } from "./auth.js";
import { HostedModelGateway } from "./model-gateway.js";
import { HostedRuntimeManager } from "./runtime-manager.js";
import {
  hostedRequestPath,
  installHostedSecurity,
  requireHostedUser,
} from "./security.js";
import { registerHostedBusiness } from "./business-http.js";
import { registerHostedAdmin } from "./admin-http.js";
import { HostedError } from "./types.js";
import { createSecurityAudit, installSecurityAudit } from "./security-audit.js";

export interface HostedAppOptions {
  rootDirectory: string;
  publicOrigin: string;
  adminOrigin: string;
  baseConfig: ServerConfig;
  webDistPath?: string;
  allowLocalHttp?: boolean;
  startSchedulers?: boolean;
  transport?: typeof fetch;
}
export async function buildHostedApps(options: HostedAppOptions) {
  const rootDirectory = resolve(options.rootDirectory);
  const control = new HostedControlStore(rootDirectory);
  const auth = new HostedAuthService(control);
  const gateway = new HostedModelGateway(control, options.transport);
  // No automatic request/response logging: request URLs and payloads can contain
  // research data. Error handlers log only stable diagnostic identifiers.
  const userApp = Fastify({
    logger: false,
    requestIdHeader: false,
    bodyLimit: 512000,
    requestTimeout: 240000,
  });
  const adminApp = Fastify({
    logger: false,
    requestIdHeader: false,
    bodyLimit: 512000,
    requestTimeout: 240000,
  });
  const runtimes = new HostedRuntimeManager({
    rootDirectory,
    baseConfig: options.baseConfig,
    control,
    gateway,
    logger: userApp.log,
    ...(options.startSchedulers === undefined
      ? {}
      : { startSchedulers: options.startSchedulers }),
  });
  let maintenance = false;
  let researchCleanup: ReturnType<typeof setInterval> | undefined;
  const activeRequests = new Set<string>();
  try {
    const audit = createSecurityAudit(rootDirectory);
    for (const [app, surface, origin] of [
      [userApp, "user", options.publicOrigin],
      [adminApp, "admin", options.adminOrigin],
    ] as const) {
      installSecurityAudit(app, surface, audit);
      // Freeze every API surface before security touches session timestamps. Drain
      // existing mutations, including async password hashing, before snapshotting.
      app.addHook("onRequest", (request, _reply, done) => {
        const path = hostedRequestPath(request);
        if (!path.startsWith("/api/")) return done();
        if (maintenance)
          throw new HostedError(
            503,
            "maintenance",
            "服务器正在备份，请稍后重试。",
          );
        if (
          !path.endsWith("/events") &&
          path !== "/api/hosted/admin/maintenance/backup"
        )
          activeRequests.add(`${surface}:${request.id}`);
        done();
      });
      app.addHook("onResponse", (request, _reply, done) => {
        activeRequests.delete(`${surface}:${request.id}`);
        done();
      });
      app.addHook("onError", (request, _reply, _error, done) => {
        activeRequests.delete(`${surface}:${request.id}`);
        done();
      });
      const security = installHostedSecurity(app, {
        surface,
        origin,
        auth,
        ...(options.allowLocalHttp === undefined
          ? {}
          : { allowLocalHttp: options.allowLocalHttp }),
      });
      const me = (
        result: Pick<HostedLoginResult, "user">,
        csrfToken: string,
      ) => ({
        user: result.user,
        wallet: control.wallet(result.user.id),
        csrfToken,
      });
      app.get("/api/health", () => ({
        status: "ok",
        deploymentMode: "hosted",
        surface,
      }));
      app.get("/api/hosted/info", (request, reply) => ({
        hosted: true,
        surface,
        csrfToken: security.csrf(request, reply),
        bootstrapRequired: surface === "admin" && !control.hasAdmin(),
        consentVersion: "dearvale-friends-research-v1",
        registrationEnabled: control.getLimits().registrationEnabled,
      }));
      app.get("/api/hosted/me", (request, reply) =>
        me(
          requireHostedUser(request, surface === "admin"),
          security.csrf(request, reply),
        ),
      );
      app.post("/api/hosted/auth/login", async (request, reply) => {
        const input = z
          .strictObject({
            username: z.string().max(100),
            password: z.string().max(256),
          })
          .parse(request.body);
        const result = await auth.login(input.username, input.password);
        if (surface === "admin" && result.user.role !== "admin") {
          auth.logout(result.token);
          throw new HostedError(403, "admin_required", "请使用管理员账号。");
        }
        const csrfToken = security.csrf(request, reply);
        security.setSession(reply, result.token, result.session.expiresAtUtc);
        return me(result, csrfToken);
      });
      app.post("/api/hosted/auth/logout", (request, reply) => {
        if (request.hosted) auth.logout(request.hosted.token);
        security.clearSession(reply);
        return { ok: true };
      });
      app.post("/api/hosted/auth/password", async (request, reply) => {
        const { user } = requireHostedUser(request, surface === "admin");
        const input = z
          .strictObject({
            currentPassword: z.string().max(256),
            newPassword: z.string().min(10).max(256),
          })
          .parse(request.body);
        const result = await auth.changePassword(
          user.id,
          input.currentPassword,
          input.newPassword,
        );
        const csrfToken = security.csrf(request, reply);
        security.setSession(reply, result.token, result.session.expiresAtUtc);
        return me(result, csrfToken);
      });
      if (surface === "admin")
        app.post("/api/hosted/auth/bootstrap", async (request, reply) => {
          const input = z
            .strictObject({
              username: z.string().max(100),
              password: z.string().min(10).max(256),
            })
            .parse(request.body);
          const result = await auth.bootstrap(input.username, input.password);
          const csrfToken = security.csrf(request, reply);
          security.setSession(reply, result.token, result.session.expiresAtUtc);
          return me(result, csrfToken);
        });
      else
        app.post("/api/hosted/auth/register", async (request, reply) => {
          const input = z
            .strictObject({
              username: z.string().max(100),
              password: z.string().min(10).max(256),
              inviteCode: z.string().max(200),
              consentVersion: z
                .literal("dearvale-friends-research-v1")
                .optional(),
              acceptedConsent: z.boolean().optional(),
            })
            .parse(request.body);
          const result = await auth.register(input);
          await runtimes.get(result.user.id);
          const csrfToken = security.csrf(request, reply);
          security.setSession(reply, result.token, result.session.expiresAtUtc);
          return me(result, csrfToken);
        });
      await app.register(multipart, {
        limits: { fileSize: 512000, files: 1, fields: 20 },
      });
      if (
        options.webDistPath &&
        existsSync(join(options.webDistPath, "index.html"))
      ) {
        await app.register(fastifyStatic, {
          root: resolve(options.webDistPath),
          wildcard: false,
          dotfiles: "deny",
          index: false,
        });
        app.setNotFoundHandler((request, reply) => {
          if (
            request.method === "GET" &&
            !hostedRequestPath(request).startsWith("/api/") &&
            (surface === "admin" ||
              !hostedRequestPath(request).startsWith("/admin"))
          )
            return reply
              .header("cache-control", "no-store")
              .type("text/html")
              .sendFile("index.html");
          return reply
            .code(404)
            .send({ error: { code: "not_found", message: "未找到该接口。" } });
        });
      }
    }
    const business = registerHostedBusiness(userApp, {
      control,
      gateway,
      runtimes,
    });
    userApp.addHook("onResponse", (request, _reply, done) => {
      const path = hostedRequestPath(request);
      if (
        (path === "/api/hosted/auth/logout" ||
          path === "/api/hosted/auth/password") &&
        request.hosted
      )
        business.disconnectUser(request.hosted.user.id);
      done();
    });
    const quiesce = async () => {
      if (maintenance)
        throw new HostedError(409, "maintenance_running", "维护操作正在执行。");
      maintenance = true;
      gateway.pause();
      try {
        await runtimes.quiesce();
        const deadline = Date.now() + 240000;
        while (activeRequests.size || gateway.getStats().active) {
          if (Date.now() > deadline)
            throw new HostedError(
              409,
              "backup_busy",
              "仍有请求执行，备份未开始，请稍后重试。",
            );
          await new Promise((done) => setTimeout(done, 50));
        }
        // A registration admitted before maintenance may finish Argon2 hashing
        // and create its runtime while existing requests drain. Pause that runtime
        // too before taking any database snapshots.
        await runtimes.quiesce();
      } catch (error) {
        maintenance = false;
        gateway.pause(false);
        await runtimes.resumeAll();
        throw error;
      }
      return async () => {
        maintenance = false;
        gateway.pause(false);
        await runtimes.resumeAll();
      };
    };
    registerHostedAdmin(adminApp, {
      control,
      auth,
      gateway,
      runtimes,
      rootDirectory,
      quiesce,
      disconnectUser: (userId) => {
        gateway.abortUser(userId);
        business.disconnectUser(userId);
      },
    });
    await Promise.all([userApp.ready(), adminApp.ready()]);
    const pruneResearch = () => {
      if (maintenance || control.getLimits().researchRetentionDays === 0)
        return;
      try {
        control.purgeExpiredResearch();
      } catch {
        userApp.log.warn(
          { code: "research_retention_failed" },
          "hosted maintenance failed",
        );
      }
    };
    pruneResearch();
    researchCleanup = setInterval(pruneResearch, 3600000);
    researchCleanup.unref();
    if (options.startSchedulers !== false) await runtimes.restore();
    let closed = false;
    return {
      userApp,
      adminApp,
      control,
      auth,
      gateway,
      runtimes,
      prepareShutdown: quiesce,
      async close() {
        if (closed) return;
        closed = true;
        maintenance = true;
        clearInterval(researchCleanup);
        try {
          await gateway.shutdown();
          await Promise.all([userApp.close(), adminApp.close()]);
        } finally {
          try {
            await runtimes.close();
          } finally {
            control.close();
          }
        }
      },
    };
  } catch (error) {
    clearInterval(researchCleanup);
    await gateway.shutdown().catch(() => undefined);
    await Promise.allSettled([userApp.close(), adminApp.close()]);
    try {
      await runtimes.close();
    } finally {
      control.close();
    }
    throw error;
  }
}
