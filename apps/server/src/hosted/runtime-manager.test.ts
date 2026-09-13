import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { HostedRuntimeManager, type TenantRuntime } from "./runtime-manager.js";
import type { HostedModelSnapshot as HostedModel } from "./types.js";

let database: Database | undefined;
afterEach(() => database?.close());

function fixture() {
  database = openDatabase(":memory:");
  runMigrations(database);
  const db = database;
  let models = [
    {
      kind: "text",
      enabled: true,
      routeId: "first",
      displayName: "First",
      maxOutputTokens: 8192,
    },
  ] as HostedModel[];
  let defaultId = "first";
  // syncModels needs only the model catalog; no account, files or network.
  const manager = new HostedRuntimeManager({
    control: {
      listModels: () => models,
      resolvePurpose: () => ({ routeId: defaultId }),
    },
  } as unknown as ConstructorParameters<typeof HostedRuntimeManager>[0]);
  const runtime = {
    composition: { routeServices: { store: { database: db } } },
  } as unknown as TenantRuntime;
  return {
    sync: () => manager.syncModels(runtime),
    changes: () =>
      (db.prepare("SELECT total_changes() AS total").get() as { total: number })
        .total,
    provider: () =>
      db
        .prepare(
          "SELECT models_json,updated_at_utc FROM llm_providers WHERE id='hosted'",
        )
        .get() as { models_json: string; updated_at_utc: string },
    defaultSelection: () =>
      JSON.parse(
        (
          db
            .prepare(
              "SELECT default_selection_json AS value FROM llm_settings WHERE id=1",
            )
            .get() as { value: string }
        ).value,
      ) as unknown,
    setModels: (value: HostedModel[]) => {
      models = value;
    },
    setDefault: (value: string) => {
      defaultId = value;
    },
  };
}

describe("managed model synchronization", () => {
  it("does not write or touch timestamps when repeated requests see the same catalog", () => {
    const f = fixture();
    f.sync();
    const initial = f.provider();
    const before = f.changes();
    f.sync();
    f.sync();
    expect(f.changes() - before).toBe(0);
    expect(f.provider()).toEqual(initial);
  });

  it("persists changed catalog capabilities and default selection independently", () => {
    const f = fixture();
    f.sync();
    f.setModels([
      {
        kind: "text",
        enabled: true,
        routeId: "second",
        displayName: "Second",
        maxOutputTokens: 4096,
        maxContextTokens: 65536,
      },
    ] as HostedModel[]);
    const beforeCatalog = f.changes();
    f.sync();
    expect(f.changes() - beforeCatalog).toBe(1);
    expect(JSON.parse(f.provider().models_json)).toMatchObject([
      {
        id: "second",
        capabilities: { maxOutputTokens: 4096, maxContextTokens: 65536 },
      },
    ]);
    f.setDefault("second");
    const beforeDefault = f.changes();
    f.sync();
    expect(f.changes() - beforeDefault).toBe(1);
    expect(f.defaultSelection()).toEqual({
      providerId: "hosted",
      modelId: "second",
    });
  });
});
