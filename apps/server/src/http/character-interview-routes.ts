import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  CharacterInterviewCompileRequestSchema,
  CharacterInterviewFollowUpsRequestSchema,
} from "@personasim/contracts";
import { CharacterInterviewService } from "../services/character-interview-service.js";
import type { RouteServices } from "./routes.js";

export function registerCharacterInterviewRoutes(
  app: FastifyInstance,
  deps: Pick<RouteServices, "characters" | "llm" | "store" | "actors">,
): void {
  const interviews = new CharacterInterviewService(
    deps.characters,
    deps.llm,
    deps.store,
  );
  app.post("/api/characters/interview/follow-ups", (request) => {
    const { answers } = CharacterInterviewFollowUpsRequestSchema.parse(
      request.body,
    );
    return interviews.followUps(answers);
  });
  app.post("/api/characters/interview/compile", async (request, reply) => {
    const input = CharacterInterviewCompileRequestSchema.parse(request.body);
    const compile = () => interviews.compile(input);
    const result =
      input.characterId || input.requestId
        ? await deps.actors.runExclusive(
            input.characterId ?? `interview:${input.requestId}`,
            compile,
          )
        : await compile();
    return reply.code(input.characterId ? 200 : 201).send(result);
  });
  app.get("/api/characters/:id/creation-preview", (request) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    return interviews.preview(id);
  });
}
