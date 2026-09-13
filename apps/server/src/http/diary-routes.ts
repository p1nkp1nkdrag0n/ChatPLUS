import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  DiaryDateSchema,
  DiaryMonthSchema,
  DiaryVolumesQuerySchema,
  EntityIdSchema,
  GenerateDiaryInputSchema,
} from "@personasim/contracts";
import type { DiaryService } from "../services/diary-service.js";

export function registerDiaryRoutes(
  app: FastifyInstance,
  service: DiaryService,
): void {
  const agentParams = z.strictObject({ agentId: EntityIdSchema });
  app.get("/api/diaries/volumes", (request, reply) => {
    reply.header("cache-control", "no-store");
    return {
      volumes: service.volumes(DiaryVolumesQuerySchema.parse(request.query)),
    };
  });
  app.get("/api/agents/:agentId/diaries", (request, reply) => {
    reply.header("cache-control", "no-store");
    const { agentId } = agentParams.parse(request.params);
    const query = z
      .strictObject({ month: DiaryMonthSchema.optional() })
      .parse(request.query);
    return { entries: service.list(agentId, query.month) };
  });
  app.post("/api/agents/:agentId/diaries", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const { agentId } = agentParams.parse(request.params);
    return {
      entry: await service.generate(
        agentId,
        GenerateDiaryInputSchema.parse(request.body),
      ),
    };
  });
  app.get(
    "/api/agents/:agentId/diaries/:entryDate/sources",
    (request, reply) => {
      reply.header("cache-control", "no-store");
      const { agentId, entryDate } = z
        .strictObject({ agentId: EntityIdSchema, entryDate: DiaryDateSchema })
        .parse(request.params);
      return service.sources(agentId, entryDate);
    },
  );
}
