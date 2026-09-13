import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type {
  KeepsakeDetailResponse,
  KeepsakeKind,
  KeepsakeStatus,
  OpenLetterResponse,
} from "@personasim/contracts";
import { KeepsakeArtwork } from "./KeepsakeArtwork";
import { KeepsakeShelf } from "./ArchivePrimitives";
import {
  LetterKeepsakeCard,
  LetterKeepsakes,
} from "../correspondence/LetterKeepsakes";
import ArtifactDetailPage from "../../pages/ArtifactDetailPage";
import { api } from "../../api/client";
import { projectLetterDetailForCache } from "../../lib/correspondence";
import {
  keepsakeDetailQueryOptions,
  keepsakePollInterval,
  openedLetterKeepsakeIds,
} from "../../lib/keepsakes";
import { relationshipArchiveQueryKeys } from "../../lib/relationshipArchive";

const NOW = "2026-09-15T10:00:00.000Z";

function artifact(
  status: KeepsakeStatus = "pending",
  id = "keepsake-1",
): KeepsakeDetailResponse {
  return {
    keepsake: {
      id,
      agentId: "agent-1",
      title: "雨夜电影票",
      kind: "ticket_stub",
      description: "留住那次我们聊起的雨夜电影。",
      createdBy: "agent",
      ownedBy: "user",
      givenTo: "user",
      sourceEventIds: [],
      sourceMemoryIds: [],
      sourceLetterIds: ["incoming-1"],
      canonicality: "evidence_derived",
      status,
      visualSpecJson: {
        version: "keepsake_visual_v1",
        templateVersion: "ticket_stub-v2",
        theme: "那次雨夜电影",
        caption: "和你一起留下的记忆",
        palette: ["#966044", "#F3E4D3"],
        materials: ["纸张"],
      },
      visualSpecHash: "a".repeat(64),
      ...(status === "ready" ? { primaryAssetId: "asset-1" } : {}),
      createdEffectiveAtUtc: NOW,
      giftedAtUtc: NOW,
      idempotencyKey: `keepsake:letter:incoming-1:${id}`,
      createdAtUtc: NOW,
      updatedAtUtc: NOW,
    },
    assets: [],
    sources: [
      {
        type: "letter",
        id: "incoming-1",
        label: "关于那场电影的来信",
        href: "/letters/incoming-1",
        effectiveAtUtc: NOW,
      },
    ],
  };
}

const opened: OpenLetterResponse = {
  letter: {
    id: "reply-1",
    threadId: "thread-1",
    direction: "agent_to_user",
    status: "read",
    authoredDisplayDate: "2026-09-13",
    progress: 1,
    postmark: "杭州 · 2026-09-08",
    canOpen: true,
    canEdit: false,
  },
  subject: "回信",
  body: "PRIVATE_REPLY_BODY",
  salutation: "你好",
  closing: "祝好",
  signature: "林枫",
  relatedKeepsakeIds: ["keepsake-1"],
};

describe("received keepsake presentation", () => {
  it.each<KeepsakeKind>([
    "postcard",
    "ticket_stub",
    "polaroid",
    "sketch",
    "pressed_flower",
    "recipe_or_note_card",
  ])("renders a collectible %s base before any image is available", (kind) => {
    const markup = renderToStaticMarkup(
      <KeepsakeArtwork keepsakeId="keepsake-1" kind={kind} title="一份纪念" />,
    );
    expect(markup).toContain(`keepsake-artwork--${kind}`);
    expect(markup).toContain('data-artwork-ready="false"');
    expect(markup).toContain('aria-label="一份纪念"');
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("spinner");
  });

  it("keeps the base behind a pending image load instead of replacing it with an empty area", () => {
    const markup = renderToStaticMarkup(
      <KeepsakeArtwork
        keepsakeId="keepsake-1"
        kind="ticket_stub"
        title="雨夜电影票"
        src="/image.webp"
      />,
    );
    expect(markup).toContain('src="/image.webp"');
    expect(markup).toContain("keepsake-artwork__paper");
    expect(markup).toContain('data-artwork-ready="false"');
    expect(markup).not.toContain("is-ready");
  });

  it.each<KeepsakeStatus>(["pending", "generating", "failed"])(
    "keeps the %s attachment title, origin and detail link visible without an image request",
    (status) => {
      const markup = renderToStaticMarkup(
        <MemoryRouter>
          <LetterKeepsakeCard detail={artifact(status)} />
        </MemoryRouter>,
      );
      expect(markup).toContain('href="/keepsakes/keepsake-1"');
      expect(markup).toContain("雨夜电影票");
      expect(markup).toContain("关于那场电影的来信");
      expect(markup).toContain(`data-status="${status}"`);
      expect(markup).not.toContain("/thumbnail");
      if (status === "failed") {
        expect(markup).toContain("这次未能完成专属图案");
        expect(markup).not.toContain("正在绘制");
      }
    },
  );

  it("uses the same pending and failed items in the cabinet", () => {
    const markup = renderToStaticMarkup(
      <KeepsakeShelf
        items={[artifact().keepsake, artifact("failed", "keepsake-2").keepsake]}
        timezone="UTC"
      />,
    );
    expect(markup.match(/雨夜电影票/g)?.length).toBeGreaterThanOrEqual(2);
    expect(markup).toContain("专属图案等待绘制");
    expect(markup).toContain("专属图案暂未完成");
    expect(markup).not.toContain("<img");
  });

  it.each<KeepsakeStatus>(["pending", "generating", "failed", "ready"])(
    "guards image-dependent sharing in the %s detail view",
    (status) => {
      const client = new QueryClient();
      client.setQueryData(
        relationshipArchiveQueryKeys.keepsake("keepsake-1"),
        artifact(status),
      );
      const markup = renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={["/keepsakes/keepsake-1"]}>
            <Routes>
              <Route
                path="/keepsakes/:keepsakeId"
                element={<ArtifactDetailPage />}
              />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
      expect(markup).toContain("关于那场电影的来信");
      if (status === "ready") {
        expect(markup).toContain("relationship-share?keepsakeId=keepsake-1");
        expect(markup).toContain("/api/keepsakes/keepsake-1/asset");
      } else {
        expect(markup).toContain('disabled=""');
        expect(markup).toContain("专属图案完成后，就可以制作分享图");
        expect(markup).not.toContain("/asset");
        expect(markup).not.toContain("relationship-share?");
      }
      client.clear();
    },
  );

  it("reuses cached attachment details without putting an opened letter body in the attachment cache", () => {
    const client = new QueryClient();
    client.setQueryData(
      relationshipArchiveQueryKeys.keepsake("keepsake-1"),
      artifact(),
    );
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <LetterKeepsakes keepsakeIds={["keepsake-1"]} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(markup).toContain('aria-label="随信纪念物"');
    expect(markup).toContain("雨夜电影票");
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain("PRIVATE_REPLY_BODY");
    client.clear();
  });
});

describe("letter reveal and keepsake refresh boundaries", () => {
  it("requires a matching successfully opened reply and its reading view before exposing attachment IDs", () => {
    const cached = projectLetterDetailForCache(opened);
    expect(openedLetterKeepsakeIds(cached, undefined, "reading")).toEqual([]);
    expect(openedLetterKeepsakeIds(cached, opened, "envelope")).toEqual([]);
    expect(openedLetterKeepsakeIds(cached, opened, "revealing")).toEqual([]);
    expect(openedLetterKeepsakeIds(cached, opened, "reading")).toEqual([
      "keepsake-1",
    ]);
    expect(
      openedLetterKeepsakeIds(
        projectLetterDetailForCache({
          ...opened,
          letter: { ...opened.letter, id: "another-reply" },
        }),
        opened,
        "reading",
      ),
    ).toEqual([]);
    expect(JSON.stringify(cached)).not.toContain("PRIVATE_REPLY_BODY");
  });

  it("merges attachments linked after opening from refreshed safe metadata without duplicating them", () => {
    const cached = projectLetterDetailForCache({
      ...opened,
      relatedKeepsakeIds: ["keepsake-1", "keepsake-2"],
    });
    expect(openedLetterKeepsakeIds(cached, opened, "reading")).toEqual([
      "keepsake-1",
      "keepsake-2",
    ]);
    const unopenedCache = projectLetterDetailForCache({
      ...opened,
      letter: { ...opened.letter, status: "delivered_unread" },
    });
    expect(unopenedCache).not.toHaveProperty("relatedKeepsakeIds");
  });

  it("stops fallback polling for finished or failed items, and bounds waiting and network failures", () => {
    expect(keepsakePollInterval(["ready", "pending"], 1, 0)).toBe(5_000);
    expect(keepsakePollInterval(["generating"], 59, 0)).toBe(5_000);
    expect(keepsakePollInterval(["ready", "failed"], 1, 0)).toBe(false);
    expect(keepsakePollInterval(["pending"], 60, 0)).toBe(false);
    expect(keepsakePollInterval(["pending"], 1, 2)).toBe(false);
  });

  it("starts independent detail requests together while deduplicating repeated consumers of one item", async () => {
    const client = new QueryClient();
    const resolvers = new Map<
      string,
      (value: KeepsakeDetailResponse) => void
    >();
    const get = vi.spyOn(api.keepsakes, "get").mockImplementation(
      (id) =>
        new Promise((resolve) => {
          resolvers.set(id, resolve);
        }),
    );
    const first = client.fetchQuery(keepsakeDetailQueryOptions("keepsake-1"));
    const second = client.fetchQuery(keepsakeDetailQueryOptions("keepsake-2"));
    const repeated = client.fetchQuery(
      keepsakeDetailQueryOptions("keepsake-1"),
    );
    expect(get).toHaveBeenCalledTimes(2);
    expect([...resolvers.keys()]).toEqual(["keepsake-1", "keepsake-2"]);
    resolvers.get("keepsake-1")!(artifact());
    resolvers.get("keepsake-2")!(artifact("ready", "keepsake-2"));
    await Promise.all([first, second, repeated]);
    client.clear();
  });
});
