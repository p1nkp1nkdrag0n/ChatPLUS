import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveMessageDelivery } from "../lib/messageDelivery";
import { api } from "./client";

describe("web API normalization", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("merges server activity projections and domain events without duplicating activities", async () => {
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
            },
          ],
          activityEvents: [
            {
              id: "activity-1",
              eventType: "completed",
              summary: "旅行已经完成。",
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
    expect(fetchMock).toHaveBeenCalledOnce();
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
