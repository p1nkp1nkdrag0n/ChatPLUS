import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { readConfig } from "../config.js";
import type { LlmLogicalCallEvent } from "../services/llm-service.js";
import { HostedControlStore } from "./control-store.js";
import type { HostedModelGateway } from "./model-gateway.js";
import { HostedRuntimeManager } from "./runtime-manager.js";

describe("hosted account name prompt binding", () => {
  it("binds each cached tenant runtime to its account display name, excluding routing identifiers", async () => {
    const root = mkdtempSync(join(tmpdir(), "dearvale-prompt-identity-"));
    const control = new HostedControlStore(root);
    const loggerApp = Fastify({ logger: false });
    const calls = new Map<string, LlmLogicalCallEvent[]>();
    const manager = new HostedRuntimeManager({
      rootDirectory: root,
      control,
      logger: loggerApp.log,
      startSchedulers: false,
      baseConfig: readConfig({
        nodeEnv: "test",
        databasePath: ":memory:",
        seedDemo: false,
        keepsakeMode: "off",
        correspondenceMode: "off",
        proactiveMode: "off",
        autobiographyMode: "off",
        lifePlanningMode: "fuzzy",
        llm: {
          provider: "fixture",
          model: "fixture",
          baseUrl: "https://example.invalid",
          timeoutMs: 1000,
          maxRetries: 0,
        },
      }),
      // Keep the real tenant composition and services, substituting only model
      // transport with the built-in fixture provider and logical-call observer.
      gateway: {
        forUser: (userId: string) => ({
          onLogicalCall: (event: LlmLogicalCallEvent) => {
            calls.set(userId, [...(calls.get(userId) ?? []), event]);
          },
        }),
      } as unknown as HostedModelGateway,
    });
    try {
      const admin = control.createAdministrator("admin", "fixture-password");
      control.setLimits({ registrationEnabled: true }, admin.id);
      const invite = control.createInvite({ maxUses: 2 }, admin.id);
      const users = ["圆圆", "小满"].map((username) =>
        control.registerUser({
          username,
          passwordHash: "fixture-password",
          inviteCode: invite.code,
          consentVersion: "2026-09",
        }),
      );
      for (const user of users) {
        const runtime = await manager.get(user.id);
        expect(await manager.get(user.id)).toBe(runtime);
        const services = runtime.composition.routeServices;
        const character = services.characters.publish(
          services.characters.createDemoCharacter().id,
        );
        const session = services.conversations.createSession(character.id);
        await services.conversations.chat(session.id, {
          agentId: character.id,
          clientMessageId: `identity-${user.id}`,
          text: "你好，今天过得怎么样？",
        });
        const chat = calls
          .get(user.id)
          ?.find(
            (event) =>
              event.stage === "started" && event.purpose === "chat_turn",
          );
        expect(chat?.stage).toBe("started");
        if (chat?.stage !== "started")
          throw new Error("Chat prompt was not observed");
        expect(chat.prompt).toContain(
          JSON.stringify({ displayName: user.username }),
        );
        expect(chat.system).toContain("do not repeat it in every reply");
        expect(chat.prompt).not.toContain(user.accountName);
        expect(chat.prompt).not.toContain(user.id);
        const other = users.find((item) => item.id !== user.id)!;
        expect(chat.prompt).not.toContain(other.username);
      }
    } finally {
      await manager.close();
      await loggerApp.close();
      control.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
