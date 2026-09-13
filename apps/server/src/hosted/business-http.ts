import { createHash, randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { HostedControlStore } from "./control-store.js";
import type { HostedModelGateway } from "./model-gateway.js";
import { HostedError, type HostedAttempt } from "./types.js";
import { requireHostedUser } from "./security.js";
import { businessRouteManifest } from "./route-registry.js";
import type { HostedRuntimeManager, TenantRuntime } from "./runtime-manager.js";
import { readImportInput } from "../http/routes.js";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export function publicAttempt(attempt: HostedAttempt) {
  const usage = attempt.usage;
  return {
    id: attempt.id,
    operationId: attempt.operationId,
    purpose: attempt.purpose,
    status: attempt.status,
    costMicros: attempt.costMicros,
    reservedMicros: ["reserved", "sent", "unknown"].includes(attempt.status)
      ? attempt.maximumCostMicros
      : 0,
    displayName: attempt.modelSnapshot.displayName,
    kind: attempt.modelSnapshot.kind,
    createdAtUtc: attempt.createdAtUtc,
    usage: usage
      ? {
          inputTokens: usage.inputTokens ?? null,
          outputTokens: usage.outputTokens ?? null,
          cacheReadTokens: usage.cacheReadTokens ?? null,
          cacheWriteTokens: usage.cacheWriteTokens ?? null,
          ...(typeof usage.generatedImages === "number"
            ? { imageCount: usage.generatedImages }
            : {}),
        }
      : null,
  };
}

export function registerHostedBusiness(
  app: FastifyInstance,
  deps: {
    control: HostedControlStore;
    gateway: HostedModelGateway;
    runtimes: HostedRuntimeManager;
  },
) {
  const { control, gateway, runtimes } = deps;
  const operations = new WeakMap<
    FastifyRequest,
    { userId: string; operationId: string }
  >();
  const liveOperations = new Set<string>();
  const sockets = new Map<string, Set<ServerResponse>>();
  const disconnectUser = (userId: string) => {
    for (const response of sockets.get(userId) ?? []) response.end();
    sockets.delete(userId);
  };

  app.addHook("onSend", async (request, _reply, payload) => {
    const operation = operations.get(request);
    if (operation && typeof payload === "string") {
      let response: unknown;
      try {
        response = JSON.parse(payload);
      } catch {
        return payload;
      }
      operations.delete(request);
      liveOperations.delete(`${operation.userId}:${operation.operationId}`);
      // A storage/transient server failure keeps the operation recoverable. Its
      // paid attempts are already durable and replay without another dispatch.
      if (_reply.statusCode >= 400 && _reply.statusCode < 500)
        control.failOperation(operation.userId, operation.operationId, {
          statusCode: _reply.statusCode,
          response,
        });
      else if (_reply.statusCode < 400)
        control.completeOperation(operation.userId, operation.operationId, {
          statusCode: _reply.statusCode,
          response,
        });
    }
    return payload;
  });
  app.addHook("onResponse", (request, _reply, done) => {
    const operation = operations.get(request);
    if (operation)
      liveOperations.delete(`${operation.userId}:${operation.operationId}`);
    done();
  });
  app.addHook("preClose", (done) => {
    for (const userId of sockets.keys()) disconnectUser(userId);
    done();
  });

  for (const route of businessRouteManifest()) {
    app.route({
      method: route.method,
      url: route.url,
      handler: async (request, reply) => {
        const { user, session: loginSession } = requireHostedUser(request);
        if (user.mustChangePassword)
          throw new HostedError(
            403,
            "password_change_required",
            "请先设置新密码。",
          );
        const runtime = await runtimes.get(user.id);
        runtimes.syncModels(runtime);
        const services = runtime.composition.routeServices;
        const params = object(request.params),
          body = object(request.body);
        const query = object(request.query);
        // Ownership validation precedes catch-up, scheduling, or any paid work.
        const pathAgentId =
          typeof params.agentId === "string"
            ? params.agentId
            : /^\/api\/(agents|characters)\/:id(?:\/|$)/u.test(route.url) &&
                typeof params.id === "string"
              ? params.id
              : undefined;
        if (pathAgentId && !services.store.getCharacterSummary(pathAgentId))
          throw new HostedError(404, "not_found", "未找到角色。");
        if (
          typeof query.agentId === "string" &&
          !services.store.getCharacterSummary(query.agentId)
        )
          throw new HostedError(404, "not_found", "未找到角色。");
        if (
          typeof body.agentId === "string" &&
          !services.store.getCharacterSummary(body.agentId)
        )
          throw new HostedError(404, "not_found", "未找到角色。");
        if (typeof params.sessionId === "string") {
          const session = services.store.getSession(params.sessionId);
          if (!session || (body.agentId && body.agentId !== session.agentId))
            throw new HostedError(404, "not_found", "未找到会话。");
        }
        const sessionId =
          typeof params.sessionId === "string"
            ? params.sessionId
            : typeof body.sessionId === "string"
              ? body.sessionId
              : undefined;
        const clientMessageId =
          typeof body.clientMessageId === "string"
            ? body.clientMessageId
            : undefined;
        const suppliedKey =
          clientMessageId ??
          (typeof body.requestId === "string"
            ? body.requestId
            : request.headers["idempotency-key"]);
        if (
          suppliedKey !== undefined &&
          (typeof suppliedKey !== "string" || suppliedKey.length > 250)
        )
          throw new HostedError(400, "invalid_operation_id", "请求标识无效。");
        const operationId = clientMessageId
          ? `chat:${clientMessageId}`
          : `http:${createHash("sha256")
              .update(
                `${request.method}:${route.url}:${typeof suppliedKey === "string" ? suppliedKey : randomUUID()}`,
              )
              .digest("hex")}`;
        // Multipart bodies are streams. Normalize the allowed text file once so
        // its actual contents participate in idempotency.
        const uploadedImport =
          route.url === "/api/characters/import" && request.isMultipart()
            ? await readImportInput(request)
            : undefined;
        if (request.method !== "GET") {
          const previous = control.beginOperation({
            id: operationId,
            userId: user.id,
            method: request.method,
            path: request.url,
            input: uploadedImport ?? request.body ?? null,
            ...(sessionId ? { sessionId } : {}),
            ...(clientMessageId ? { clientMessageId } : {}),
          });
          if (previous.status === "completed" || previous.status === "failed")
            return reply
              .code(previous.statusCode ?? 200)
              .send(previous.response);
          const activeKey = `${user.id}:${operationId}`;
          if (liveOperations.has(activeKey))
            throw new HostedError(
              409,
              "operation_running",
              "这条请求正在处理中，请稍后查看。",
            );
          liveOperations.add(activeKey);
          operations.set(request, { userId: user.id, operationId });
        }
        if (route.url.endsWith("/events")) {
          const responses = sockets.get(user.id) ?? new Set();
          responses.add(reply.raw);
          sockets.set(user.id, responses);
          const expiry = setTimeout(
            () => reply.raw.end(),
            Math.min(
              2147483647,
              Math.max(
                1,
                new Date(loginSession.expiresAtUtc).getTime() - Date.now(),
              ),
            ),
          );
          expiry.unref();
          reply.raw.once("close", () => {
            clearTimeout(expiry);
            responses.delete(reply.raw);
            if (!responses.size) sockets.delete(user.id);
          });
        }
        let publicModelId: string | undefined;
        const selection = object(body.modelSelection ?? body.model);
        if (selection.modelId !== undefined) {
          if (
            selection.providerId !== "hosted" ||
            typeof selection.modelId !== "string"
          )
            throw new HostedError(400, "invalid_model", "请选择可用模型。");
          control.resolveModel(selection.modelId);
          publicModelId = selection.modelId;
        } else if (sessionId) {
          publicModelId =
            services.llm.sessionModel(sessionId)?.effective?.modelId;
        }
        const registered = runtime.registry.routes.get(
          `${route.method} ${route.url}`,
        );
        if (!registered)
          throw new HostedError(404, "not_found", "未找到该接口。");
        return gateway.runOperation(
          {
            userId: user.id,
            operationId,
            ...(sessionId ? { sessionId } : {}),
            ...(publicModelId ? { publicModelId } : {}),
          },
          async () => {
            if (uploadedImport !== undefined)
              return reply.code(201).send({
                character: await services.characters.import(uploadedImport),
              });
            return registered.handler(request, reply);
          },
        );
      },
    });
  }

  const getRuntime = async (
    request: FastifyRequest,
  ): Promise<TenantRuntime> => {
    const { user } = requireHostedUser(request);
    const runtime = await runtimes.get(user.id);
    runtimes.syncModels(runtime);
    return runtime;
  };
  app.get("/api/llm/providers", async (request) => {
    await getRuntime(request);
    const models = control
      .listModels()
      .filter((model) => model.kind === "text" && model.enabled);
    let defaultId = models[0]?.routeId ?? "unconfigured";
    try {
      defaultId = control.resolvePurpose("chat_turn").routeId;
    } catch {
      /* setup incomplete */
    }
    return {
      providers: models.length
        ? [
            {
              id: "hosted",
              name: "可用模型",
              protocol: "openai-compatible",
              baseUrl: "",
              timeoutMs: 120000,
              revision: 1,
              models: models.map((model) => ({
                id: model.routeId,
                label: model.displayName,
                tokenParameter: "max_tokens",
                capabilities: {
                  structuredOutputMode: "prompt_json",
                  supportsThinkingControl: false,
                  supportsStreaming: false,
                  maxOutputTokens: model.maxOutputTokens,
                },
              })),
              source: "managed",
              hasApiKey: true,
              credentialStatus: "ready",
              referencedSessions: 0,
            },
          ]
        : [],
      defaultSelection: { providerId: "hosted", modelId: defaultId },
    };
  });
  app.get("/api/hosted/models", (request) => {
    requireHostedUser(request);
    return {
      models: control
        .listModels()
        .filter((m) => m.enabled)
        .map((m) => ({
          publicModelId: m.routeId,
          displayName: m.displayName,
          kind: m.kind,
          inputMicrosPerMillion: m.inputMicrosPerMillion,
          outputMicrosPerMillion: m.outputMicrosPerMillion,
          cacheReadMicrosPerMillion: m.cacheReadMicrosPerMillion,
          cacheWriteMicrosPerMillion:
            m.cacheWriteMicrosPerMillion ?? m.inputMicrosPerMillion,
          imagePointsMicros: m.imagePointsMicros,
        })),
    };
  });
  app.get("/api/sessions/:id/model", async (request) => {
    const runtime = await getRuntime(request);
    const id = z.object({ id: z.string() }).parse(request.params).id;
    if (!runtime.composition.routeServices.store.getSession(id))
      throw new HostedError(404, "not_found", "未找到会话。");
    return runtime.composition.routeServices.llm.sessionModel(id);
  });
  app.patch("/api/sessions/:id/model", async (request) => {
    const runtime = await getRuntime(request);
    const id = z.object({ id: z.string() }).parse(request.params).id;
    const input = z
      .union([
        z.strictObject({
          selection: z
            .strictObject({
              providerId: z.literal("hosted"),
              modelId: z.string(),
            })
            .nullable(),
        }),
        z.strictObject({ publicModelId: z.string().nullable() }),
      ])
      .parse(request.body);
    const selection =
      "selection" in input
        ? input.selection
        : input.publicModelId
          ? { providerId: "hosted", modelId: input.publicModelId }
          : null;
    if (selection && control.resolveModel(selection.modelId).kind !== "text")
      throw new HostedError(400, "invalid_model", "请选择文本模型。");
    const { store, actors, llm } = runtime.composition.routeServices;
    const session = store.getSession(id);
    if (!session) throw new HostedError(404, "not_found", "未找到会话。");
    return actors.runExclusive(session.agentId, () => {
      llm.settings!.setSessionModel(id, selection);
      return llm.sessionModel(id);
    });
  });
  app.get("/api/settings", async (request) => {
    const { store, config } = (await getRuntime(request)).composition
      .routeServices;
    const settings = store.getSettings();
    return {
      settings: {
        locale: settings.locale ?? "zh-CN",
        defaultTimezone: settings.defaultTimezone ?? "Asia/Shanghai",
        replyGoalReviewEnabled: settings.replyGoalReviewEnabled === true,
      },
      runtime: {
        hosted: true,
        llmProvider: "openai-compatible",
        llmProfile: "hosted",
        llmModel: "由服务器管理",
        llmBaseUrl: "",
        hasApiKey: true,
        clockMode: "system",
        developerMode: false,
        correspondenceMode: config.correspondenceMode,
        correspondenceExecution: config.correspondenceExecution,
        keepsakeMode: config.keepsakeMode,
      },
    };
  });
  const updateSettings = async (request: FastifyRequest) => {
    const values = z
      .strictObject({
        locale: z.enum(["zh-CN", "en-US"]).optional(),
        defaultTimezone: z.string().max(100).optional(),
        replyGoalReviewEnabled: z.boolean().optional(),
      })
      .parse(request.body);
    const { store, clock } = (await getRuntime(request)).composition
      .routeServices;
    store.setSettings(values, clock.nowUtc());
    return { settings: store.getSettings() };
  };
  app.patch("/api/settings", updateSettings);
  app.put("/api/settings", updateSettings);
  app.get("/api/hosted/billing", async (request) => {
    const { user } = requireHostedUser(request);
    const query = z
      .object({
        operationId: z.string().optional(),
        messageId: z.string().optional(),
        clientMessageId: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(request.query);
    query.messageId ??= query.clientMessageId;
    let operationId = query.operationId;
    if (query.messageId) {
      const { store } = (await getRuntime(request)).composition.routeServices;
      const row = store.database
        .prepare(
          "SELECT client_message_id,in_reply_to_message_id FROM messages WHERE id=? OR client_message_id=? LIMIT 1",
        )
        .get(query.messageId, query.messageId) as
        | {
            client_message_id: string | null;
            in_reply_to_message_id: string | null;
          }
        | undefined;
      let clientId = row?.client_message_id;
      if (!clientId && row?.in_reply_to_message_id)
        clientId = (
          store.database
            .prepare("SELECT client_message_id FROM messages WHERE id=?")
            .get(row.in_reply_to_message_id) as
            { client_message_id: string | null } | undefined
        )?.client_message_id;
      operationId = `chat:${clientId ?? query.messageId}`;
    }
    return {
      wallet: control.wallet(user.id),
      attempts: control
        .listAttempts({
          userId: user.id,
          ...(operationId ? { operationId } : {}),
          limit: query.limit,
        })
        .map(publicAttempt),
      entries: control.listLedger(user.id, query.limit),
    };
  });
  return { disconnectUser };
}
