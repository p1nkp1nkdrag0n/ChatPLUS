import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  LlmProviderInputSchema,
  LlmSelectionSchema,
  LlmTargetSchema,
} from "@personasim/contracts";
import type { RouteServices } from "./routes.js";
import { LlmDiagnosticsService } from "../services/llm-diagnostics-service.js";
import { ApiError, notFound } from "../domain/errors.js";

const idParams = z.object({ id: z.string().min(1) });

export function registerLlmRoutes(
  app: FastifyInstance,
  services: RouteServices,
  fetchOverride?: typeof fetch,
): void {
  const settings = services.llm.settings!;
  const diagnostics = new LlmDiagnosticsService(settings, fetchOverride);
  app.get("/api/llm/providers", (_request, reply) => {
    reply.header("cache-control", "no-store");
    return settings.catalog();
  });
  app.post("/api/llm/providers", (request, reply) =>
    reply
      .code(201)
      .send(settings.create(LlmProviderInputSchema.parse(request.body))),
  );
  app.patch("/api/llm/providers/:id", (request) =>
    settings.update(
      idParams.parse(request.params).id,
      LlmProviderInputSchema.parse(request.body),
    ),
  );
  app.delete("/api/llm/providers/:id", (request, reply) => {
    settings.delete(idParams.parse(request.params).id);
    return reply.code(204).send();
  });
  app.post("/api/llm/providers/import-env", (request, reply) => {
    const { providerId } = z
      .strictObject({ providerId: z.string().optional() })
      .parse(request.body ?? {});
    return reply.code(201).send(settings.importEnvironment(providerId));
  });
  app.patch("/api/llm/default", (request) => {
    const { selection } = z
      .strictObject({ selection: LlmSelectionSchema })
      .parse(request.body);
    return settings.setDefault(selection);
  });
  app.get("/api/sessions/:id/model", (request) =>
    settings.sessionModel(idParams.parse(request.params).id),
  );
  app.patch("/api/sessions/:id/model", async (request) => {
    const { id } = idParams.parse(request.params);
    const { selection } = z
      .strictObject({ selection: LlmSelectionSchema.nullable() })
      .parse(request.body);
    const session = services.store.getSession(id);
    if (!session) throw notFound("Session");
    return services.actors.runExclusive(session.agentId, () =>
      settings.setSessionModel(id, selection),
    );
  });
  app.post("/api/llm/models/discover", (request, reply) =>
    withCancellation(request, reply, (signal) =>
      diagnostics.discover(LlmTargetSchema.parse(request.body), signal),
    ),
  );
  app.post("/api/llm/test", (request, reply) =>
    withCancellation(request, reply, (signal) =>
      diagnostics.test(LlmTargetSchema.parse(request.body), signal),
    ),
  );
  app.get("/api/llm/tests", (request, reply) => {
    reply.header("cache-control", "no-store");
    const query = z
      .strictObject({
        providerId: z.string().min(1),
        modelId: z.string().min(1),
      })
      .parse(request.query);
    return {
      result: settings.latestProbe(query.providerId, query.modelId) ?? null,
    };
  });
  app.post("/api/llm/credentials/reset", (request) => {
    const input = z
      .strictObject({ confirm: z.literal("reset-provider-credentials") })
      .safeParse(request.body);
    if (!input.success)
      throw new ApiError(
        400,
        "confirmation_required",
        "此操作需要明确确认重新填写所有供应商凭证",
      );
    settings.resetCredentials();
    return settings.catalog();
  });
}

async function withCancellation<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => {
    if (!reply.raw.writableEnded) controller.abort();
  };
  request.raw.once("aborted", abort);
  reply.raw.once("close", abort);
  reply.header("cache-control", "no-store");
  try {
    return await operation(controller.signal);
  } finally {
    request.raw.off("aborted", abort);
    reply.raw.off("close", abort);
  }
}
