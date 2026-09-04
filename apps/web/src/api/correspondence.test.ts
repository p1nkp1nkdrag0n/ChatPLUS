import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { api } from "./client";
import { correspondenceQueryKeys } from "../lib/correspondence";

const openedDetail = {
  letter: {
    id: "reply-1",
    threadId: "thread-1",
    direction: "agent_to_user",
    status: "read",
    authoredDisplayDate: "2026-09-13",
    dispatchedAtUtc: "2026-09-08T00:00:00.000Z",
    arrivalDueAtUtc: "2026-09-13T00:00:00.000Z",
    progress: 1,
    postmark: "杭州 · 2026-09-08",
    canOpen: true,
    canEdit: false,
    previewText: "已经读过的简短预览",
  },
  subject: "九月来信",
  body: "SENTINEL_DECRYPTED_BODY",
  salutation: "你好。",
  closing: "祝安。",
  signature: "林枫",
  relatedKeepsakeIds: [],
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("correspondence API client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses exact draft, update, seal, detail, and open HTTP requests", async () => {
    const draft = {
      letter: {
        id: "letter-1",
        threadId: "thread-1",
        direction: "user_to_agent",
        status: "draft",
        authoredDisplayDate: "2026-09-03",
        progress: 0,
        postmark: "上海 · 2026-09-03",
        canOpen: false,
        canEdit: true,
      },
      subject: "近况",
      body: "写给远方。",
    };
    const sealed = {
      ...draft,
      letter: {
        ...draft.letter,
        status: "in_transit",
        dispatchedAtUtc: "2026-09-03T00:00:00.000Z",
        arrivalDueAtUtc: "2026-09-08T00:00:00.000Z",
        canEdit: false,
      },
    };
    const responses = [draft, draft, sealed, draft, openedDetail];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return Promise.resolve(jsonResponse(responses.shift()));
    });
    vi.stubGlobal("fetch", fetchMock);

    await api.letters.createDraft("agent-1", {
      clientRequestId: "create-1",
      subject: "近况",
      body: "写给远方。",
    });
    await api.letters.updateDraft("letter-1", {
      subject: "近况",
      body: "写给远方。",
    });
    await api.letters.seal("letter-1", { clientRequestId: "seal-1" });
    await api.letters.get("letter-1");
    await api.letters.open("reply-1");

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/agents/agent-1/letters",
      "/api/letters/letter-1",
      "/api/letters/letter-1/seal",
      "/api/letters/letter-1",
      "/api/letters/reply-1/open",
    ]);
    expect(
      fetchMock.mock.calls.map(([, init]) => init?.method ?? "GET"),
    ).toEqual(["POST", "PATCH", "POST", "GET", "POST"]);
    expect(fetchMock.mock.calls[2]?.[1]?.body).toBe(
      JSON.stringify({ clientRequestId: "seal-1" }),
    );
    expect(fetchMock.mock.calls[4]?.[1]?.body).toBe("{}");
  });

  it("never returns full opened reply plaintext from the cache-safe detail method", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(openedDetail)),
    );

    const queryClient = new QueryClient();
    const queryKey = correspondenceQueryKeys.letter("reply-1");
    const result = await queryClient.fetchQuery({
      queryKey,
      queryFn: () => api.letters.getCacheSafe("reply-1"),
    });

    expect(result).toEqual({ letter: openedDetail.letter });
    expect(JSON.stringify(result)).not.toContain("SENTINEL_DECRYPTED_BODY");
    expect(JSON.stringify(queryClient.getQueryData(queryKey))).not.toContain(
      "SENTINEL_DECRYPTED_BODY",
    );
  });

  it("sends mailbox limits and opaque cursors and retains the next cursor", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        threads: [
          {
            id: "thread-1",
            agentId: "agent:one",
            status: "closed",
          },
        ],
        letters: [openedDetail.letter],
        serverTimeUtc: "2026-09-15T00:00:00.000Z",
        nextCursor: "opaque+/cursor=",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      api.correspondence.list("agent:one", {
        limit: 25,
        cursor: "opaque+/cursor=",
      }),
    ).resolves.toMatchObject({ nextCursor: "opaque+/cursor=" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/agents/agent%3Aone/correspondence?limit=25&cursor=opaque%2B%2Fcursor%3D",
    );
  });

  it("rejects a mailbox response that tries to add unopened reply plaintext", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          threads: [
            {
              id: "thread-1",
              agentId: "agent-1",
              status: "open",
              latestLetterId: "reply-1",
            },
          ],
          letters: [
            {
              id: "reply-1",
              threadId: "thread-1",
              direction: "agent_to_user",
              status: "in_transit",
              authoredDisplayDate: "2026-09-13",
              dispatchedAtUtc: "2026-09-08T00:00:00.000Z",
              arrivalDueAtUtc: "2026-09-13T00:00:00.000Z",
              progress: 0.4,
              postmark: "杭州 · 2026-09-08",
              canOpen: false,
              canEdit: false,
              body: "THIS_MUST_BE_REJECTED",
            },
          ],
          serverTimeUtc: "2026-09-10T00:00:00.000Z",
        }),
      ),
    );

    await expect(api.correspondence.list("agent-1")).rejects.toThrow();
  });

  it("accepts only the redacted developer temporal-task DTO", async () => {
    const task = {
      id: "task-1",
      agentId: "agent-1",
      kind: "letter.outbound_arrival",
      entityId: "letter-1",
      dueAtUtc: "2026-09-08T00:00:00.000Z",
      priority: 10,
      status: "pending",
      attempt: 0,
      maxAttempts: 3,
      createdAtUtc: "2026-09-03T00:00:00.000Z",
      updatedAtUtc: "2026-09-03T00:00:00.000Z",
    };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return Promise.resolve(jsonResponse({ tasks: [task] }));
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.developer.temporalTasks("agent-1")).resolves.toEqual({
      tasks: [task],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/developer/agents/agent-1/temporal-tasks",
      expect.any(Object),
    );
  });
});
