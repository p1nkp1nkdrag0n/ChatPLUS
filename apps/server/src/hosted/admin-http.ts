import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { HostedControlStore } from "./control-store.js";
import type { HostedAuthService } from "./auth.js";
import type { HostedRuntimeManager } from "./runtime-manager.js";
import type { HostedModelGateway } from "./model-gateway.js";
import { hostedRequestPath, requireHostedUser } from "./security.js";
import { createHostedBackup } from "./backup.js";
import { HostedError, type HostedModelInput } from "./types.js";

const id = (request: FastifyRequest) =>
  z.object({ id: z.string().min(1).max(200) }).parse(request.params).id;
const micros = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const reason = z.string().trim().min(1).max(2000);
function defined<T extends object>(
  value: T,
): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as { [K in keyof T]: Exclude<T[K], undefined> };
}
const modelSchema = z.strictObject({
  routeId: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9_-]+$/u),
  displayName: z.string().trim().min(1).max(160),
  kind: z.enum(["text", "image"]),
  protocol: z.enum(["openai-compatible", "anthropic", "gemini"]),
  baseUrl: z.string().url().max(2000),
  modelId: z.string().trim().min(1).max(250),
  apiKey: z.string().max(8192).optional(),
  inputMicrosPerMillion: micros,
  outputMicrosPerMillion: micros,
  cacheReadMicrosPerMillion: micros,
  cacheWriteMicrosPerMillion: micros.optional(),
  maxOutputTokens: z.number().int().min(1).max(64000),
  maxContextTokens: z.number().int().min(8192).max(2000000).optional(),
  imagePointsMicros: micros.optional(),
  imageSpecification: z.string().max(100).optional(),
  enabled: z.boolean(),
});
const researchFilter = z.object({
  userId: z.string().optional(),
  operationId: z.string().optional(),
  sessionId: z.string().optional(),
  attemptId: z.string().optional(),
  modelId: z.string().max(250).optional(),
  purpose: z.string().max(100).optional(),
  kind: z.enum(["request", "response", "image"]).optional(),
  beforeUtc: z.string().datetime().optional(),
  afterUtc: z.string().datetime().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().nonnegative().default(0),
});

export function registerHostedAdmin(
  app: FastifyInstance,
  deps: {
    control: HostedControlStore;
    auth: HostedAuthService;
    runtimes: HostedRuntimeManager;
    gateway: HostedModelGateway;
    rootDirectory: string;
    disconnectUser(userId: string): void;
    quiesce(): Promise<() => Promise<void>>;
  },
) {
  const { control, auth, runtimes } = deps;
  const actor = (request: FastifyRequest) =>
    requireHostedUser(request, true).user.id;
  app.addHook("preHandler", (request, _reply, done) => {
    if (hostedRequestPath(request).startsWith("/api/hosted/admin/"))
      actor(request);
    done();
  });
  app.get("/api/hosted/admin/overview", (request) => {
    actor(request);
    return {
      ...control.overviewStats(),
      calls: deps.gateway.getStats(),
      runtimeCount: runtimes.size,
      limits: control.getLimits(),
    };
  });
  app.get("/api/hosted/admin/users", (request) => {
    const query = z
      .object({
        q: z.string().max(100).optional(),
        status: z.enum(["active", "banned"]).optional(),
      })
      .parse(request.query);
    return {
      users: control
        .listUsers({
          ...(query.q ? { search: query.q } : {}),
          ...(query.status ? { status: query.status } : {}),
          limit: 1000,
        })
        .map((user) => ({ ...user, wallet: control.wallet(user.id) })),
    };
  });
  app.patch("/api/hosted/admin/users/:id", async (request) => {
    const userId = id(request),
      actorId = actor(request);
    const input = z
      .strictObject({
        status: z.enum(["active", "banned"]).optional(),
        deltaMicros: z
          .number()
          .int()
          .max(Number.MAX_SAFE_INTEGER)
          .min(-Number.MAX_SAFE_INTEGER)
          .optional(),
        balanceMicros: micros.optional(),
        reason,
      })
      .parse(request.body);
    if (input.status === "banned" && userId === actorId)
      throw new HostedError(409, "cannot_ban_self", "不能封禁当前管理员。");
    if (input.deltaMicros !== undefined && input.balanceMicros !== undefined)
      throw new HostedError(
        400,
        "invalid_adjustment",
        "请选择增加积分或设置余额其中一种方式。",
      );
    if (input.deltaMicros !== undefined || input.balanceMicros !== undefined)
      control.adjustBalance(
        userId,
        input.deltaMicros ??
          input.balanceMicros! - control.wallet(userId).balanceMicros,
        actorId,
        input.reason,
      );
    if (input.status) {
      control.banUser(userId, input.status === "banned", actorId, input.reason);
      if (input.status === "banned") {
        deps.disconnectUser(userId);
        await runtimes.disconnect(userId);
      } else await runtimes.resume(userId);
    }
    return { user: control.getUser(userId), wallet: control.wallet(userId) };
  });
  app.post("/api/hosted/admin/users/:id/reset-password", async (request) => {
    const input = z
      .strictObject({ password: z.string().min(10).max(256) })
      .parse(request.body);
    const user = await auth.resetPassword(
      id(request),
      input.password,
      actor(request),
    );
    deps.disconnectUser(user.id);
    return { user };
  });
  app.get("/api/hosted/admin/invitations", () => ({
    invitations: control.listInvites(),
  }));
  app.post("/api/hosted/admin/invitations", (request) => {
    const input = z
      .strictObject({
        label: z.string().max(160).optional(),
        maxUses: z.number().int().min(1).max(1000).optional(),
        initialBalanceMicros: micros.optional(),
        expiresAtUtc: z.string().datetime().nullable().optional(),
      })
      .parse(request.body);
    const result = control.createInvite(defined(input), actor(request));
    return { invitation: result.invite, code: result.code };
  });
  app.patch("/api/hosted/admin/invitations/:id", (request) => {
    z.object({
      disabled: z.literal(true).optional(),
      revoked: z.literal(true).optional(),
    }).parse(request.body);
    control.revokeInvite(id(request), actor(request));
    return { invitations: control.listInvites() };
  });
  app.get("/api/hosted/admin/models", () => ({
    models: control
      .listModels()
      .map((m) => ({ ...m, keyConfigured: control.modelHasKey(m.routeId) })),
  }));
  app.post("/api/hosted/admin/models", (request) => ({
    model: control.upsertModel(
      modelSchema.parse(request.body) as HostedModelInput,
      actor(request),
    ),
  }));
  app.patch("/api/hosted/admin/models/:id", (request) => {
    const routeId = id(request);
    const existing = control.listModels().find((m) => m.routeId === routeId);
    if (!existing)
      throw new HostedError(404, "model_not_found", "未找到模型。");
    const previous = Object.fromEntries(
      Object.entries(existing).filter(([key]) => key !== "revision"),
    );
    const input = modelSchema.parse({
      ...previous,
      ...z.record(z.string(), z.unknown()).parse(request.body),
      routeId,
    });
    return {
      model: control.upsertModel(input as HostedModelInput, actor(request)),
    };
  });
  app.get("/api/hosted/admin/purpose-mappings", () => ({
    mappings: control.purposeDefaults(),
  }));
  app.patch("/api/hosted/admin/purpose-mappings", (request) => {
    const input = z
      .strictObject({
        mappings: z.record(
          z.string().min(1).max(100),
          z.string().min(1).max(100),
        ),
      })
      .parse(request.body);
    return {
      mappings: control.replacePurposeDefaults(input.mappings, actor(request)),
    };
  });
  app.get("/api/hosted/admin/billing", (request) => {
    const query = z
      .object({
        userId: z.string().optional(),
        status: z
          .enum(["reserved", "sent", "settled", "released", "unknown"])
          .optional(),
      })
      .parse(request.query);
    return {
      entries: control.listLedger(query.userId, 1000),
      attempts: control.listAttempts({ ...defined(query), limit: 1000 }),
    };
  });
  app.post("/api/hosted/admin/billing/:id/reconcile", (request) => {
    const input = z
      .strictObject({
        action: z.enum(["charge", "release"]),
        amountMicros: micros.optional(),
        reason,
      })
      .parse(request.body);
    if (input.action === "charge" && input.amountMicros === undefined)
      throw new HostedError(400, "amount_required", "请输入核对后的积分。");
    return {
      attempt: control.reconcile({
        id: id(request),
        costMicros: input.action === "release" ? 0 : input.amountMicros!,
        actorId: actor(request),
        reason: input.reason,
      }),
    };
  });
  const filters = (value: unknown) => {
    const { from, to, ...rest } = researchFilter.parse(value);
    return defined({
      ...rest,
      modelOnly: true,
      ...(from ? { afterUtc: new Date(from).toISOString() } : {}),
      ...(to ? { beforeUtc: new Date(to).toISOString() } : {}),
    });
  };
  app.get("/api/hosted/admin/research", (request) => ({
    records: control.listResearch(filters(request.query)),
  }));
  app.get("/api/hosted/admin/research/:id", (request) => {
    const { payload, ...record } = control.readResearch(
      id(request),
      actor(request),
    );
    return { record, payload };
  });
  app.post("/api/hosted/admin/research/export", (request, reply) => {
    const data = control.exportResearch(
      filters(request.body ?? {}),
      actor(request),
    );
    return reply
      .type("application/x-ndjson; charset=utf-8")
      .header(
        "content-disposition",
        `attachment; filename="dearvale-research-${new Date().toISOString().slice(0, 10)}.jsonl"`,
      )
      .send(data);
  });
  app.delete("/api/hosted/admin/research/:id", (request) => ({
    deleted: control.deleteResearch({ id: id(request) }, actor(request)),
  }));
  app.get("/api/hosted/admin/maintenance", () => ({
    limits: control.getLimits(),
    collectionEnabled: true,
    rootDirectory: deps.rootDirectory,
    runtimeCount: runtimes.size,
    storage: control.storageStats(),
    audit: control.listAudit(50),
  }));
  app.patch("/api/hosted/admin/maintenance", (request) => {
    const input = z
      .object({
        limits: z.record(z.string(), z.union([z.number(), z.boolean()])),
      })
      .parse(request.body);
    const limits = control.setLimits(input.limits, actor(request));
    if (limits.researchRetentionDays > 0)
      control.purgeExpiredResearch(actor(request));
    return {
      limits,
      collectionEnabled: true,
    };
  });
  app.post("/api/hosted/admin/maintenance/backup", async (request) => {
    const { passphrase } = z
      .strictObject({ passphrase: z.string().min(12).max(256) })
      .parse(request.body);
    const result = await createHostedBackup({
      store: control,
      destination: join(
        deps.rootDirectory,
        "backups",
        `dearvale-${Date.now()}-${randomUUID().slice(0, 8)}.dvbackup`,
      ),
      passphrase,
      quiesce: () => deps.quiesce(),
    });
    control.audit(actor(request), "backup.create", null, {
      fileCount: result.fileCount,
    });
    return result;
  });
}
