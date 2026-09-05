import { type AutobiographyRevisionProposal } from "@personasim/contracts";
import { StructuredOutputError } from "@personasim/providers";
import { describe, expect, it } from "vitest";

import {
  messageEvidence,
  type VerifiedContinuityEvidence,
} from "./autobiography-service.js";
import {
  CheckpointAutobiographyError,
  LlmCheckpointAutobiographyModel,
} from "./checkpoint-autobiography-model.js";
import type { CheckpointAutobiographyModelInput } from "./checkpoint-service.js";
import type { ArchivedMessage } from "./continuity-repository.js";
import type { GenerateObjectInput } from "./llm-service.js";

const messages: ArchivedMessage[] = [
  {
    id: "message_user",
    sessionId: "session",
    agentId: "agent",
    role: "user",
    messageKind: "user",
    content: "我说错了，画画是在周二，不是周四。",
    createdAtUtc: "2026-08-21T04:00:00.000Z",
  },
  {
    id: "message_character",
    sessionId: "session",
    agentId: "agent",
    role: "assistant",
    messageKind: "assistant_reply",
    content: "我刚剪完粗剪，明天 UTC 04:00 想再检查一次粗剪。",
    createdAtUtc: "2026-08-21T04:01:00.000Z",
  },
];
const evidence = messages.map(messageEvidence);
const modelInput: CheckpointAutobiographyModelInput = {
  agentId: "agent",
  sessionId: "session",
  checkpointId: "checkpoint",
  messages,
  evidence,
};
const activity: VerifiedContinuityEvidence = {
  id: "evidence_activity",
  sourceType: "activity_event",
  sourceId: "activity",
  quote: "完成了公园跑步。",
  text: "完成了公园跑步。",
  reliability: "fact",
  temporalStatus: "occurred",
  recordedAtUtc: "2026-08-21T05:00:00.000Z",
};

function draft(override: Record<string, unknown> = {}) {
  return {
    summaryFirstPerson: "林舟把画画时间从周四更正为周二。",
    entries: [
      {
        entryKind: "important_experience",
        content: "林舟把画画时间从周四更正为周二。",
        temporalStatus: "unknown",
        evidenceIds: [evidence[0]!.id],
        ...override,
      },
    ],
  };
}

function model(output: unknown) {
  return modelSequence([output]);
}

function promptData(prompt: string): {
  evidence: unknown;
  messages: unknown;
  repair?: { attempt: number; issues: string[] };
} {
  return JSON.parse(prompt) as ReturnType<typeof promptData>;
}

function modelSequence(outputs: readonly unknown[]) {
  const calls: GenerateObjectInput<unknown>[] = [];
  return {
    calls,
    model: new LlmCheckpointAutobiographyModel({
      generateObject<T>(input: GenerateObjectInput<T>): Promise<T> {
        calls.push(input);
        const output = outputs[Math.min(calls.length - 1, outputs.length - 1)];
        if (output instanceof Error) return Promise.reject(output);
        return Promise.resolve(input.schema.parse(output));
      },
    }),
  };
}

describe("checkpoint autobiography model boundary", () => {
  it("repairs an unknown evidence ID once against the unchanged catalog", async () => {
    const runner = modelSequence([
      draft({ evidenceIds: ["invented_id"] }),
      draft(),
    ]);
    const proposal = await runner.model.generateAutobiography(modelInput);
    expect(proposal.entries[0]!.evidence[0]!.id).toBe(evidence[0]!.id);
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls.map((call) => call.maxRetries)).toEqual([0, 0]);
    const first = promptData(runner.calls[0]!.prompt);
    const second = promptData(runner.calls[1]!.prompt);
    expect(second.evidence).toEqual(first.evidence);
    expect(second.messages).toEqual(first.messages);
    expect(first.repair).toBeUndefined();
    expect(second.repair).toMatchObject({
      attempt: 2,
      issues: ["evidence_not_found: invented_id"],
    });
  });

  it("uses the same single repair budget for provider schema errors", async () => {
    const runner = modelSequence([
      new StructuredOutputError("Invalid DTO", [
        "entries.0: evidenceIds required",
      ]),
      draft(),
    ]);
    await expect(
      runner.model.generateAutobiography(modelInput),
    ).resolves.toBeDefined();
    expect(runner.calls).toHaveLength(2);
    expect(promptData(runner.calls[1]!.prompt).repair!.issues).toEqual([
      "INVALID_STRUCTURED_OUTPUT: entries.0: evidenceIds required",
    ]);
  });

  it("stops after the one repair and preserves structured semantic failure details", async () => {
    const runner = model(draft({ evidenceIds: ["invented_id"] }));
    await expect(
      runner.model.generateAutobiography(modelInput),
    ).rejects.toMatchObject({
      name: "CheckpointAutobiographyError",
      failureCode: "artifact_validation_failed",
      attemptCount: 2,
      issues: ["evidence_not_found: invented_id"],
    });
    expect(runner.calls).toHaveLength(2);
  });

  it("does not spend a semantic repair on a transport failure", async () => {
    const runner = model(new Error("HTTP 429"));
    await expect(
      runner.model.generateAutobiography(modelInput),
    ).rejects.toMatchObject({
      failureCode: "generation_failed",
      attemptCount: 1,
      issues: ["HTTP 429"],
    });
    expect(runner.calls).toHaveLength(1);
  });

  it("preserves attempt count when transport fails during the one repair", async () => {
    const runner = modelSequence([
      draft({ evidenceIds: ["invented_id"] }),
      new Error("Timed out"),
    ]);
    await expect(
      runner.model.generateAutobiography(modelInput),
    ).rejects.toMatchObject({
      failureCode: "generation_failed",
      attemptCount: 2,
      issues: ["Timed out"],
    });
    expect(runner.calls).toHaveLength(2);
  });

  it("bounds repair diagnostics without replaying a rejected autobiography", async () => {
    const runner = modelSequence([
      new CheckpointAutobiographyError(
        "artifact_validation_failed",
        1,
        Array.from({ length: 30 }, () => "failure".repeat(200)),
      ),
      draft(),
    ]);
    await runner.model.generateAutobiography(modelInput);
    const repair = promptData(runner.calls[1]!.prompt).repair!;
    expect(repair.issues).toHaveLength(12);
    expect(repair.issues.every((issue) => issue.length <= 400)).toBe(true);
    expect(repair).not.toHaveProperty("previousProposal");
  });

  it("restores the exact catalog references and attributes reported corrections to the user", async () => {
    const runner = model(draft());
    const proposal = await runner.model.generateAutobiography(modelInput);
    expect(proposal.entries[0]).toEqual({
      entryKind: "important_experience",
      content: "对方曾在对话中提到：林舟把画画时间从周四更正为周二。",
      temporalStatus: "unknown",
      evidence: [
        {
          id: evidence[0]!.id,
          sourceType: "message_archive",
          sourceId: "message_user",
          quote: messages[0]!.content,
          reliability: "reported",
          temporalStatus: "unknown",
          recordedAtUtc: messages[0]!.createdAtUtc,
        },
      ],
    });
    expect(proposal.summaryFirstPerson).toBe(
      "我记得这些记录中提到：林舟把画画时间从周四更正为周二。",
    );
    expect(runner.calls[0]!.system).toContain(
      "不证明话中涉及的外部事情真的发生",
    );
    expect(JSON.parse(runner.calls[0]!.prompt)).toMatchObject({
      outputContractVersion: "checkpoint_evidence_ids_v1",
      messages: [{ role: "user" }, { role: "assistant" }],
    });
  });

  it("keeps a character's self-report attributed and unverified", async () => {
    const output = draft({
      content: "我在对话中提到刚剪完粗剪。",
      evidenceIds: [evidence[1]!.id],
    });
    output.summaryFirstPerson = "我在对话中提到刚剪完粗剪。";
    const proposal =
      await model(output).model.generateAutobiography(modelInput);
    expect(proposal.entries[0]!.content).toBe(
      "我曾在对话中提到：我在对话中提到刚剪完粗剪。",
    );
    expect(proposal.entries[0]!.temporalStatus).toBe("unknown");
    expect(proposal.entries[0]!.evidence[0]!.reliability).toBe("reported");
  });

  it("retains planned status and explicit plan dates without promoting the report", async () => {
    const output = draft({
      entryKind: "commitment",
      content: "我计划明天检查粗剪。",
      temporalStatus: "planned",
      fromUtc: "2026-08-22T04:00:00.000Z",
      evidenceIds: [evidence[1]!.id],
    });
    output.summaryFirstPerson = "我计划明天检查粗剪。";
    const proposal =
      await model(output).model.generateAutobiography(modelInput);
    expect(proposal.entries[0]).toMatchObject({
      content: "我曾在对话中提到：我计划明天检查粗剪。",
      temporalStatus: "planned",
      fromUtc: "2026-08-22T04:00:00.000Z",
      evidence: [{ reliability: "reported", temporalStatus: "unknown" }],
    });
  });

  it.each(["occurred", "in_progress"])(
    "rejects %s for a message-only catalog instead of changing its status",
    async (temporalStatus) => {
      await expect(
        model(draft({ temporalStatus })).model.generateAutobiography(
          modelInput,
        ),
      ).rejects.toThrow();
    },
  );

  it("rejects using a recording timestamp as an unknown event's date", async () => {
    await expect(
      model(
        draft({ fromUtc: messages[0]!.createdAtUtc }),
      ).model.generateAutobiography(modelInput),
    ).rejects.toThrow(
      "Unknown events must not borrow the message recording time",
    );
  });

  it.each([
    { evidenceIds: ["invented_id"] },
    { evidenceIds: [evidence[0]!.id, evidence[0]!.id] },
    { evidence: [{ id: evidence[0]!.id, reliability: "fact" }] },
    { sourceId: "forged_source" },
    { recordedAtUtc: "2000-01-01T00:00:00.000Z" },
  ])(
    "rejects unknown IDs or model-authored evidence metadata: %j",
    async (fields) => {
      await expect(
        model(draft(fields)).model.generateAutobiography(modelInput),
      ).rejects.toThrow();
    },
  );

  it.each(["occurred", "in_progress"])(
    "requires occurrence evidence on the particular %s entry",
    async (temporalStatus) => {
      await expect(
        model(draft({ temporalStatus })).model.generateAutobiography({
          ...modelInput,
          evidence: [...evidence, activity],
        }),
      ).rejects.toThrow(`${temporalStatus}_without_occurrence_evidence`);
    },
  );

  it("accepts a supported occurred event and retains authoritative evidence and timing", async () => {
    const output = draft({
      content: "我完成了公园跑步。",
      temporalStatus: "occurred",
      evidenceIds: [activity.id],
      fromUtc: activity.recordedAtUtc,
    });
    output.summaryFirstPerson = "我完成了公园跑步。";
    const proposal: AutobiographyRevisionProposal = await model(
      output,
    ).model.generateAutobiography({
      ...modelInput,
      evidence: [...evidence, activity],
    });
    expect(proposal.summaryFirstPerson).toBe("我完成了公园跑步。");
    expect(proposal.entries[0]).toMatchObject({
      content: "我完成了公园跑步。",
      temporalStatus: "occurred",
      fromUtc: activity.recordedAtUtc,
      evidence: [
        { id: activity.id, reliability: "fact", temporalStatus: "occurred" },
      ],
    });
  });

  it("checks lexical grounding before adding common reporting words", async () => {
    const output = draft({ content: "月球采矿。" });
    output.summaryFirstPerson = "月球采矿。";
    const unrelated = {
      ...evidence[0]!,
      text: "对话中提到公园。",
      quote: "对话中提到公园。",
    };
    await expect(
      model(output).model.generateAutobiography({
        ...modelInput,
        evidence: [unrelated],
      }),
    ).rejects.toThrow("entry_not_grounded");
  });
});
