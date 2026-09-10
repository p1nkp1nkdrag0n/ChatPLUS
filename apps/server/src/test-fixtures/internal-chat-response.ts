import type { PersonaSimApp } from "../app.js";
import type { LightMyRequestResponse } from "fastify";
import type { SendMessageResponse } from "@personasim/contracts";
import {
  observeEvaluationTurns,
  readEvaluationTurn,
} from "../scripts/evaluation-turn-evidence.js";

/** Business integration tests may inspect separately observed service evidence.
 * The real HTTP body/json remain the public response, including on failures. */
export async function injectInternalChat(
  app: PersonaSimApp,
  sessionId: string,
  payload: {
    agentId: string;
    clientMessageId: string;
    text: string;
    [key: string]: unknown;
  },
): Promise<LightMyRequestResponse & { internalTurn?: SendMessageResponse }> {
  observeEvaluationTurns(app);
  const response = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/messages`,
    payload,
  });
  if (response.statusCode < 200 || response.statusCode >= 300) return response;
  return Object.assign(response, {
    internalTurn: readEvaluationTurn(app, response.json()),
  });
}

export function internalChatJson<T>(response: {
  body: string;
  internalTurn?: unknown;
}): T {
  return response.internalTurn === undefined
    ? (JSON.parse(response.body) as T)
    : (response.internalTurn as T);
}
