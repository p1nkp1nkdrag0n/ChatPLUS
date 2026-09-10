import {
  PublicSendMessageResponseSchema,
  SendMessageResponseSchema,
  type SendMessageResponse,
} from "@personasim/contracts";
import type { PersonaSimApp } from "../app.js";

const observations = new WeakMap<
  PersonaSimApp,
  Map<string, SendMessageResponse>
>();

/** Offline evaluation instrumentation. Never registered by the HTTP application. */
export function observeEvaluationTurns(app: PersonaSimApp): void {
  if (observations.has(app)) return;
  const turns = new Map<string, SendMessageResponse>();
  observations.set(app, turns);
  const chat = app.personasim.conversations.chat.bind(
    app.personasim.conversations,
  );
  app.personasim.conversations.chat = async (...args) => {
    const result = await chat(...args);
    turns.set(
      result.assistantMessage.id,
      SendMessageResponseSchema.parse(result),
    );
    if (turns.size > 1_000) turns.delete(turns.keys().next().value!);
    return result;
  };
}

/** Validate the public wire response, then read separately captured server evidence. */
export function readEvaluationTurn(
  app: PersonaSimApp,
  publicBody: unknown,
): SendMessageResponse {
  const wire = PublicSendMessageResponseSchema.parse(publicBody);
  const result = observations.get(app)?.get(wire.assistantMessage.id);
  if (
    !result ||
    result.userMessage.id !== wire.userMessage.id ||
    result.assistantMessage.content !== wire.assistantMessage.content ||
    result.idempotentReplay !== wire.idempotentReplay
  ) {
    throw new Error(
      "The public chat response has no matching observed committed turn.",
    );
  }
  return result;
}
