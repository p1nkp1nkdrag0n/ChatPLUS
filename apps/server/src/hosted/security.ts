import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { HostedError, type HostedSession, type HostedUser } from "./types.js";
import type { HostedAuthService } from "./auth.js";
import { LlmServiceError } from "../services/llm-service.js";

declare module "fastify" {
  interface FastifyRequest {
    hosted: { user: HostedUser; session: HostedSession; token: string } | null;
  }
}
export interface HostedSecurityOptions {
  surface: "user" | "admin";
  origin: string;
  auth: HostedAuthService;
  allowLocalHttp?: boolean;
}
/** Fastify matches decoded paths before onRequest. Classify the matched route,
 * never the raw URL, so percent encoding cannot skip an authorization hook. */
export function hostedRequestPath(request: FastifyRequest): string {
  const matched = request.routeOptions.url;
  if (matched && matched !== "*" && matched !== "/*") return matched;
  const pathname = request.url.split("?")[0] ?? "/";
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}
export function validateHostedOrigin(
  value: string,
  allowLocalHttp = false,
): string {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(allowLocalHttp && loopback && url.protocol === "http:"))
  ) {
    throw new Error(
      "Hosted public origin must be an HTTPS origin (loopback HTTP is only allowed explicitly).",
    );
  }
  return url.origin;
}
function cookies(request: FastifyRequest): Map<string, string> {
  return new Map(
    (request.headers.cookie ?? "").split(";").map((part) => {
      const at = part.indexOf("=");
      return [part.slice(0, at).trim(), part.slice(at + 1).trim()];
    }),
  );
}
function same(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export function installHostedSecurity(
  app: FastifyInstance,
  options: HostedSecurityOptions,
) {
  const secret = randomBytes(32);
  const origin = validateHostedOrigin(
    options.origin,
    options.surface === "admin" || options.allowLocalHttp,
  );
  const secure = origin.startsWith("https:");
  const cookieName = `dearvale_${options.surface}_session`;
  const csrfName = `dearvale_${options.surface}_csrf`;
  const suffix = `; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
  const signature = (value: string) =>
    createHmac("sha256", secret).update(value).digest("base64url");
  const rates = new Map<string, { count: number; reset: number }>();
  app.decorateRequest("hosted", null);
  function csrf(request: FastifyRequest, reply: FastifyReply): string {
    const old = cookies(request).get(csrfName);
    if (old && validCsrf(old)) return old;
    const value = `${Date.now()}.${randomBytes(24).toString("base64url")}`;
    const token = `${value}.${signature(value)}`;
    reply.header("set-cookie", `${csrfName}=${token}${suffix}; Max-Age=86400`);
    return token;
  }
  function validCsrf(token: string): boolean {
    const parts = token.split(".");
    return (
      parts.length === 3 &&
      Number(parts[0]) <= Date.now() &&
      Number(parts[0]) > Date.now() - 86400000 &&
      same(parts[2]!, signature(`${parts[0]}.${parts[1]}`))
    );
  }
  function setSession(
    reply: FastifyReply,
    token: string,
    expiresAtUtc: string,
  ): void {
    reply.header(
      "set-cookie",
      `${cookieName}=${token}${suffix}; Expires=${new Date(expiresAtUtc).toUTCString()}`,
    );
  }
  function clearSession(reply: FastifyReply): void {
    reply.header("set-cookie", `${cookieName}=${suffix}; Max-Age=0`);
  }
  function limit(key: string, maximum: number, milliseconds = 60000): void {
    const now = Date.now();
    if (rates.size > 10000)
      for (const [id, value] of rates) if (value.reset < now) rates.delete(id);
    if (rates.size > 20000 && !rates.has(key))
      throw new HostedError(429, "rate_limited", "请求较多，请稍后重试。");
    const bucket = rates.get(key);
    if (!bucket || bucket.reset < now)
      rates.set(key, { count: 1, reset: now + milliseconds });
    else if (++bucket.count > maximum)
      throw new HostedError(429, "rate_limited", "请求较多，请稍后重试。");
  }
  app.addHook("onRequest", async (request, reply) => {
    const path = hostedRequestPath(request);
    reply
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "no-referrer")
      .header(
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      );
    if (secure) reply.header("strict-transport-security", "max-age=31536000");
    const host = request.headers.host;
    if (host !== new URL(origin).host)
      throw new HostedError(421, "invalid_host", "服务地址不匹配。");
    if (path.startsWith("/api/")) reply.header("cache-control", "no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      if (request.headers.origin !== origin)
        throw new HostedError(403, "invalid_origin", "请求来源不匹配。");
      const supplied = request.headers["x-csrf-token"];
      const stored = cookies(request).get(csrfName);
      if (
        typeof supplied !== "string" ||
        !stored ||
        !same(supplied, stored) ||
        !validCsrf(stored)
      )
        throw new HostedError(
          403,
          "csrf_invalid",
          "页面验证已过期，请刷新后重试。",
        );
      limit(`write:${request.ip}`, 300);
    }
    if (path.startsWith("/api/hosted/auth/")) limit(`auth:${request.ip}`, 60);
    const token = cookies(request).get(cookieName);
    if (token) {
      try {
        request.hosted = { ...options.auth.authenticate(token), token };
      } catch {
        clearSession(reply);
      }
    }
    if (
      request.hosted?.user.mustChangePassword &&
      path.startsWith("/api/") &&
      ![
        "/api/health",
        "/api/hosted/info",
        "/api/hosted/me",
        "/api/hosted/auth/login",
        "/api/hosted/auth/password",
        "/api/hosted/auth/logout",
      ].includes(path)
    )
      throw new HostedError(
        403,
        "password_change_required",
        "请先设置新密码。",
      );
  });
  app.addHook("onSend", async (request, reply, payload) => {
    // Business asset handlers were originally single-user and may request public
    // caching. Authenticated hosted data must never enter a shared proxy cache.
    if (hostedRequestPath(request).startsWith("/api/"))
      reply.header("cache-control", "no-store");
    return payload;
  });
  app.setErrorHandler((error, request, reply) => {
    if (reply.sent) return;
    const known = error instanceof HostedError;
    const modelChanged =
      error instanceof LlmServiceError &&
      error.code === "model_revision_changed";
    const validation = error instanceof ZodError;
    const status = known
      ? error.statusCode
      : modelChanged
        ? 409
        : validation
          ? 400
          : typeof error === "object" &&
              error !== null &&
              "statusCode" in error &&
              typeof error.statusCode === "number" &&
              error.statusCode >= 400 &&
              error.statusCode < 500
            ? error.statusCode
            : 500;
    const code = known
      ? error.code
      : modelChanged
        ? "model_revision_changed"
        : validation
          ? "validation_error"
          : status === 404
            ? "not_found"
            : status < 500
              ? "request_rejected"
              : "internal_error";
    request.log.warn(
      { code, status, requestId: request.id },
      "hosted request failed",
    );
    void reply.code(status).send({
      error: {
        code,
        message: known
          ? error.message
          : modelChanged
            ? "模型配置已更新，请刷新页面后重试。"
            : validation
              ? "请检查填写的内容。"
              : status === 404
                ? "未找到该内容。"
                : "请求未能完成，请稍后重试。",
        requestId: request.id,
      },
    });
  });
  return { csrf, setSession, clearSession, limit, origin };
}
export function requireHostedUser(
  request: FastifyRequest,
  admin = false,
): NonNullable<FastifyRequest["hosted"]> {
  if (!request.hosted)
    throw new HostedError(401, "login_required", "请先登录。");
  if (admin && request.hosted.user.role !== "admin")
    throw new HostedError(403, "admin_required", "此操作需要管理员账号。");
  return request.hosted;
}
