import { StructuredOutputError } from "@personasim/providers";
import { projectPromptTemporalData } from "@personasim/features";
import { describe, expect, it } from "vitest";

import {
  messageEvidence,
  type VerifiedContinuityEvidence,
} from "./autobiography-service.js";
import {
  CheckpointAutobiographyError,
  LlmCheckpointAutobiographyModel,
} from "./checkpoint-autobiography-model.js";
import { checkpointReportExcerpts } from "./checkpoint-report-excerpts.js";
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
const excerpts = checkpointReportExcerpts(modelInput);
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
function report(fields: Record<string, unknown> = {}) {
  return {
    basis: "reported_excerpt",
    entryKind: "important_experience",
    temporalStatus: "unknown",
    excerptId: excerpts[0]!.id,
    ...fields,
  };
}
function fact(fields: Record<string, unknown> = {}) {
  return {
    basis: "evidence_summary",
    entryKind: "important_experience",
    content: "我完成了公园跑步。",
    temporalStatus: "occurred",
    evidenceIds: [activity.id],
    fromUtc: activity.recordedAtUtc,
    ...fields,
  };
}
function draft(fields: Record<string, unknown> = {}) {
  return { entries: [report(fields)] };
}
function promptData(prompt: string): {
  reportExcerpts: unknown;
  evidence: unknown;
  repair?: { attempt: number; issues: string[] };
} {
  return JSON.parse(prompt) as ReturnType<typeof promptData>;
}
function model(output: unknown) {
  return modelSequence([output]);
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

describe("checkpoint atomic report boundary", () => {
  it("restores the speaker and complete original correction without a model-written paraphrase", async () => {
    const runner = model(draft());
    const proposal = await runner.model.generateAutobiography(modelInput);
    expect(proposal.entries[0]).toEqual({
      entryKind: "important_experience",
      content: "对方在对话中说过：「" + messages[0]!.content + "」",
      temporalStatus: "unknown",
      evidence: [
        {
          id: evidence[0]!.id,
          sourceType: "message_archive",
          sourceId: messages[0]!.id,
          quote: messages[0]!.content,
          reliability: "reported",
          temporalStatus: "unknown",
          recordedAtUtc: messages[0]!.createdAtUtc,
        },
      ],
    });
    expect(proposal.summaryFirstPerson).toBe(proposal.entries[0]!.content);
    expect(JSON.parse(runner.calls[0]!.prompt)).toMatchObject({
      outputContractVersion: "checkpoint_atomic_reports_v2",
      reportExcerpts: [{ speaker: "user" }, { speaker: "character" }],
    });
  });

  it("keeps a character plan quoted and planned while leaving precision in the source text", async () => {
    const proposal = await model(
      draft({
        excerptId: excerpts[1]!.id,
        entryKind: "commitment",
        temporalStatus: "planned",
      }),
    ).model.generateAutobiography(modelInput);
    expect(proposal.entries[0]).toMatchObject({
      content: "我在对话中说过：「" + messages[1]!.content + "」",
      temporalStatus: "planned",
      evidence: [{ reliability: "reported", temporalStatus: "unknown" }],
    });
    expect(proposal.entries[0]).not.toHaveProperty("fromUtc");
  });

  it.each(["occurred", "in_progress"])(
    "never upgrades a reported utterance to %s",
    async (temporalStatus) => {
      await expect(
        model(draft({ temporalStatus })).model.generateAutobiography(
          modelInput,
        ),
      ).rejects.toThrow();
    },
  );

  it.each([
    { content: "成功" },
    { quote: "成功" },
    { speaker: "character" },
    { fromUtc: messages[0]!.createdAtUtc },
    { evidenceIds: [evidence[0]!.id] },
    { evidence: [{ id: evidence[0]!.id, reliability: "fact" }] },
  ])(
    "rejects model-authored report content, speaker or evidence fields: %j",
    async (fields) => {
      await expect(
        model(draft(fields)).model.generateAutobiography(modelInput),
      ).rejects.toThrow();
    },
  );

  it("rejects a free summary rather than allowing it to reintroduce unsupported conclusions", async () => {
    await expect(
      model({
        ...draft(),
        summaryFirstPerson: "我们因此彼此更贴近。",
      }).model.generateAutobiography(modelInput),
    ).rejects.toThrow();
  });

  it("rejects the actual live-probe mixed-speaker paraphrase even with valid evidence IDs", async () => {
    const bad = {
      entries: [
        fact({
          entryKind: "relationship_change",
          temporalStatus: "unknown",
          fromUtc: undefined,
          evidenceIds: [evidence[0]!.id, evidence[1]!.id],
          content:
            "对方说光闷头剪容易越剪越窄，他问我真实感受、我倒了心里话，他说挺受用；感觉这种互相倒苦水的交流让彼此更贴近。",
        }),
      ],
    };
    await expect(
      model(bad).model.generateAutobiography(modelInput),
    ).rejects.toThrow("message_requires_excerpt");
  });

  it("allows each speaker's actual relationship feelings without inventing a mutual change", async () => {
    const actualMessages = messages.map((message, index) => ({
      ...message,
      content:
        index === 0
          ? "听你提到《夜航》那段，我突然觉得那种“不敢停”的恐慌好像也没那么孤单了，至少有人懂这种感觉。"
          : "这两件事都没答案，先跟你倒出来了。你问这个我挺受用的，光闷头剪容易越剪越窄。",
    }));
    const input = {
      ...modelInput,
      messages: actualMessages,
      evidence: actualMessages.map(messageEvidence),
    };
    const units = checkpointReportExcerpts(input);
    const proposal = await model({
      entries: units.map((unit) =>
        report({ excerptId: unit.id, entryKind: "relationship_change" }),
      ),
    }).model.generateAutobiography(input);
    expect(proposal.entries.map((entry) => entry.content)).toEqual([
      "对方在对话中说过：「" + actualMessages[0]!.content + "」",
      "我在对话中说过：「" + actualMessages[1]!.content + "」",
    ]);
    expect(proposal.summaryFirstPerson).not.toContain("彼此更贴近");
    expect(
      proposal.entries.every(
        (entry) =>
          entry.entryKind === "relationship_change" &&
          entry.temporalStatus === "unknown",
      ),
    ).toBe(true);
  });

  it.each([
    "我没有成功。",
    "如果周二有空，我才会去。现在还没决定。",
    "朋友说：\n\n“我终于完成了。”\n\n这是她的经历，不是我的。",
    "我成功了。\n\n不，刚才是引用别人的原话，我没有成功。",
  ])(
    "does not offer partial excerpts that remove negation, conditions or quotation frames: %s",
    async (content) => {
      const original = { ...messages[0]!, content };
      const input = {
        ...modelInput,
        messages: [original],
        evidence: [messageEvidence(original)],
      };
      const units = checkpointReportExcerpts(input);
      expect(units).toHaveLength(1);
      expect(units[0]!.text).toBe(content);
      const proposal = await model(
        draft({ excerptId: units[0]!.id }),
      ).model.generateAutobiography(input);
      expect(proposal.entries[0]!.content).toBe(
        "对方在对话中说过：「" + content + "」",
      );
    },
  );

  it("rejects duplicate excerpt use across different categories", async () => {
    await expect(
      model({
        entries: [report(), report({ entryKind: "relationship_change" })],
      }).model.generateAutobiography(modelInput),
    ).rejects.toThrow("duplicate_report_excerpt");
  });

  it("selects the latest complete entries within the summary budget", async () => {
    const originals = [0, 1, 2].map((index) => ({
      ...messages[0]!,
      id: "message_" + index,
      content: String(index).repeat(1100) + "如果前提不成立，我不会去。",
      createdAtUtc: "2026-08-21T0" + (index + 4) + ":00:00.000Z",
    }));
    const input = {
      ...modelInput,
      messages: originals,
      evidence: originals.map(messageEvidence),
    };
    const units = checkpointReportExcerpts(input);
    const proposal = await model({
      entries: [...units]
        .reverse()
        .map((unit) => report({ excerptId: unit.id })),
    }).model.generateAutobiography(input);
    expect(proposal.entries).toHaveLength(3);
    expect(
      proposal.entries.map((entry) => entry.evidence[0]!.sourceId),
    ).toEqual(originals.map((message) => message.id));
    expect(proposal.summaryFirstPerson).toBe(proposal.entries[2]!.content);
    expect(proposal.summaryFirstPerson.length).toBeLessThanOrEqual(2000);
    expect(proposal.summaryFirstPerson).toContain("如果前提不成立，我不会去。");
  });

  it("archives all-long-message windows as explicit source-only receipts without a paid call", async () => {
    const originals = messages.map((message) => ({
      ...message,
      content: "如果前提成立才会去，但目前并未成功。".repeat(300),
    }));
    const input = {
      ...modelInput,
      messages: originals,
      evidence: originals.map(messageEvidence),
    };
    expect(checkpointReportExcerpts(input)).toEqual([]);
    const runner = model(new Error("Must not be called"));
    const proposal = await runner.model.generateAutobiography(input);
    expect(runner.calls).toHaveLength(0);
    expect(proposal.entries).toHaveLength(2);
    for (const [index, entry] of proposal.entries.entries()) {
      expect(entry.temporalStatus).toBe("unknown");
      expect(entry.content).toContain("【长消息来源索引，内容尚未提炼】");
      expect(entry.content).toContain(originals[index]!.id);
      expect(entry.content).not.toContain(originals[index]!.createdAtUtc);
      expect(entry.evidence[0]!.recordedAtUtc).toBe(
        originals[index]!.createdAtUtc,
      );
      expect(entry.content).not.toContain("目前并未成功");
      expect(entry.evidence[0]!.sourceId).toBe(originals[index]!.id);
    }
    const projected = projectPromptTemporalData(
      {
        timezone: "Asia/Shanghai",
        temporalFrame: {
          mode: "anchored_story",
          eraLabel: "1951 年",
          storyAnchorLocalDate: "1951-09-01",
          systemAnchorUtc: originals[0]!.createdAtUtc,
        },
      },
      proposal,
    );
    expect(JSON.stringify(projected)).not.toContain("2026");
    expect(JSON.stringify(projected)).toContain("1951-09-01");
    expect(proposal.entries[0]!.evidence[0]!.recordedAtUtc).toContain("2026");
  });

  it("accepts reliable activity summaries and explicit event times", async () => {
    const proposal = await model({
      entries: [fact()],
    }).model.generateAutobiography({ ...modelInput, evidence: [activity] });
    expect(proposal.summaryFirstPerson).toBe("我完成了公园跑步。");
    expect(proposal.entries[0]).toMatchObject({
      temporalStatus: "occurred",
      fromUtc: activity.recordedAtUtc,
      evidence: [
        { id: activity.id, reliability: "fact", temporalStatus: "occurred" },
      ],
    });
  });

  it("reserves category capacity for every automatic long-message receipt", async () => {
    const originals = Array.from({ length: 39 }, (_, index) => ({
      ...messages[0]!,
      id: "message_long_" + index,
      content: "如果条件成立，仍不代表我已经执行。".repeat(120),
    }));
    const input = {
      ...modelInput,
      messages: [...originals, messages[1]!],
      evidence: [...originals.map(messageEvidence), evidence[1]!],
    };
    const selected = report({ excerptId: excerpts[1]!.id });
    const invalid = model({
      entries: [selected, { ...selected, entryKind: "relationship_change" }],
    });
    await expect(invalid.model.generateAutobiography(input)).rejects.toThrow(
      "invalid_proposal",
    );
    expect(JSON.parse(invalid.calls[0]!.prompt)).toMatchObject({
      maximumEntries: 1,
    });
    const proposal = await model({
      entries: [selected],
    }).model.generateAutobiography(input);
    expect(proposal.entries).toHaveLength(40);
    expect(proposal.entries.at(-1)?.evidence[0]?.sourceId).toBe(
      messages[1]!.id,
    );
  });

  it("rejects more than 40 non-message entries without widening snapshot categories", async () => {
    await expect(
      model({
        entries: Array.from({ length: 41 }, () => fact()),
      }).model.generateAutobiography({
        ...modelInput,
        evidence: [activity],
      }),
    ).rejects.toThrow("invalid_proposal");
  });

  it.each(["occurred", "in_progress"])(
    "requires actual support for each %s activity entry",
    async (temporalStatus) => {
      const plan = {
        ...activity,
        id: "planned_activity",
        temporalStatus: "planned" as const,
      };
      await expect(
        model({
          entries: [fact({ temporalStatus, evidenceIds: [plan.id] })],
        }).model.generateAutobiography({
          ...modelInput,
          evidence: [activity, plan],
        }),
      ).rejects.toThrow(temporalStatus + "_without_occurrence_evidence");
    },
  );

  it("still rejects ungrounded non-message summaries", async () => {
    await expect(
      model({
        entries: [fact({ content: "月球采矿。" })],
      }).model.generateAutobiography({ ...modelInput, evidence: [activity] }),
    ).rejects.toThrow("entry_not_grounded");
  });

  it("repairs an unknown excerpt ID once using the same server catalog", async () => {
    const runner = modelSequence([
      draft({ excerptId: "invented_id" }),
      draft(),
    ]);
    await runner.model.generateAutobiography(modelInput);
    expect(runner.calls.map((call) => call.maxRetries)).toEqual([0, 0]);
    const first = promptData(runner.calls[0]!.prompt);
    const second = promptData(runner.calls[1]!.prompt);
    expect(second.reportExcerpts).toEqual(first.reportExcerpts);
    expect(second.evidence).toEqual(first.evidence);
    expect(second.repair).toMatchObject({
      attempt: 2,
      issues: ["excerpt_not_found: invented_id"],
    });
  });

  it("uses the same single repair budget for provider schema errors", async () => {
    const runner = modelSequence([
      new StructuredOutputError("Invalid DTO", [
        "entries.0: excerptId required",
      ]),
      draft(),
    ]);
    await runner.model.generateAutobiography(modelInput);
    expect(runner.calls).toHaveLength(2);
    expect(promptData(runner.calls[1]!.prompt).repair!.issues).toEqual([
      "INVALID_STRUCTURED_OUTPUT: entries.0: excerptId required",
    ]);
  });

  it("records exhausted semantic repair after two calls", async () => {
    const runner = model(draft({ excerptId: "invented_id" }));
    await expect(
      runner.model.generateAutobiography(modelInput),
    ).rejects.toMatchObject({
      failureCode: "artifact_validation_failed",
      attemptCount: 2,
      issues: ["excerpt_not_found: invented_id"],
    });
    expect(runner.calls).toHaveLength(2);
  });

  it("does not repair transport errors", async () => {
    const runner = model(new Error("HTTP 429"));
    await expect(
      runner.model.generateAutobiography(modelInput),
    ).rejects.toMatchObject({
      failureCode: "generation_failed",
      attemptCount: 1,
    });
    expect(runner.calls).toHaveLength(1);
  });

  it("preserves attempt count if transport fails during repair", async () => {
    const runner = modelSequence([
      draft({ excerptId: "invented_id" }),
      new Error("Timed out"),
    ]);
    await expect(
      runner.model.generateAutobiography(modelInput),
    ).rejects.toMatchObject({
      failureCode: "generation_failed",
      attemptCount: 2,
    });
    expect(runner.calls).toHaveLength(2);
  });

  it("bounds repair diagnostics without replaying rejected prose", async () => {
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
});
