import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AchievementPage,
  LetterDetailResponse,
  CorrespondenceMailboxResponse,
} from "@personasim/contracts";
import { buildApp, type PersonaSimApp } from "./app.js";
import { readConfig } from "./config.js";
import { FakeClock } from "./runtime/clock.js";
import { badgeVisualSpec } from "./services/achievement-service.js";

const NOW = "2026-09-03T04:00:00.000Z";
describe("achievement collection", () => {
  let app: PersonaSimApp;
  let directory: string;
  let clock: FakeClock;
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "chatplus-achievements-"));
    clock = new FakeClock(NOW);
    app = await buildApp({
      config: readConfig({
        nodeEnv: "test",
        databasePath: join(directory, "test.db"),
        assetStoragePath: join(directory, "assets"),
        developerRoutes: true,
        clockMode: "fake",
        seedDemo: false,
        keepsakeMode: "off",
        correspondenceMode: "enforced",
        instanceSecret: Buffer.alloc(32, 0x41).toString("base64"),
        llm: {
          provider: "fixture",
          baseUrl: "https://example.invalid",
          model: "fixture",
          timeoutMs: 1000,
          maxRetries: 0,
        },
      }),
      clock,
      seedDemo: false,
      startScheduler: false,
      logger: false,
    });
  });
  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const input = {
    name: "林间",
    worldSetting: "当代城市",
    workOrRole: "植物学家",
    coreTraits: ["细致", "温和"],
    dialogueStyle: "自然",
    tier: "high_fidelity",
    timezone: "Asia/Shanghai",
  };
  async function character(tier = "high_fidelity") {
    const draft = await app.personasim.characters.generate({ ...input, tier });
    return app.personasim.characters.publish(draft.id);
  }
  function page() {
    return app.personasim.achievements.list({ limit: 100 });
  }
  function setCloseness(id: string, value: number) {
    const state = app.personasim.store.getRuntimeState(id)!;
    state.relationship.closeness = value;
    state.revision += 1;
    app.personasim.store.updateRuntimeState(state);
  }

  it("counts Shanghai dates once, ignores backward clocks, and retains milestones after a gap", async () => {
    clock.setUtc("2026-12-31T15:59:59.000Z");
    await Promise.all(
      Array.from({ length: 4 }, () =>
        app.inject({ method: "POST", url: "/api/activity/visit", payload: {} }),
      ),
    );
    expect(page().items.map((item) => item.title)).toEqual(["初来乍到"]);
    clock.setUtc("2026-12-31T16:00:00.000Z");
    app.personasim.achievements.visit();
    clock.setUtc("2027-01-01T16:00:00.000Z");
    app.personasim.achievements.visit();
    expect(page().items.map((item) => item.title)).toContain("三日之约");
    clock.setUtc("2026-12-29T16:00:00.000Z");
    app.personasim.achievements.visit();
    expect(
      app.personasim.store.database
        .prepare("SELECT count(*) AS n FROM achievement_activity_days")
        .get(),
    ).toEqual({ n: 3 });
    clock.setUtc("2027-01-04T16:00:00.000Z");
    app.personasim.achievements.visit();
    expect(page().items).toHaveLength(2);
  });
  it("unlocks exactly the six continuous-day milestones across a year", () => {
    for (let day = 0; day < 365; day += 1) {
      clock.setUtc(DateTime.fromISO(NOW).plus({ days: day }).toUTC().toISO()!);
      app.personasim.achievements.visit();
    }
    expect(page().items).toHaveLength(6);
    expect(page().items.map((item) => item.title)).toContain("岁岁相伴");
  });
  it("does not award demo publishing, but awards a user publication once in its transaction", async () => {
    const demo = app.personasim.characters.createDemoCharacter();
    app.personasim.characters.publish(demo.id);
    expect(page().items).toHaveLength(0);
    const draft = await app.personasim.characters.generate(input);
    expect(() =>
      app.personasim.store.transaction(() => {
        app.personasim.characters.publish(draft.id);
        expect(page().items).toHaveLength(1);
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(page().items).toHaveLength(0);
    app.personasim.characters.publish(draft.id);
    app.personasim.characters.publish(draft.id);
    expect(page().items.map((item) => item.title)).toEqual(["故事的开端"]);
  });
  it("awards a successful chat on a demo character and ignores its idempotent replay", async () => {
    const draft = app.personasim.characters.createDemoCharacter();
    app.personasim.characters.publish(draft.id);
    const session = app.personasim.store.createSession(draft.id, "问候", NOW);
    for (let index = 0; index < 2; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/messages`,
        payload: {
          agentId: draft.id,
          text: "你好，很高兴认识你。",
          clientMessageId: "first-real-chat",
        },
      });
      expect([200, 201], response.body).toContain(response.statusCode);
    }
    expect(
      page().items.filter((item) => item.title === "第一声问候"),
    ).toHaveLength(1);
  });
  it("crosses thresholds per character, never revokes, and keeps lightweight inactive", async () => {
    const a = await character();
    const b = await character();
    const light = await character("lightweight");
    setCloseness(a.id, 0.299999);
    expect(
      page().items.filter((item) => item.category === "character"),
    ).toHaveLength(0);
    setCloseness(a.id, 1);
    setCloseness(a.id, 0.1);
    setCloseness(a.id, 1);
    setCloseness(b.id, 0.5);
    setCloseness(light.id, 1);
    const earned = page().items.filter((item) => item.category === "character");
    expect(earned).toHaveLength(7);
    expect(
      earned.filter((item) => item.badge.status === "pending"),
    ).toHaveLength(2);
    expect(earned.some((item) => item.agentId === light.id)).toBe(false);
    expect(() =>
      app.personasim.store.transaction(() => {
        setCloseness(b.id, 0.9);
        throw new Error("rollback");
      }),
    ).toThrow();
    expect(
      page().items.filter((item) => item.category === "character"),
    ).toHaveLength(7);
  });
  it("preserves collection snapshots after a character is deleted and pages without duplicates", async () => {
    const agent = await character();
    setCloseness(agent.id, 1);
    app.personasim.store.database
      .prepare("DELETE FROM characters WHERE id=?")
      .run(agent.id);
    const first = app.personasim.achievements.list({ limit: 2 });
    const second = app.personasim.achievements.list({
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(2);
    expect(
      new Set([...first.items, ...second.items].map((item) => item.id)).size,
    ).toBe(4);
    expect(first.agents).toEqual([{ id: agent.id, name: agent.identity.name }]);
  });
  it("freezes only published visual details and retains the earned-time relationship evidence", async () => {
    const draft = await app.personasim.characters.generate(input);
    app.personasim.characters.updateDraft(draft.id, {
      patch: {
        identity: {
          ...draft.identity,
          appearance: {
            summary: "银色短发与苔绿色围巾",
            distinctiveFeatures: ["苔绿色围巾"],
            presentationNotes: [],
          },
        },
      },
    });
    const published = app.personasim.characters.publish(draft.id);
    app.personasim.characters.updateDraft(draft.id, {
      patch: {
        identity: {
          ...published.identity,
          name: "尚未发布的名字",
          workOrRole: "尚未发布的职业",
          appearance: {
            summary: "尚未发布的红色长发",
            distinctiveFeatures: [],
            presentationNotes: [],
          },
        },
      },
    });
    setCloseness(draft.id, 0.9);
    const database = app.personasim.store.database;
    const profile = database
      .prepare(
        "SELECT profile_json FROM achievement_visual_profiles WHERE agent_id=?",
      )
      .get(draft.id) as { profile_json: string };
    expect(JSON.parse(profile.profile_json)).toEqual({
      name: published.identity.name,
      role: published.identity.workOrRole,
      setting: published.identity.worldSetting.slice(0, 500),
      appearance: "银色短发与苔绿色围巾",
      traits: published.persona.traits
        .slice(0, 4)
        .map((trait) => ({ name: trait.name.slice(0, 200) })),
    });
    const visual = badgeVisualSpec(profile.profile_json, "独一份纪念");
    expect(visual.motifs).toContain("银色短发与苔绿色围巾");
    expect(profile.profile_json).not.toMatch(
      /尚未发布|sourceRefs|origin|intensity|conversation|authorityAudit/u,
    );
    const evidence = database
      .prepare(
        "SELECT evidence_json FROM achievement_unlocks WHERE agent_id=? AND definition_key='relationship.90'",
      )
      .get(draft.id) as { evidence_json: string };
    expect(JSON.parse(evidence.evidence_json)).toEqual({
      beforeCloseness: 0.1,
      afterCloseness: 0.9,
      threshold: 0.9,
      revision: app.personasim.store.getRuntimeState(draft.id)!.revision,
    });
    setCloseness(draft.id, 0.1);
    database.prepare("DELETE FROM characters WHERE id=?").run(draft.id);
    expect(
      database
        .prepare(
          "SELECT evidence_json FROM achievement_unlocks WHERE agent_id=? AND definition_key='relationship.90'",
        )
        .get(draft.id),
    ).toEqual(evidence);
    expect(
      database
        .prepare(
          "SELECT profile_json FROM achievement_visual_profiles WHERE agent_id=?",
        )
        .get(draft.id),
    ).toEqual(profile);
  });
  it("exposes only earned mementos and persists notification acknowledgement", async () => {
    const agent = await character();
    setCloseness(agent.id, 0.9);
    const response = await app.inject({
      method: "GET",
      url: "/api/achievements",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<AchievementPage>();
    for (const key of [
      "definition_key",
      "threshold",
      "currentValue",
      "targetValue",
      "relationship.90",
      "evidence_id",
      "closeness",
      "stage",
    ])
      expect(response.body).not.toContain(key);
    await app.inject({
      method: "POST",
      url: "/api/achievements/notifications/ack",
      payload: { ids: body.notifications.map((item) => item.id) },
    });
    expect(page().notifications).toHaveLength(0);
    const detail = await app.inject({
      method: "GET",
      url: `/api/achievements/${body.items[0]!.id}`,
    });
    expect(detail.json()).toMatchObject({
      id: body.items[0]!.id,
      notificationRead: true,
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/activity/visit",
          payload: { date: "2030-01-01" },
        })
      ).statusCode,
    ).toBe(400);
  });
  it("creates a custom badge separately, keeps its image through profile edits, and shares encrypted-key storage", async () => {
    const agent = await character();
    setCloseness(agent.id, 0.9);
    const target = page().items.find(
      (item) => item.badge.status === "pending",
    )!;
    app.personasim.achievements.saveImageSettings({
      protocol: "fixture",
      baseUrl: "",
      model: "fixture",
      enabled: false,
      apiKey: "private-image-key",
    });
    expect(app.personasim.achievements.imageSettings().apiKeyConfigured).toBe(
      true,
    );
    const settings = await app.inject({
      method: "GET",
      url: "/api/achievement-image/settings",
    });
    expect(settings.body).not.toContain("private-image-key");
    app.personasim.store.database
      .prepare("UPDATE achievement_image_settings SET enabled=1")
      .run();
    await app.personasim.achievements.processNext();
    expect(app.personasim.achievements.get(target.id).badge.status).toBe(
      "ready",
    );
    const image = await app.inject({
      method: "GET",
      url: `/api/achievements/${target.id}/badge`,
    });
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toContain("image/webp");
    const before = image.rawPayload;
    app.personasim.characters.updateDraft(agent.id, {
      patch: { identity: { ...agent.identity, workOrRole: "天文学家" } },
    });
    await app.personasim.achievements.processNext();
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/achievements/${target.id}/badge`,
        })
      ).rawPayload,
    ).toEqual(before);
  });
  it("does not automatically retry an uncertain expired image lease", async () => {
    const agent = await character();
    setCloseness(agent.id, 0.9);
    app.personasim.store.database
      .prepare(
        "UPDATE achievement_image_settings SET protocol='fixture',enabled=1",
      )
      .run();
    app.personasim.store.database
      .prepare(
        "UPDATE achievement_badge_jobs SET status='generating',attempts=1,lease_until_utc=?",
      )
      .run(NOW);
    await app.personasim.achievements.processNext();
    expect(
      page().items.find(
        (item) => item.category === "character" && item.badge.key === "star",
      )?.badge.status,
    ).toBe("failed");
    expect(
      app.personasim.store.database
        .prepare("SELECT attempts,error_code FROM achievement_badge_jobs")
        .get(),
    ).toEqual({ attempts: 1, error_code: "image_outcome_unknown" });
  });
  it("keeps visual prompts small, character-specific, and independent of hidden relationship rules", () => {
    const a = badgeVisualSpec(
      JSON.stringify({
        name: "林间",
        role: "植物学家",
        setting: "森林",
        appearance: "银色短发与苔绿色围巾",
        traits: Array.from({ length: 8 }, () => ({ name: "细致" })),
      }),
      "独一份纪念",
    );
    const b = badgeVisualSpec(
      JSON.stringify({
        name: "星野",
        role: "天文学家",
        setting: "星空",
        traits: [{ name: "好奇" }],
      }),
      "独一份纪念",
    );
    expect(a).not.toEqual(b);
    expect(a.motifs).toContain("植物学家");
    expect(a.motifs).toContain("银色短发与苔绿色围巾");
    expect(a.motifs).toHaveLength(6);
    expect(JSON.stringify(a)).not.toMatch(
      /closeness|threshold|messages|sourceText/u,
    );
  });
  it("distinguishes sending, arrival at the character, incoming delivery, and opening", async () => {
    const agent = await character();
    const created = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/letters`,
      payload: {
        clientRequestId: "first-draft",
        subject: "一封信",
        body: "今天看见窗边的小树开花了，想和你分享。",
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(page().items.some((item) => item.title === "见字如面")).toBe(false);
    const id = created.json<LetterDetailResponse>().letter.id;
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/letters/${id}/seal`,
          payload: { clientRequestId: "first-seal" },
        })
      ).statusCode,
    ).toBe(200);
    expect(page().items.some((item) => item.title === "见字如面")).toBe(true);
    clock.setUtc("2026-09-09T04:00:00.000Z");
    await app.personasim.correspondence.catchUpAgent(agent.id);
    expect(page().items.some((item) => item.title === "远方回音")).toBe(false);
    clock.setUtc("2026-09-16T04:00:00.000Z");
    const mailbox = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/correspondence`,
    });
    expect(mailbox.statusCode, mailbox.body).toBe(200);
    const reply = mailbox
      .json<CorrespondenceMailboxResponse>()
      .letters.find((letter) => letter.direction === "agent_to_user");
    expect(reply?.status).toBe("delivered_unread");
    expect(page().items.some((item) => item.title === "远方回音")).toBe(true);
    expect(page().items.some((item) => item.title === "亲手启封")).toBe(false);
    const opened = await app.inject({
      method: "POST",
      url: `/api/letters/${reply!.id}/open`,
      payload: {},
    });
    expect(opened.statusCode, opened.body).toBe(200);
    expect(
      page().items.filter((item) => item.title === "亲手启封"),
    ).toHaveLength(1);
  });
});
