import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  LetterDetailResponse,
  RelationshipArchivePageResponse,
  RelationshipShareProjection,
} from "@personasim/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp, type PersonaSimApp } from "./app.js";
import { readConfig } from "./config.js";
import { FakeClock } from "./runtime/clock.js";

const NOW = "2026-09-03T04:00:00.000Z";
const INSTANCE_SECRET = Buffer.alloc(32, 0x64).toString("base64");
const PRIVATE_BODY = "PRIVATE ARCHIVE HTTP BODY：杭州见面的地点需要涂黑。";

describe("relationship archive HTTP", () => {
  let app: PersonaSimApp | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    if (app !== undefined) await app.close();
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
    app = undefined;
    directory = undefined;
  });

  it("serves bounded cursor pages and a validated local-only share projection", async () => {
    directory = mkdtempSync(join(tmpdir(), "chatplus-archive-http-"));
    app = await buildApp({
      config: readConfig({
        nodeEnv: "test",
        profile: "relationship-archive-http",
        databasePath: join(directory, "archive.db"),
        assetStoragePath: join(directory, "assets"),
        clockMode: "fake",
        fakeClockStart: NOW,
        seedDemo: false,
        developerRoutes: true,
        lifePlanningMode: "fuzzy",
        correspondenceMode: "enforced",
        correspondenceExecution: "lazy",
        correspondenceTransitPolicy: "fixed_5d_v1",
        correspondenceGenerationLeaseMs: 1_800_000,
        correspondenceMaxOpenThreads: 1,
        keepsakeMode: "off",
        instanceSecret: INSTANCE_SECRET,
        llm: {
          provider: "fixture",
          baseUrl: "https://example.invalid",
          model: "personasim-fixture-v1",
          timeoutMs: 1_000,
          maxRetries: 0,
        },
      }),
      clock: new FakeClock(NOW),
      seedDemo: false,
      startScheduler: false,
      logger: false,
    });

    const draft = app.personasim.characters.createDemoCharacter();
    const agentId = draft.id;
    app.personasim.characters.publish(agentId);
    seedHttpDomainEvents(app, agentId, 105);

    const created = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/letters`,
      payload: {
        clientRequestId: "archive-http-create",
        subject: "档案里的信",
        body: PRIVATE_BODY,
      },
    });
    expect(created.statusCode).toBe(201);
    const letterId = created.json<LetterDetailResponse>().letter.id;
    const sealed = await app.inject({
      method: "POST",
      url: `/api/letters/${letterId}/seal`,
      payload: { clientRequestId: "archive-http-seal" },
    });
    expect(sealed.statusCode).toBe(200);

    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const pageResponse = await app.inject({
        method: "GET",
        url: `/api/agents/${agentId}/relationship-archive?filter=life&limit=19${
          cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`
        }`,
      });
      expect(pageResponse.statusCode).toBe(200);
      expect(pageResponse.headers["cache-control"]).toBe("no-store");
      const page = pageResponse.json<RelationshipArchivePageResponse>();
      expect(page.items.length).toBeLessThanOrEqual(19);
      for (const item of page.items) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
        expect(item.sourceIds).toContain(item.id);
        expect(item.href).toContain(encodeURIComponent(item.id));
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(seen.size).toBeGreaterThanOrEqual(105);

    const oldestEntryId = "domain_event:event-http-archive-000";
    const exact = await app.inject({
      method: "GET",
      url: `/api/agents/${agentId}/relationship-archive?entryId=${encodeURIComponent(oldestEntryId)}`,
    });
    expect(exact.statusCode).toBe(200);
    expect(exact.json<RelationshipArchivePageResponse>()).toMatchObject({
      items: [
        {
          id: "event-http-archive-000",
          agentId,
          href: `/characters/${agentId}/relationship-archive?entryId=${encodeURIComponent(oldestEntryId)}`,
          sourceIds: ["event-http-archive-000"],
        },
      ],
    });
    expect(exact.json<RelationshipArchivePageResponse>()).not.toHaveProperty(
      "nextCursor",
    );

    const unrelated = app.personasim.characters.createDemoCharacter();
    app.personasim.characters.publish(unrelated.id);
    const isolatedExact = await app.inject({
      method: "GET",
      url: `/api/agents/${unrelated.id}/relationship-archive?entryId=${encodeURIComponent(oldestEntryId)}`,
    });
    expect(isolatedExact.statusCode).toBe(200);
    expect(isolatedExact.json<RelationshipArchivePageResponse>().items).toEqual(
      [],
    );

    const correspondence = await app.inject({
      method: "GET",
      url: `/api/agents/${agentId}/relationship-archive?filter=correspondence&limit=10`,
    });
    expect(correspondence.statusCode).toBe(200);
    expect(
      correspondence.json<RelationshipArchivePageResponse>().items,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: letterId,
          href: `/letters/${letterId}?agentId=${agentId}`,
          sourceIds: [letterId],
        }),
      ]),
    );

    const exactShareSource = await app.inject({
      method: "GET",
      url: `/api/agents/${agentId}/relationship-archive?entryId=${encodeURIComponent(`letter:${letterId}`)}&includePreviewText=false`,
    });
    expect(exactShareSource.statusCode).toBe(200);
    expect(exactShareSource.headers["cache-control"]).toBe("no-store");
    expect(
      exactShareSource.json<RelationshipArchivePageResponse>().items,
    ).toEqual([
      expect.objectContaining({
        id: letterId,
        agentId,
        entryType: "letter",
      }),
    ]);
    expect(
      exactShareSource.json<RelationshipArchivePageResponse>().items[0],
    ).not.toHaveProperty("previewText");
    expect(exactShareSource.body).not.toContain(PRIVATE_BODY);

    const defaultShare = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/relationship-share/preview`,
      payload: {
        templateVersion: "relationship-share-v1",
        letterId,
      },
    });
    expect(defaultShare.statusCode).toBe(200);
    expect(defaultShare.headers["cache-control"]).toBe("no-store");
    const safeProjection = defaultShare.json<RelationshipShareProjection>();
    expect(safeProjection).toMatchObject({
      exportMode: "local_png",
      sourceIds: [letterId],
      envelope: { letterId, waitingDays: 5 },
    });
    expect(safeProjection).not.toHaveProperty("redactedExcerpt");
    expect(JSON.stringify(safeProjection)).not.toContain(PRIVATE_BODY);
    expect(JSON.stringify(safeProjection)).not.toContain("publicUrl");

    const excerpt = "杭州见面的地点需要涂黑。";
    const excerptShare = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/relationship-share/preview`,
      payload: {
        templateVersion: "relationship-share-v1",
        letterId,
        includeEnvelope: false,
        includePostmark: false,
        includeWaitingDays: false,
        includeKeepsake: false,
        includeExcerpt: true,
        excerpt,
        redactions: [{ start: 0, end: 2, label: "place" }],
      },
    });
    expect(excerptShare.statusCode).toBe(200);
    expect(
      excerptShare.json<RelationshipShareProjection>().redactedExcerpt,
    ).toBe("██见面的地点需要涂黑。");
  });
});

function seedHttpDomainEvents(
  target: PersonaSimApp,
  agentId: string,
  count: number,
): void {
  const insert = target.personasim.store.database.prepare(
    `INSERT INTO domain_events(
       id, agent_id, stream_type, stream_id, stream_version, event_type,
       recorded_at_utc, effective_at_utc, payload_json, correlation_id,
       causation_id, idempotency_key
     ) VALUES (?, ?, 'life', ?, 1, 'archive.http.fixture', ?, ?, ?, NULL, NULL, ?)`,
  );
  target.personasim.store.database.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const id = `event-http-archive-${String(index).padStart(3, "0")}`;
      const atUtc = new Date(
        Date.parse("2026-09-01T00:00:00.000Z") + index * 60_000,
      ).toISOString();
      insert.run(
        id,
        agentId,
        `life-http-${index}`,
        atUtc,
        atUtc,
        JSON.stringify({ privateText: `DO NOT PROJECT ${index}` }),
        `archive-http:${index}`,
      );
    }
  })();
}
