import type { PluginManifest } from "@personasim/contracts";
import { describe, expect, it } from "vitest";

import {
  ActorQueue,
  DuplicateServiceError,
  PluginActivationError,
  PluginDependencyError,
  PluginRuntime,
  ServiceRegistry,
  TypedEventBus,
  createServiceToken,
  type KernelPlugin,
} from "./index.js";

interface TestEvents {
  ping: { value: number };
}

function manifest(
  id: string,
  requires: readonly string[] = [],
  provides: readonly string[] = [],
): PluginManifest {
  return {
    id,
    displayName: id,
    version: "1.0.0",
    apiVersion: 1,
    requires: [...requires],
    provides: [...provides],
  };
}

describe("ServiceRegistry", () => {
  it("resolves equivalent stable tokens and protects duplicate registrations", () => {
    const registry = new ServiceRegistry();
    const firstToken = createServiceToken<number>("test.answer");
    const equivalentToken = createServiceToken<number>("test.answer");
    const unregister = registry.register(firstToken, 42, {
      owner: "test.plugin",
    });

    expect(registry.resolve(equivalentToken)).toBe(42);
    expect(registry.ownerOf("test.answer")).toBe("test.plugin");
    expect(() => registry.register(equivalentToken, 7)).toThrow(
      DuplicateServiceError,
    );
    unregister();
    expect(registry.optional(firstToken)).toBeUndefined();
  });
});

describe("TypedEventBus", () => {
  it("supports automatic one-shot cleanup and reports all listener failures", async () => {
    const bus = new TypedEventBus<TestEvents>();
    const values: number[] = [];
    bus.once("ping", ({ value }) => {
      values.push(value);
    });
    await bus.emit("ping", { value: 1 });
    await bus.emit("ping", { value: 2 });
    expect(values).toEqual([1]);

    let secondRan = false;
    bus.on("ping", () => {
      throw new Error("first failure");
    });
    bus.on("ping", () => {
      secondRan = true;
      throw new Error("second failure");
    });
    await expect(bus.emit("ping", { value: 3 })).rejects.toBeInstanceOf(
      AggregateError,
    );
    expect(secondRan).toBe(true);
  });
});

describe("ActorQueue", () => {
  it("serializes one actor while allowing another actor to run", async () => {
    const queue = new ActorQueue<string>();
    const starts: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = queue.run("a", async () => {
      starts.push("a1");
      await gate;
    });
    const second = queue.run("a", () => {
      starts.push("a2");
    });
    const other = queue.run("b", () => {
      starts.push("b1");
    });
    await other;
    expect(starts).toEqual(["a1", "b1"]);
    expect(queue.pendingFor("a")).toBe(2);
    release();
    await Promise.all([first, second]);
    expect(starts).toEqual(["a1", "b1", "a2"]);
    expect(queue.pendingCount).toBe(0);
  });

  it("continues after a failed task", async () => {
    const queue = new ActorQueue<string>();
    await expect(
      queue.run("a", () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    await expect(queue.run("a", () => 42)).resolves.toBe(42);
  });
});

describe("PluginRuntime", () => {
  it("activates dependencies first and disposes in reverse order", async () => {
    const lifecycle: string[] = [];
    const runtime = new PluginRuntime<TestEvents>();
    const dependency: KernelPlugin<TestEvents> = {
      manifest: manifest("test.dependency"),
      setup: () => {
        lifecycle.push("start:dependency");
        return () => {
          lifecycle.push("stop:dependency");
        };
      },
    };
    const consumer: KernelPlugin<TestEvents> = {
      manifest: manifest("test.consumer", ["test.dependency"]),
      setup: () => {
        lifecycle.push("start:consumer");
        return () => {
          lifecycle.push("stop:consumer");
        };
      },
    };
    runtime.addMany([consumer, dependency]);

    await runtime.activate(["test.consumer"]);
    expect(runtime.activePluginIds).toEqual([
      "test.dependency",
      "test.consumer",
    ]);
    await runtime.disposeAll();
    expect(lifecycle).toEqual([
      "start:dependency",
      "start:consumer",
      "stop:consumer",
      "stop:dependency",
    ]);
  });

  it("automatically removes event subscriptions during disposal", async () => {
    const runtime = new PluginRuntime<TestEvents>();
    let calls = 0;
    runtime.add({
      manifest: manifest("test.subscriber"),
      setup: (context) => {
        context.events.on("ping", () => {
          calls += 1;
        });
      },
    });
    await runtime.activate();
    await runtime.events.emit("ping", { value: 1 });
    await runtime.disposeAll();
    await runtime.events.emit("ping", { value: 2 });
    expect(calls).toBe(1);
  });

  it("detects missing dependencies and cycles before setup", async () => {
    const missing = new PluginRuntime<TestEvents>();
    missing.add({
      manifest: manifest("test.consumer", ["test.missing"]),
      setup: () => undefined,
    });
    await expect(missing.activate()).rejects.toBeInstanceOf(
      PluginDependencyError,
    );

    const cyclic = new PluginRuntime<TestEvents>();
    cyclic.addMany([
      { manifest: manifest("test.a", ["test.b"]), setup: () => undefined },
      { manifest: manifest("test.b", ["test.a"]), setup: () => undefined },
    ]);
    await expect(cyclic.activate()).rejects.toMatchObject({
      code: "plugin_dependency_cycle",
    });
  });

  it("checks declared services and removes partial registrations", async () => {
    const runtime = new PluginRuntime<TestEvents>();
    const token = createServiceToken<number>("test.required");
    runtime.add({
      manifest: manifest("test.incomplete", [], [token.id]),
      setup: () => undefined,
    });

    await expect(runtime.activate()).rejects.toBeInstanceOf(
      PluginActivationError,
    );
    expect(runtime.services.has(token)).toBe(false);
    expect(runtime.activePluginIds).toEqual([]);
  });

  it("rolls back every newly activated plugin after a later failure", async () => {
    const lifecycle: string[] = [];
    const runtime = new PluginRuntime<TestEvents>();
    const token = createServiceToken<number>("test.value");
    runtime.addMany([
      {
        manifest: manifest("test.first", [], [token.id]),
        setup: ({ services }) => {
          services.provide(token, 1);
          lifecycle.push("start:first");
          return () => {
            lifecycle.push("stop:first");
          };
        },
      },
      {
        manifest: manifest("test.second", ["test.first"]),
        setup: (context) => {
          context.onDispose(() => {
            lifecycle.push("stop:second-partial");
          });
          throw new Error("boom");
        },
      },
    ]);

    await expect(runtime.activate()).rejects.toMatchObject({
      pluginId: "test.second",
    });
    expect(runtime.activePluginIds).toEqual([]);
    expect(runtime.services.has(token)).toBe(false);
    expect(lifecycle).toEqual([
      "start:first",
      "stop:second-partial",
      "stop:first",
    ]);
  });
});
