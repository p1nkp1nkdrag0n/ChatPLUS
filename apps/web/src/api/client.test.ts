import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveMessageDelivery } from "../lib/messageDelivery";
import { api } from "./client";

describe("web API normalization", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes immutable correspondence runtime capabilities", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            settings: { locale: "zh-CN", defaultTimezone: "Asia/Shanghai" },
            runtime: {
              llmProvider: "fixture",
              correspondenceMode: "shadow",
              correspondenceExecution: "resident",
              keepsakeMode: "enforced",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    await expect(api.settings.get()).resolves.toMatchObject({
      correspondenceMode: "shadow",
      correspondenceExecution: "resident",
      keepsakeMode: "enforced",
    });
  });

  it("uses canonical events as authoritative and preserves lineage IDs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          events: [
            {
              id: "activity-1",
              type: "completed",
              title: "海边旅行",
              summary: "旅行已经完成。",
              occurredAtUtc: "2026-08-16T08:00:00.000Z",
              sourceIntentId: "intent-1",
              scheduleItemId: "schedule-1",
              activityEventId: "activity-1",
              memoryId: "memory-1",
              proactiveCandidateId: "candidate-1",
              messageId: "message-1",
            },
            {
              id: "domain-1",
              type: "simulation.settled",
              title: "模拟结算",
              summary: "离线生活已结算。",
              occurredAtUtc: "2026-08-16T09:00:00.000Z",
            },
          ],
          activityEvents: [
            {
              id: "activity-1",
              eventType: "completed",
              summary: "旅行已经完成。",
              occurredAtUtc: "2026-08-16T08:00:00.000Z",
            },
            {
              id: "legacy-activity",
              eventType: "started",
              summary: "不应追加的旧投影。",
              occurredAtUtc: "2026-08-16T10:00:00.000Z",
            },
          ],
          domainEvents: [
            {
              id: "domain-1",
              eventType: "simulation.settled",
              recordedAtUtc: "2026-08-16T09:00:00.000Z",
              payload: { summary: "离线生活已结算。" },
            },
            {
              id: "legacy-domain",
              eventType: "schedule.changed",
              recordedAtUtc: "2026-08-16T10:00:00.000Z",
              payload: { summary: "不应追加的旧领域事件。" },
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await api.agents.timeline("agent-1");

    expect(result.events.map((event) => event.id)).toEqual([
      "domain-1",
      "activity-1",
    ]);
    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({
      type: "simulation.settled",
      summary: "离线生活已结算。",
    });
    expect(
      result.events.find((event) => event.id === "activity-1"),
    ).toMatchObject({
      sourceIntentId: "intent-1",
      scheduleItemId: "schedule-1",
      activityEventId: "activity-1",
      memoryId: "memory-1",
      proactiveCandidateId: "candidate-1",
      messageId: "message-1",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("merges and deduplicates legacy timeline arrays when canonical events are absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            activityEvents: [
              {
                id: "activity-1",
                eventType: "completed",
                summary: "旅行已经完成。",
                occurredAtUtc: "2026-08-16T08:00:00.000Z",
                sourceIntentId: "intent-1",
                scheduleItemId: "schedule-1",
              },
              {
                id: "activity-1",
                eventType: "completed",
                summary: "重复的活动事件。",
                occurredAtUtc: "2026-08-16T08:00:00.000Z",
              },
            ],
            domainEvents: [
              {
                id: "domain-1",
                eventType: "simulation.settled",
                recordedAtUtc: "2026-08-16T09:00:00.000Z",
                payload: { summary: "离线生活已结算。" },
              },
              {
                id: "domain-1",
                eventType: "simulation.settled",
                recordedAtUtc: "2026-08-16T09:00:00.000Z",
                payload: { summary: "重复的领域事件。" },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const result = await api.agents.timeline("agent-1");

    expect(result.events.map((event) => event.id)).toEqual([
      "domain-1",
      "activity-1",
    ]);
    expect(
      result.events.find((event) => event.id === "activity-1"),
    ).toMatchObject({
      sourceIntentId: "intent-1",
      scheduleItemId: "schedule-1",
      activityEventId: "activity-1",
    });
  });

  it("composes developer snapshots only from supported endpoints", async () => {
    const status = { serverTimeUtc: "2026-08-16T08:00:00.000Z" };
    const overview = { agentId: "agent-1", state: { revision: 3 } };
    const memories = { memories: [{ id: "memory-1" }] };
    const timeline = { events: [{ id: "event-1" }] };
    const payloads = new Map<string, Record<string, unknown>>([
      ["/api/developer/status", status],
      ["/api/agents/agent-1/overview", overview],
      ["/api/agents/agent-1/memories", memories],
      ["/api/agents/agent-1/timeline", timeline],
    ]);
    const fetchMock = vi.fn((input: string): Promise<Response> => {
      const payload = payloads.get(input);
      if (payload === undefined) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: { code: "not_found", message: "Unsupported endpoint" },
            }),
            {
              status: 404,
              headers: { "content-type": "application/json" },
            },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.developer.snapshot("agent-1")).resolves.toEqual({
      status,
      overview,
      memories,
      timeline,
    });

    const requestedUrls = fetchMock.mock.calls.map(([input]) => input);
    expect(requestedUrls).toEqual([
      "/api/developer/status",
      "/api/agents/agent-1/overview",
      "/api/agents/agent-1/memories",
      "/api/agents/agent-1/timeline",
    ]);
    expect(
      requestedUrls.some((url) => url.includes("/api/developer/snapshot/")),
    ).toBe(false);
  });

  it("normalizes assistant delivery metadata for sequential chat bubbles", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          messages: [
            {
              id: "message-1",
              sessionId: "session-1",
              agentId: "agent-1",
              role: "assistant",
              content: "先说第一句。\n再说第二句。",
              metadata: {
                deliveryMode: "sequential",
                chunks: ["先说第一句。", "再说第二句。"],
                memoryRecall: {
                  rolloutMode: "enforced",
                  promptStrategy: "evidence_selected",
                  legacyPromptMemoryIds: [],
                  promptMemoryIds: ["memory-1"],
                  selectedMemoryIds: ["memory-1"],
                  selectedEvidenceIds: ["evidence-1"],
                  rejectedMemoryIds: [],
                  recallMode: "verbatim_quote",
                  score: 0.91,
                  abstained: false,
                  durationMs: 2,
                },
              },
              createdAtUtc: "2026-08-16T08:00:00.000Z",
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await api.sessions.messages("session-1");

    expect(result.messages[0]).toMatchObject({
      text: "先说第一句。\n再说第二句。",
      deliveryMode: "sequential",
      chunks: ["先说第一句。", "再说第二句。"],
      memoryRecall: {
        promptStrategy: "evidence_selected",
        selectedMemoryIds: ["memory-1"],
        selectedEvidenceIds: ["evidence-1"],
        recallMode: "verbatim_quote",
        score: 0.91,
        abstained: false,
      },
    });
  });

  it("defaults legacy messages to a single block", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify([
            {
              id: "message-legacy",
              sessionId: "session-1",
              agentId: "agent-1",
              role: "assistant",
              content: "旧消息仍然完整显示。",
              createdAtUtc: "2026-08-16T08:00:00.000Z",
            },
          ]),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );

    const result = await api.sessions.messages("session-1");

    expect(result.messages[0]).toMatchObject({
      text: "旧消息仍然完整显示。",
      deliveryMode: "single_block",
    });
  });

  it("keeps complete content when untrusted chunks do not match it exactly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            messages: [
              {
                id: "message-bad-chunks",
                sessionId: "session-1",
                agentId: "agent-1",
                role: "assistant",
                content: "I am still here",
                metadata: {
                  deliveryMode: "sequential",
                  chunks: ["Iam still here"],
                },
                createdAtUtc: "2026-08-16T08:00:00.000Z",
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );

    const result = await api.sessions.messages("session-1");

    expect(result.messages[0]).toMatchObject({
      text: "I am still here",
      deliveryMode: "single_block",
    });
    expect(result.messages[0]?.chunks).toBeUndefined();
    expect(resolveMessageDelivery(result.messages[0]!)).toEqual({
      mode: "single_block",
      chunks: ["I am still here"],
    });
  });
});
