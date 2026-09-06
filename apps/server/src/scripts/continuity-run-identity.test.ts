import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { readConfig } from "../config.js";
import {
  continuityHash,
  continuityRunIdentity,
  freezeContinuityManifest,
} from "./continuity-run-identity.js";

const config = readConfig({
  nodeEnv: "test",
  profile: "test",
  seedDemo: false,
  llm: {
    provider: "fixture",
    model: "fixture",
    baseUrl: "https://fixture.invalid",
    timeoutMs: 1000,
    maxRetries: 0,
  },
});
const base = {
  config,
  git: { revision: "frozen", dirty: false },
  lockSha256: "lock",
  experiment: {
    scenario: "scenario",
    oracleSha256: "oracle",
    requestBudget: 50,
  },
};

describe("continuity experiment identity", () => {
  it("fences both switches, actual retention, model policy, code, lock and evaluation inputs", () => {
    const expected = continuityHash(continuityRunIdentity(base));
    const variations = [
      {
        ...base,
        config: {
          ...config,
          companionContextMode:
            config.companionContextMode === "off"
              ? ("enforced" as const)
              : ("off" as const),
        },
      },
      {
        ...base,
        config: {
          ...config,
          personaRuntimeMode:
            config.personaRuntimeMode === "off"
              ? ("enforced" as const)
              : ("off" as const),
        },
      },
      {
        ...base,
        config: {
          ...config,
          conversationRetention: {
            ...config.conversationRetention,
            softTokenLimit: 1001,
          },
        },
      },
      { ...base, config: { ...config, llm: { ...config.llm, maxRetries: 2 } } },
      { ...base, git: { revision: "other", dirty: false } },
      {
        ...base,
        git: { revision: "frozen", dirty: true, dirtyPatchSha256: "changed" },
      },
      { ...base, lockSha256: "changed" },
      { ...base, experiment: { ...base.experiment, oracleSha256: "changed" } },
      { ...base, experiment: { ...base.experiment, requestBudget: 100 } },
    ];
    for (const variation of variations)
      expect(continuityHash(continuityRunIdentity(variation))).not.toBe(
        expected,
      );
  });

  it("retains numeric token limits without exposing credentials or instance secrets", () => {
    const first = continuityRunIdentity({
      ...base,
      config: {
        ...config,
        instanceSecret: "secret-first",
        llm: { ...config.llm, apiKey: "key-first", maxOutputTokens: 8192 },
      },
    });
    const second = continuityRunIdentity({
      ...base,
      config: {
        ...config,
        instanceSecret: "secret-second",
        llm: { ...config.llm, apiKey: "key-second", maxOutputTokens: 8192 },
      },
    });
    expect(continuityHash(first)).toBe(continuityHash(second));
    expect(JSON.stringify(first)).not.toMatch(/secret-first|key-first/);
    expect(JSON.stringify(first)).toContain('"maxOutputTokens":8192');
  });

  it("never rewrites a frozen manifest when resuming or rejects a changed identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "continuity-identity-"));
    try {
      const path = join(directory, "manifest.json");
      await freezeContinuityManifest(path, base.experiment, false);
      const original = await readFile(path, "utf8");
      await freezeContinuityManifest(path, base.experiment, true);
      await expect(
        freezeContinuityManifest(path, { scenario: "other" }, true),
      ).rejects.toThrow("identity_mismatch");
      await expect(
        freezeContinuityManifest(path, base.experiment, false),
      ).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe(original);
    } finally {
      const contained = relative(resolve(tmpdir()), resolve(directory));
      if (
        contained.startsWith("..") ||
        !contained.startsWith("continuity-identity-")
      )
        throw new Error("Unexpected cleanup path");
      await rm(directory, { recursive: true, force: true });
    }
  });
});
