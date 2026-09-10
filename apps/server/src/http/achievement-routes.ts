import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  AchievementQuerySchema,
  AchievementImageSettingsInputSchema,
  EntityIdSchema,
} from "@personasim/contracts";
import { ImageProviderError } from "@personasim/providers";
import { ApiError } from "../domain/errors.js";
import type { RouteServices } from "./routes.js";

export function registerAchievementRoutes(
  app: FastifyInstance,
  services: RouteServices,
): void {
  const service = services.achievements;
  const params = z.strictObject({ id: EntityIdSchema });
  app.post("/api/activity/visit", (request, reply) => {
    z.strictObject({}).parse(request.body ?? {});
    reply.header("cache-control", "no-store");
    return service.visit();
  });
  app.get("/api/achievements", (request, reply) => {
    reply.header("cache-control", "no-store");
    const query = AchievementQuerySchema.parse(request.query);
    return service.list({
      category: query.category,
      limit: query.limit,
      ...(query.agentId === undefined ? {} : { agentId: query.agentId }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
  });
  app.get("/api/achievements/:id", (request, reply) => {
    reply.header("cache-control", "no-store");
    return service.get(params.parse(request.params).id);
  });
  app.post("/api/achievements/notifications/ack", (request) => {
    const { ids } = z
      .strictObject({ ids: z.array(EntityIdSchema).max(100) })
      .parse(request.body);
    service.acknowledge(ids);
    return { ok: true };
  });
  app.post("/api/achievements/:id/badge/retry", (request) =>
    service.retryBadge(params.parse(request.params).id),
  );
  app.get("/api/achievements/:id/badge", async (request, reply) => {
    const { thumbnail } = z
      .strictObject({ thumbnail: z.enum(["true", "false"]).optional() })
      .parse(request.query);
    const bytes = await service.readAsset(
      params.parse(request.params).id,
      thumbnail === "true",
    );
    return reply
      .type("image/webp")
      .header("cache-control", "private, max-age=86400")
      .send(bytes);
  });
  app.get("/api/achievement-image/settings", (_request, reply) => {
    reply.header("cache-control", "no-store");
    return service.imageSettings();
  });
  app.put("/api/achievement-image/settings", (request) =>
    service.saveImageSettings(
      AchievementImageSettingsInputSchema.parse(request.body),
    ),
  );
  app.post("/api/achievement-image/test", async () => {
    try {
      return await service.testImageSettings();
    } catch (error) {
      if (error instanceof ImageProviderError)
        throw new ApiError(
          422,
          error.code,
          "图片生成未完成，请检查图片模型配置后重试。",
        );
      throw error;
    }
  });
  if (services.config.developerRoutes)
    app.get("/api/developer/achievements", () => service.diagnostics());

  const connections = new Set<() => void>();
  app.addHook("preClose", (done) => {
    for (const close of connections) close();
    done();
  });
  app.get("/api/achievements/events", (_request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    let revision = service.revision();
    reply.raw.write(`event: achievements.changed\ndata: {}\n\n`);
    const timer = setInterval(() => {
      const current = service.revision();
      if (current !== revision) {
        revision = current;
        reply.raw.write(`event: achievements.changed\ndata: {}\n\n`);
      } else reply.raw.write(": heartbeat\n\n");
    }, 2000);
    timer.unref();
    const close = () => {
      clearInterval(timer);
      connections.delete(close);
      if (!reply.raw.destroyed) reply.raw.end();
    };
    connections.add(close);
    reply.raw.on("close", close);
  });
}
