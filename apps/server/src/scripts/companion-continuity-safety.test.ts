import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { DatabaseStore } from "../db/store.js";
import { ContinuityScenarioSchema } from "./companion-continuity-input.js";
import {
  verifyContinuityBaseline,
  verifyContinuityResume,
  withContinuityRunLock,
} from "./companion-continuity-safety.js";
import {
  buildGuLanCharacterSpec,
  createCompanionLongRunV2Baseline,
  LONG_RUN_V2_SESSION_ID,
  sha256File,
} from "./companion-long-run-v2-baseline.js";
import {
  CONTINUITY_WORKSPACE_ROOT,
  continuityHash,
} from "./continuity-run-identity.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    const contained = relative(resolve(tmpdir()), resolve(directory));
    if (
      !contained.startsWith("continuity-safety-") ||
      contained.startsWith("..")
    )
      throw new Error("Unsafe temporary cleanup path");
    await rm(directory, { recursive: true, force: true });
  }
});
async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), "continuity-safety-"));
  directories.push(directory);
  return directory;
}
async function baseline(directory: string) {
  const path = join(directory, "baseline.sqlite");
  await createCompanionLongRunV2Baseline(path);
  const character = buildGuLanCharacterSpec();
  await writeFile(
    join(directory, "baseline-character.json"),
    JSON.stringify(character),
  );
  await refreshManifest(directory);
  return character;
}
async function refreshManifest(directory: string) {
  const character = JSON.parse(
    await readFile(join(directory, "baseline-character.json"), "utf8"),
  ) as ReturnType<typeof buildGuLanCharacterSpec>;
  await writeFile(
    join(directory, "baseline-manifest.json"),
    JSON.stringify({
      characterId: character.id,
      version: character.version,
      characterSha256: continuityHash(character),
      databaseSha256: await sha256File(join(directory, "baseline.sqlite")),
    }),
  );
}

describe("continuity run ownership", () => {
  it("excludes concurrent work and releases after failure", async () => {
    const directory = join(await temporary(), "new-run");
    await expect(
      withContinuityRunLock(directory, async () => {
        await expect(
          withContinuityRunLock(directory, () =>
            Promise.resolve("should not run"),
          ),
        ).rejects.toThrow("already_locked");
        throw new Error("intentional_failure");
      }),
    ).rejects.toThrow("intentional_failure");
    await expect(
      withContinuityRunLock(directory, () => Promise.resolve("released")),
    ).resolves.toBe("released");
  });

  it("does not erase a diagnostic owner record with another token", async () => {
    const directory = join(await temporary(), "new-run");
    await withContinuityRunLock(directory, async () => {
      await writeFile(
        `${directory}.run-lock.owner.json`,
        JSON.stringify({ pid: process.pid, token: "other-owner" }),
      );
    });
    expect(
      JSON.parse(await readFile(`${directory}.run-lock.owner.json`, "utf8")),
    ).toMatchObject({ token: "other-owner" });
  });

  it("recovers the OS lease after killing its owner process", async () => {
    const directory = join(await temporary(), "new-run");
    const moduleUrl = new URL(
      "./companion-continuity-safety.ts",
      import.meta.url,
    ).href;
    const script = `import { withContinuityRunLock } from ${JSON.stringify(moduleUrl)};
      await withContinuityRunLock(${JSON.stringify(directory)}, async () => {
        setInterval(() => {}, 1000); process.stdout.write('locked'); await new Promise(() => {});
      });`;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        cwd: CONTINUITY_WORKSPACE_ROOT,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    const exited = once(child, "exit");
    try {
      await Promise.race([
        once(child.stdout, "data"),
        exited.then(() => {
          throw new Error(`lock child exited before acquisition: ${stderr}`);
        }),
      ]);
      await expect(
        withContinuityRunLock(directory, () =>
          Promise.resolve("should not run"),
        ),
      ).rejects.toThrow("already_locked");
      child.kill();
      await exited;
      const oldOwner = JSON.parse(
        await readFile(`${directory}.run-lock.owner.json`, "utf8"),
      ) as { pid: number };
      expect(oldOwner.pid).toBe(child.pid);
      await withContinuityRunLock(directory, async () => {
        expect(
          JSON.parse(
            await readFile(`${directory}.run-lock.owner.json`, "utf8"),
          ),
        ).toMatchObject({ pid: process.pid });
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await exited;
      }
    }
  }, 15_000);
});

describe("uncontaminated baseline verification", () => {
  it("verifies a published consistent backup without mutating its bytes", async () => {
    const directory = await temporary();
    const character = await baseline(directory);
    const before = await sha256File(join(directory, "baseline.sqlite"));
    expect(await verifyContinuityBaseline(directory)).toMatchObject({
      character,
      characterSha256: continuityHash(character),
      databaseSha256: before,
    });
    expect(await sha256File(join(directory, "baseline.sqlite"))).toBe(before);
  });

  it.each(["database", "character", "published", "user_probe"] as const)(
    "rejects %s baseline contamination",
    async (change) => {
      const directory = await temporary();
      const character = await baseline(directory);
      if (change === "character") {
        await writeFile(
          join(directory, "baseline-character.json"),
          JSON.stringify({
            ...character,
            identity: { ...character.identity, name: "changed" },
          }),
        );
        await refreshManifest(directory);
      } else {
        const database = new BetterSqlite3(join(directory, "baseline.sqlite"));
        try {
          if (change === "published")
            database.prepare("UPDATE characters SET status = 'draft'").run();
          else if (change === "user_probe")
            new DatabaseStore(database).insertMessage({
              id: "probe",
              sessionId: LONG_RUN_V2_SESSION_ID,
              agentId: character.id,
              role: "user",
              messageKind: "user",
              content: "a contaminating probe",
              metadata: {},
              createdAtUtc: character.createdAtUtc,
            });
          else database.prepare("UPDATE sessions SET title = 'changed'").run();
        } finally {
          database.close();
        }
        if (change !== "database") await refreshManifest(directory);
      }
      await expect(verifyContinuityBaseline(directory)).rejects.toThrow(
        /continuity_baseline_/u,
      );
    },
  );
});

describe("completed turn resume verification", () => {
  it("checks database, fixed input and saved response before allowing a completed turn to be skipped", async () => {
    const directory = await temporary();
    const character = await baseline(directory);
    const scenario = ContinuityScenarioSchema.parse(
      JSON.parse(
        await readFile(
          join(
            CONTINUITY_WORKSPACE_ROOT,
            "docs/plans/ChatPLUS_Continuity_Review_and_Real_API_Test_Plan/ChatPLUS_Continuity_Review/03_scenario.public.json",
          ),
          "utf8",
        ),
      ),
    );
    const first = scenario.steps[0]!;
    const database = new BetterSqlite3(join(directory, "baseline.sqlite"));
    try {
      const store = new DatabaseStore(database);
      const journal = {
        completedTurns: 1,
        agentId: character.id,
        sessions: { [first.sessionKey]: LONG_RUN_V2_SESSION_ID },
      };
      const user = {
        id: "user_1",
        sessionId: LONG_RUN_V2_SESSION_ID,
        agentId: character.id,
        role: "user" as const,
        messageKind: "user" as const,
        content: first.userText,
        clientMessageId: first.clientMessageIdTemplate.replaceAll(
          "{runId}",
          "test-run",
        ),
        metadata: {},
        createdAtUtc: character.createdAtUtc,
      };
      const assistant = {
        id: "assistant_1",
        sessionId: LONG_RUN_V2_SESSION_ID,
        agentId: character.id,
        role: "assistant" as const,
        messageKind: "assistant_reply" as const,
        content: "test reply",
        inReplyToMessageId: user.id,
        metadata: {},
        createdAtUtc: character.createdAtUtc,
      };
      store.insertMessage(user);
      store.insertMessage(assistant);
      const tracePath = join(directory, "turn-001.json");
      const trace = {
        turn: 1,
        response: { userMessage: user, assistantMessage: assistant },
      };
      await writeFile(tracePath, JSON.stringify(trace));
      await verifyContinuityResume(
        database,
        journal,
        scenario,
        "test-run",
        directory,
      );
      await expect(
        verifyContinuityResume(
          database,
          journal,
          scenario,
          "other-run",
          directory,
        ),
      ).rejects.toThrow("database_mismatch");
      await expect(
        verifyContinuityResume(
          database,
          { ...journal, completedTurns: 121 },
          scenario,
          "test-run",
          directory,
        ),
      ).rejects.toThrow("invalid_resume_journal");
      await writeFile(
        tracePath,
        JSON.stringify({
          ...trace,
          response: {
            ...trace.response,
            assistantMessage: { ...assistant, id: "replaced" },
          },
        }),
      );
      await expect(
        verifyContinuityResume(
          database,
          journal,
          scenario,
          "test-run",
          directory,
        ),
      ).rejects.toThrow("trace_mismatch");
      await writeFile(tracePath, JSON.stringify(trace));
      database
        .prepare("UPDATE messages SET content = 'different input' WHERE id = ?")
        .run(user.id);
      await expect(
        verifyContinuityResume(
          database,
          journal,
          scenario,
          "test-run",
          directory,
        ),
      ).rejects.toThrow("database_mismatch");
      database
        .prepare("UPDATE messages SET content = ? WHERE id = ?")
        .run(user.content, user.id);
      database.prepare("DELETE FROM messages WHERE id = ?").run(assistant.id);
      await expect(
        verifyContinuityResume(
          database,
          journal,
          scenario,
          "test-run",
          directory,
        ),
      ).rejects.toThrow("database_mismatch");
    } finally {
      database.close();
    }
  });
});
