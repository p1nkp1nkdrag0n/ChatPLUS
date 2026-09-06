import { createHash } from "node:crypto";

import type { LLMChatMessage } from "@personasim/contracts";

export const LLM_PROMPT_LAYOUT_VERSION = "stable-prefix-v1";

/** Diagnostic character counts describe our messages JSON, never billed tokens. */
export interface LlmPromptDiagnostics {
  layoutVersion: typeof LLM_PROMPT_LAYOUT_VERSION;
  serialization: "messages-json-v1";
  messagesSha256: string;
  serializedCharacters: number;
  responseFormatSha256?: string;
  messages: {
    index: number;
    role: LLMChatMessage["role"];
    contentSha256: string;
    characters: number;
  }[];
  comparison: "previous_same_purpose" | "no_baseline" | "size_limit";
  commonPrefixCharacters?: number;
  firstChangedMessageIndex?: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Opt-in, per-provider, bounded diagnostic state. Only hashes, roles and sizes
 * escape to telemetry. Baselines stay in memory and reset on provider restart;
 * they never represent the vendor's cache state or TTL.
 */
export class PromptDiagnosticsTracker {
  readonly #previous = new Map<
    string,
    { serialized: string; messageHashes: string[] }
  >();

  constructor(
    readonly maximumPurposes = 16,
    readonly maximumCharacters = 256_000,
  ) {
    if (
      !Number.isSafeInteger(maximumPurposes) ||
      maximumPurposes < 1 ||
      !Number.isSafeInteger(maximumCharacters) ||
      maximumCharacters < 1
    ) {
      throw new TypeError("Prompt diagnostic bounds must be positive integers");
    }
  }

  observe(
    purpose: string,
    messages: readonly LLMChatMessage[],
    responseFormat?: unknown,
  ): LlmPromptDiagnostics {
    const serialized = JSON.stringify(messages);
    const messageHashes = messages.map((message) =>
      sha256(JSON.stringify(message)),
    );
    const previous = this.#previous.get(purpose);
    const withinLimit = serialized.length <= this.maximumCharacters;
    const result: LlmPromptDiagnostics = {
      layoutVersion: LLM_PROMPT_LAYOUT_VERSION,
      serialization: "messages-json-v1",
      messagesSha256: sha256(serialized),
      serializedCharacters: serialized.length,
      ...(responseFormat === undefined
        ? {}
        : { responseFormatSha256: sha256(JSON.stringify(responseFormat)) }),
      messages: messages.map((message, index) => ({
        index,
        role: message.role,
        contentSha256: sha256(message.content),
        characters: message.content.length,
      })),
      comparison: !withinLimit
        ? "size_limit"
        : previous === undefined
          ? "no_baseline"
          : "previous_same_purpose",
    };
    if (withinLimit && previous !== undefined) {
      let prefix = 0;
      const length = Math.min(serialized.length, previous.serialized.length);
      while (
        prefix < length &&
        serialized.charCodeAt(prefix) === previous.serialized.charCodeAt(prefix)
      )
        prefix += 1;
      result.commonPrefixCharacters = prefix;
      const changedIndex = messageHashes.findIndex(
        (hash, index) => hash !== previous.messageHashes[index],
      );
      if (changedIndex !== -1) result.firstChangedMessageIndex = changedIndex;
      else if (messageHashes.length !== previous.messageHashes.length)
        result.firstChangedMessageIndex = messageHashes.length;
    }
    this.#previous.delete(purpose);
    if (withinLimit) {
      this.#previous.set(purpose, { serialized, messageHashes });
      if (this.#previous.size > this.maximumPurposes) {
        const oldest = this.#previous.keys().next().value;
        if (oldest !== undefined) this.#previous.delete(oldest);
      }
    }
    return result;
  }
}
