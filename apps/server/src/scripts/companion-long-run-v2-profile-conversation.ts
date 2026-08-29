import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  atomicWriteMutableText,
  readTurnEvidence,
} from "./companion-long-run-v2-artifacts.js";
import {
  renderLongRunV2ProfileConversation,
  type LongRunV2ProfileConversationRepetition,
} from "./companion-long-run-v2-conversation.js";
import type { LongRunV2Profile } from "./companion-long-run-v2-run-types.js";

export interface LongRunV2ApprovedProfileRun {
  profile: LongRunV2Profile;
  repetition: 1 | 2 | 3;
  runDirectory: string;
}

export interface WriteLongRunV2ProfileConversationsOptions {
  matrixDirectory: string;
  profiles: readonly LongRunV2Profile[];
  repetitions: readonly (1 | 2 | 3)[];
  approvedRuns: readonly LongRunV2ApprovedProfileRun[];
  blockedProfiles?: ReadonlySet<LongRunV2Profile>;
}

/**
 * Refreshes the paid-matrix transcript for each profile that has produced a
 * run artifact (or was blocked during the Pilot stage). Other profile-level
 * artifacts are deliberately left untouched.
 */
export async function writeLongRunV2ProfileConversations(
  options: WriteLongRunV2ProfileConversationsOptions,
): Promise<string[]> {
  const outputPaths: string[] = [];
  for (const profile of options.profiles) {
    const approvedRuns = options.approvedRuns.filter(
      (run) => run.profile === profile,
    );
    const approvedPilot = approvedRuns.find((run) => run.repetition === 1);
    const pilotBlocked =
      (options.blockedProfiles?.has(profile) ?? false) ||
      (approvedPilot !== undefined &&
        (await hasFailedPilotGate(approvedPilot.runDirectory)));
    const inspected = await Promise.all(
      options.repetitions.map(async (repetition) => {
        const approved = approvedRuns.find(
          (run) => run.repetition === repetition,
        );
        const evidencePath =
          approved === undefined
            ? undefined
            : resolve(approved.runDirectory, "turn-evidence.jsonl");
        const evidenceExists =
          evidencePath !== undefined && (await isFile(evidencePath));
        const item: LongRunV2ProfileConversationRepetition = evidenceExists
          ? {
              repetition,
              status: "available",
              evidence: await readTurnEvidence(evidencePath),
            }
          : {
              repetition,
              status:
                approved === undefined && pilotBlocked ? "blocked" : "missing",
              evidence: [],
            };
        return { item, approved: approved !== undefined };
      }),
    );
    if (!pilotBlocked && !inspected.some((entry) => entry.approved)) {
      continue;
    }
    const outputPath = resolve(
      options.matrixDirectory,
      "profiles",
      profile,
      "conversation.md",
    );
    await atomicWriteMutableText(
      outputPath,
      renderLongRunV2ProfileConversation({
        profile,
        repetitions: inspected.map((entry) => entry.item),
      }),
    );
    outputPaths.push(outputPath);
  }
  return outputPaths;
}

async function hasFailedPilotGate(runDirectory: string): Promise<boolean> {
  const path = resolve(runDirectory, "pilot-gate.json");
  if (!(await isFile(path))) return false;
  const gate = JSON.parse(await readFile(path, "utf8")) as {
    eligibleForClosedLoop?: boolean;
  };
  return gate.eligibleForClosedLoop === false;
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (value) => value.isFile(),
    (error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") return false;
      throw error;
    },
  );
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
