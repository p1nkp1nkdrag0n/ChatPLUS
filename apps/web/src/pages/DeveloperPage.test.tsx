import { renderToStaticMarkup } from "react-dom/server";
import type { DeveloperTemporalTaskResponse } from "@personasim/contracts";
import { describe, expect, it } from "vitest";
import { DeveloperTemporalTaskList } from "./DeveloperPage";

const LETTER_TASK: DeveloperTemporalTaskResponse = {
  id: "task-letter-1",
  agentId: "agent-1",
  kind: "letter.outbound_arrival",
  entityId: "letter-1",
  dueAtUtc: "2026-09-08T00:00:00.000Z",
  priority: 100,
  status: "pending",
  attempt: 0,
  maxAttempts: 3,
  createdAtUtc: "2026-09-03T00:00:00.000Z",
  updatedAtUtc: "2026-09-03T00:00:00.000Z",
};

describe("DeveloperTemporalTaskList", () => {
  it("keeps mixed-domain task rows diagnostic-only", () => {
    const failedReplyTask: DeveloperTemporalTaskResponse = {
      ...LETTER_TASK,
      id: "task-reply-1",
      kind: "letter.reply_generation",
      status: "dead_letter",
      attempt: 3,
      lastErrorCode: "provider_timeout",
      updatedAtUtc: "2026-09-08T00:01:00.000Z",
    };
    const failedRetryTask: DeveloperTemporalTaskResponse = {
      ...failedReplyTask,
      id: "task-reply-retry-1",
      kind: "letter.generation_retry",
      updatedAtUtc: "2026-09-08T00:02:00.000Z",
    };
    const keepsakeTask: DeveloperTemporalTaskResponse = {
      ...LETTER_TASK,
      id: "task-keepsake-1",
      kind: "keepsake.generate",
      entityId: "keepsake-1",
      status: "dead_letter",
      attempt: 3,
      lastErrorCode: "provider_failed",
      updatedAtUtc: "2026-09-08T00:03:00.000Z",
    };

    const markup = renderToStaticMarkup(
      <DeveloperTemporalTaskList
        tasks={[LETTER_TASK, failedReplyTask, failedRetryTask, keepsakeTask]}
      />,
    );

    expect(markup).toContain("任务列表只用于诊断");
    expect(markup).toContain("立即结算角色");
    expect(markup).toContain("当前运行模式");
    expect(markup).toContain("不会被正常调度自动重跑");
    expect(markup).toContain("否则会保留此诊断状态");
    expect(markup).toContain("letter.outbound_arrival");
    expect(markup).toContain("letter.reply_generation");
    expect(markup).toContain("letter.generation_retry");
    expect(markup).toContain("keepsake.generate");
    expect(markup).toContain("dead_letter");
    expect(markup).toContain("provider_timeout");
    expect(markup).not.toContain("强制处理");
    expect(markup).not.toContain("<button");
  });

  it("describes an empty cross-domain task list accurately", () => {
    const markup = renderToStaticMarkup(
      <DeveloperTemporalTaskList tasks={[]} />,
    );

    expect(markup).toContain("当前角色没有时间任务");
    expect(markup).not.toContain("当前角色没有书信时间任务");
  });

  it("does not claim that an unresolved task query is empty", () => {
    const markup = renderToStaticMarkup(
      <DeveloperTemporalTaskList tasks={undefined} />,
    );

    expect(markup).toBe("");
    expect(markup).not.toContain("当前角色没有时间任务");
  });
});
