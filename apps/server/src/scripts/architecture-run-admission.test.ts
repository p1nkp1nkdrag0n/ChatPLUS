import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import * as configuration from "../config.js";
import * as steering from "./reply-steering-runner.js";
import { CONTINUITY_WORKSPACE_ROOT } from "./continuity-run-identity.js";
import { runArchitectureEvaluation } from "./architecture-evaluation.js";
import { runArchitectureTimestampValidation } from "./architecture-timestamp-validation.js";
import { admitArchitectureOutput } from "./architecture-run-admission.js";

const testRoot = resolve(
  CONTINUITY_WORKSPACE_ROOT,
  "tmp",
  `architecture-admission-test-${randomUUID()}`,
);
let readDeployment: MockInstance<typeof configuration.readConfig>;
let readProfile: MockInstance<typeof steering.resolveSteeringProfile>;
let network: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // Fail even if the developer has a working private .env; offline entry points
  // must use their fixed config instead of consulting deployment/profile data.
  readDeployment = vi
    .spyOn(configuration, "readConfig")
    .mockImplementation(() => {
      throw new Error("Private deployment config must not be read offline");
    });
  readProfile = vi
    .spyOn(steering, "resolveSteeringProfile")
    .mockImplementation(() => {
      throw new Error("Private model profile must not be read offline");
    });
  network = vi.fn(() => Promise.reject(new Error("Real network is forbidden")));
  vi.stubGlobal("fetch", network);
  vi.stubEnv("RUN_PAID_ARCHITECTURE_EVAL", "");
  vi.stubEnv("LLM_ACTIVE_PROFILE", "missing-private-profile");
  vi.stubEnv("LLM_PROFILE_BIGMODEL_BASE_URL", undefined);
  vi.stubEnv("LLM_PROFILE_BIGMODEL_MODEL", undefined);
  vi.stubEnv("LLM_PROFILE_BIGMODEL_API_KEY", undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  const inside = relative(resolve(CONTINUITY_WORKSPACE_ROOT, "tmp"), testRoot);
  if (!inside || inside.startsWith("..") || isAbsolute(inside))
    throw new Error("Invalid test cleanup directory");
  rmSync(testRoot, { recursive: true, force: true });
});

function assertOffline() {
  expect(readDeployment).not.toHaveBeenCalled();
  expect(readProfile).not.toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled();
}

describe("architecture CLI admission and offline isolation", () => {
  it.each(["fixture", "preflight"] as const)(
    "runs the %s primary entry without private profiles or network",
    async (mode) => {
      const output = join(testRoot, mode);
      const result = await runArchitectureEvaluation({
        output,
        fixture: mode === "fixture",
        preflightOnly: mode === "preflight",
        probeIds: ["P04"],
        diagnostics: false,
        repeats: 1,
      });
      expect(result).toMatchObject(
        mode === "fixture" ? { completed: 6 } : { preflight: 2 },
      );
      expect(readFileSync(join(output, "manifest.json"), "utf8")).toContain(
        "offline-architecture",
      );
      assertOffline();
    },
    30_000,
  );

  it("runs all twelve timestamp fixtures without private profiles or network", async () => {
    const result = await runArchitectureTimestampValidation({
      output: join(testRoot, "timestamp"),
      fixture: true,
    });
    expect(result).toHaveLength(12);
    expect(result.every((row) => !row["error"])).toBe(true);
    assertOffline();
  }, 30_000);

  const entries = [
    { name: "primary", run: runArchitectureEvaluation },
    { name: "timestamp", run: runArchitectureTimestampValidation },
  ];

  it.each(entries)(
    "$name rejects paid mode before writing or reading config",
    async ({ run }) => {
      const output = join(testRoot, "paid");
      await expect(run({ output })).rejects.toThrow(
        "RUN_PAID_ARCHITECTURE_EVAL=1",
      );
      expect(existsSync(output)).toBe(false);
      assertOffline();
    },
  );

  it.each(entries)(
    "$name rejects outputs outside the workspace or Git ignore boundary before writing",
    async ({ run }) => {
      const paths = [
        CONTINUITY_WORKSPACE_ROOT,
        resolve(
          CONTINUITY_WORKSPACE_ROOT,
          "..",
          `architecture-outside-${randomUUID()}`,
        ),
        join(
          CONTINUITY_WORKSPACE_ROOT,
          "docs",
          `architecture-unignored-${randomUUID()}`,
        ),
      ];
      for (const output of paths) {
        await expect(run({ output, fixture: true })).rejects.toThrow(
          /inside the workspace|ignored by Git/u,
        );
        if (output !== CONTINUITY_WORKSPACE_ROOT)
          expect(existsSync(output)).toBe(false);
      }
      assertOffline();
    },
  );

  it("accepts a fresh ignored output without creating it and refuses existing output", () => {
    const output = join(testRoot, "fresh");
    expect(admitArchitectureOutput(output)).toBe(output);
    expect(existsSync(output)).toBe(false);
    mkdirSync(output, { recursive: true });
    expect(() => admitArchitectureOutput(output)).toThrow("Never overwrite");
  });
});
