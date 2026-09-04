import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./client";

const HASH = "a".repeat(64);
const NOW = "2026-09-15T10:00:00.000Z";

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const archiveEntry = {
  id: "letter-1",
  agentId: "agent-1",
  entryType: "letter",
  title: "九月来信",
  summary: "一封已经归档的信。",
  effectiveAtUtc: "2026-09-13T00:00:00.000Z",
  recordedAtUtc: NOW,
  href: "/letters/letter-1?agentId=agent-1",
  sourceIds: ["letter-1"],
  letterId: "letter-1",
  threadId: "thread-1",
  direction: "agent_to_user",
  status: "read",
  postmark: "2026-09-08 · Asia/Shanghai",
  waitingDays: 5,
} as const;

const archiveKeepsakeEntry = {
  id: "keepsake-1",
  agentId: "agent-1",
  entryType: "keepsake",
  title: "雨夜电影票",
  summary: "来自一次已经确认发生的共同观影。",
  effectiveAtUtc: "2026-09-08T00:00:00.000Z",
  recordedAtUtc: NOW,
  href: "/characters/agent-1/relationship-archive?entryId=keepsake%3Akeepsake-1",
  sourceIds: ["keepsake-1"],
  keepsakeId: "keepsake-1",
  keepsakeKind: "ticket_stub",
  thumbnailUrl: "/api/keepsakes/keepsake-1/thumbnail",
} as const;

const keepsake = {
  id: "keepsake-1",
  agentId: "agent-1",
  title: "雨夜电影票",
  kind: "ticket_stub",
  description: "来自一次已经确认发生的共同观影。",
  createdBy: "agent",
  ownedBy: "user",
  givenTo: "user",
  sourceEventIds: ["outcome-1"],
  sourceMemoryIds: [],
  sourceLetterIds: [],
  canonicality: "canonical",
  status: "ready",
  visualSpecJson: {
    version: "keepsake_visual_v1",
    templateVersion: "ticket-stub-v1",
    theme: "雨后的旧电影院",
    caption: "九月八日，散场时雨刚停。",
    palette: ["#C56F46", "#22354B"],
    materials: ["旧纸", "蓝色油墨"],
  },
  visualSpecHash: HASH,
  primaryAssetId: "asset-1",
  createdEffectiveAtUtc: NOW,
  giftedAtUtc: NOW,
  idempotencyKey: "keepsake:life_outcome:outcome-1:ticket_stub:v1",
  createdAtUtc: NOW,
  updatedAtUtc: NOW,
} as const;

describe("relationship archive API client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the stable cursor, detail, and local share projection endpoints", async () => {
    const responses = [
      {
        items: [archiveEntry],
        nextCursor: "opaque-archive-cursor",
        serverTimeUtc: NOW,
      },
      {
        items: [archiveEntry],
        serverTimeUtc: NOW,
      },
      {
        items: [archiveKeepsakeEntry],
        serverTimeUtc: NOW,
      },
      {
        items: [
          {
            id: keepsake.id,
            agentId: keepsake.agentId,
            title: keepsake.title,
            kind: keepsake.kind,
            description: keepsake.description,
            status: keepsake.status,
            primaryAssetId: keepsake.primaryAssetId,
            createdEffectiveAtUtc: keepsake.createdEffectiveAtUtc,
            giftedAtUtc: keepsake.giftedAtUtc,
            thumbnailUrl: "/api/keepsakes/keepsake-1/thumbnail",
          },
        ],
        nextCursor: "opaque-keepsake-cursor",
        filterOptions: {
          kinds: ["ticket_stub"],
          sourceTypes: ["life_outcome"],
          periods: ["2026-09"],
        },
      },
      {
        keepsake,
        assets: [
          {
            id: "asset-1",
            keepsakeId: keepsake.id,
            storageKey: "agent-1/asset.webp",
            thumbnailStorageKey: "agent-1/asset.thumb.webp",
            mimeType: "image/webp",
            width: 1200,
            height: 800,
            sha256: HASH,
            thumbnailSha256: HASH,
            provider: "fixture-template",
            model: "ticket-stub-v1",
            promptSpecHash: HASH,
            createdAtUtc: NOW,
          },
        ],
        sources: [
          {
            type: "life_outcome",
            id: "outcome-1",
            label: "雨夜观影",
            effectiveAtUtc: NOW,
            href: "/characters/agent-1/relationship-archive?entryId=outcome_record%3Aoutcome-1",
          },
        ],
      },
      {
        version: "relationship_share_projection_v1",
        templateVersion: "relationship-share-v1",
        exportMode: "local_png",
        agentId: "agent-1",
        generatedAtUtc: NOW,
        envelope: {
          letterId: "letter-1",
          direction: "agent_to_user",
          status: "read",
          envelope: true,
          postmark: "2026-09-08 · Asia/Shanghai",
          waitingDays: 5,
        },
        sourceIds: ["letter-1"],
      },
    ];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return Promise.resolve(response(responses.shift()));
    });
    vi.stubGlobal("fetch", fetchMock);

    await api.relationshipArchive.list("agent-1", {
      filter: "all",
      cursor: "archive-cursor",
      limit: 20,
    });
    await api.relationshipArchive.list("agent-1", {
      entryId: "letter:letter-1",
      includePreviewText: false,
      limit: 1,
    });
    await api.relationshipArchive.list("agent-1", {
      entryId: "keepsake:keepsake-1",
      limit: 1,
    });
    await api.keepsakes.list("agent-1", {
      cursor: "keepsake-cursor",
      limit: 6,
      kind: "ticket_stub",
      sourceType: "life_outcome",
      period: "2026-09",
    });
    await api.keepsakes.get("keepsake-1");
    await api.relationshipArchive.previewShare("agent-1", {
      templateVersion: "relationship-share-v1",
      letterId: "letter-1",
      includeEnvelope: true,
      includePostmark: true,
      includeWaitingDays: true,
      includeKeepsake: false,
      includeExcerpt: false,
      redactions: [],
    });

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/agents/agent-1/relationship-archive?filter=all&limit=20&cursor=archive-cursor",
      "/api/agents/agent-1/relationship-archive?filter=all&limit=1&entryId=letter%3Aletter-1&includePreviewText=false",
      "/api/agents/agent-1/relationship-archive?filter=all&limit=1&entryId=keepsake%3Akeepsake-1",
      "/api/agents/agent-1/keepsakes?limit=6&cursor=keepsake-cursor&kind=ticket_stub&sourceType=life_outcome&period=2026-09",
      "/api/keepsakes/keepsake-1",
      "/api/agents/agent-1/relationship-share/preview",
    ]);
    expect(fetchMock.mock.calls[5]?.[1]).toMatchObject({ method: "POST" });
    const previewBody = fetchMock.mock.calls[5]?.[1]?.body;
    expect(typeof previewBody).toBe("string");
    if (typeof previewBody !== "string") throw new Error("Expected JSON body");
    expect(JSON.parse(previewBody)).not.toHaveProperty("excerpt");
  });

  it("rejects an archive response that leaks an unopened reply preview", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({
          items: [
            {
              ...archiveEntry,
              status: "delivered_unread",
              previewText: "SENTINEL_UNOPENED_BODY",
            },
          ],
          serverTimeUtc: NOW,
        }),
      ),
    );

    await expect(
      api.relationshipArchive.list("agent-1", { filter: "all" }),
    ).rejects.toThrow();
  });

  it("rejects an exact archive response that contains a letter body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({
          items: [
            {
              ...archiveEntry,
              body: "SENTINEL_PRIVATE_LETTER_BODY",
            },
          ],
          serverTimeUtc: NOW,
        }),
      ),
    );

    await expect(
      api.relationshipArchive.list("agent-1", {
        entryId: "letter:letter-1",
        includePreviewText: false,
        limit: 1,
      }),
    ).rejects.toThrow();
  });
});
