import {
  PluginManifestSchema,
  type PluginManifest,
} from "@personasim/contracts";

import {
  PluginActivationError,
  PluginDependencyError,
  PluginDisposalError,
  KernelError,
} from "./errors.js";
import {
  type EventHandler,
  type EventName,
  type EventSubscriptionOptions,
  TypedEventBus,
} from "./event-bus.js";
import { type KernelLogger, noopLogger, withLogContext } from "./logger.js";
import { type ServiceToken, ServiceRegistry } from "./service-registry.js";

export type MaybePromise<T> = T | Promise<T>;
export type PluginDisposer = () => MaybePromise<void>;

export interface DisposablePluginResource {
  dispose(): MaybePromise<void>;
}

export interface PluginServiceAccess {
  provide<T>(token: ServiceToken<T>, service: T): () => void;
  register<T>(token: ServiceToken<T>, service: T): () => void;
  resolve<T>(token: ServiceToken<T>): T;
  optional<T>(token: ServiceToken<T>): T | undefined;
  has<T>(tokenOrId: ServiceToken<T> | string): boolean;
}

export interface PluginEventAccess<TEvents extends object> {
  on<TKey extends EventName<TEvents>>(
    event: TKey,
    handler: EventHandler<TEvents[TKey]>,
    options?: EventSubscriptionOptions,
  ): () => void;
  once<TKey extends EventName<TEvents>>(
    event: TKey,
    handler: EventHandler<TEvents[TKey]>,
    options?: EventSubscriptionOptions,
  ): () => void;
  emit<TKey extends EventName<TEvents>>(
    event: TKey,
    payload: TEvents[TKey],
  ): Promise<void>;
}

export interface PluginContext<TEvents extends object> {
  readonly pluginId: string;
  readonly services: PluginServiceAccess;
  readonly events: PluginEventAccess<TEvents>;
  readonly logger: KernelLogger;
  onDispose(disposer: PluginDisposer): void;
}

export type PluginSetupResult =
  void | PluginDisposer | DisposablePluginResource;

export interface KernelPlugin<TEvents extends object = Record<string, never>> {
  readonly manifest: PluginManifest;
  setup(context: PluginContext<TEvents>): MaybePromise<PluginSetupResult>;
}

interface RegisteredPlugin<TEvents extends object> {
  readonly plugin: KernelPlugin<TEvents>;
  readonly manifest: PluginManifest;
}

interface ActivePlugin<
  TEvents extends object,
> extends RegisteredPlugin<TEvents> {
  readonly disposers: PluginDisposer[];
}

export interface PluginRuntimeOptions<TEvents extends object> {
  readonly services?: ServiceRegistry;
  readonly events?: TypedEventBus<TEvents>;
  readonly logger?: KernelLogger;
}

export class PluginRuntime<TEvents extends object = Record<string, never>> {
  public readonly services: ServiceRegistry;
  public readonly events: TypedEventBus<TEvents>;
  readonly #logger: KernelLogger;
  readonly #catalog = new Map<string, RegisteredPlugin<TEvents>>();
  readonly #active = new Map<string, ActivePlugin<TEvents>>();
  readonly #activationOrder: string[] = [];

  public constructor(options: PluginRuntimeOptions<TEvents> = {}) {
    this.services = options.services ?? new ServiceRegistry();
    this.events = options.events ?? new TypedEventBus<TEvents>();
    this.#logger = options.logger ?? noopLogger;
  }

  public add(plugin: KernelPlugin<TEvents>): void {
    this.addMany([plugin]);
  }

  /** Validate the whole batch before changing the runtime catalog. */
  public addMany(plugins: readonly KernelPlugin<TEvents>[]): void {
    const parsed: RegisteredPlugin<TEvents>[] = [];
    const incomingIds = new Set<string>();
    for (const plugin of plugins) {
      const result = PluginManifestSchema.safeParse(plugin.manifest);
      if (!result.success) {
        throw new KernelError(
          "invalid_plugin_manifest",
          `Invalid plugin manifest: ${result.error.issues.map((issue) => issue.message).join("; ")}`,
          { cause: result.error },
        );
      }
      const id = result.data.id;
      if (this.#catalog.has(id) || incomingIds.has(id)) {
        throw new KernelError(
          "duplicate_plugin",
          `Plugin "${id}" is already registered`,
        );
      }
      incomingIds.add(id);
      parsed.push({ plugin, manifest: result.data });
    }
    for (const entry of parsed) this.#catalog.set(entry.manifest.id, entry);
  }

  public async activatePlugins(
    plugins: readonly KernelPlugin<TEvents>[],
  ): Promise<readonly string[]> {
    this.addMany(plugins);
    return this.activate(plugins.map((plugin) => plugin.manifest.id));
  }

  /** Activate selected plugins and their dependencies, or every catalog entry when omitted. */
  public async activate(
    pluginIds?: readonly string[],
  ): Promise<readonly string[]> {
    const order = this.#topologicalOrder(
      pluginIds ?? [...this.#catalog.keys()],
    );
    const activatedNow: string[] = [];

    for (const pluginId of order) {
      if (this.#active.has(pluginId)) continue;
      const registered = this.#catalog.get(pluginId);
      if (registered === undefined) {
        throw new PluginDependencyError(
          "plugin_dependency_missing",
          `Plugin "${pluginId}" is not registered`,
          [pluginId],
        );
      }

      const disposers: PluginDisposer[] = [];
      try {
        if (this.services.serviceIdsOwnedBy(pluginId).length > 0) {
          throw new KernelError(
            "plugin_provides_mismatch",
            `Plugin "${pluginId}" already owns services before activation`,
          );
        }
        const context = this.#createContext(registered.manifest, disposers);
        const setupResult = await registered.plugin.setup(context);
        const returnedDisposer = toDisposer(setupResult);
        if (returnedDisposer !== undefined) disposers.push(returnedDisposer);
        this.#assertProvidedServices(registered.manifest);

        this.#active.set(pluginId, { ...registered, disposers });
        this.#activationOrder.push(pluginId);
        activatedNow.push(pluginId);
        this.#logger.info("Plugin activated", { pluginId });
      } catch (error) {
        const rollbackErrors = await this.#cleanupPartial(pluginId, disposers);
        for (const activeId of [...activatedNow].reverse()) {
          rollbackErrors.push(...(await this.#deactivateInternal(activeId)));
        }
        throw new PluginActivationError(pluginId, error, rollbackErrors);
      }
    }

    return activatedNow;
  }

  public isActive(pluginId: string): boolean {
    return this.#active.has(pluginId);
  }

  public get activePluginIds(): readonly string[] {
    return [...this.#activationOrder];
  }

  public get registeredPluginIds(): readonly string[] {
    return [...this.#catalog.keys()];
  }

  public async disposeAll(): Promise<void> {
    const failures: { pluginId: string; error: unknown }[] = [];
    for (const pluginId of [...this.#activationOrder].reverse()) {
      const errors = await this.#deactivateInternal(pluginId);
      failures.push(...errors.map((error) => ({ pluginId, error })));
    }
    if (failures.length > 0) throw new PluginDisposalError(failures);
  }

  #createContext(
    manifest: PluginManifest,
    disposers: PluginDisposer[],
  ): PluginContext<TEvents> {
    const declaredServices = new Set(manifest.provides);
    const provide = <T>(token: ServiceToken<T>, service: T): (() => void) => {
      if (!declaredServices.has(token.id)) {
        throw new KernelError(
          "plugin_provides_mismatch",
          `Plugin "${manifest.id}" registered undeclared service "${token.id}"`,
        );
      }
      return this.services.register(token, service, { owner: manifest.id });
    };
    const trackSubscription = (unsubscribe: () => void): (() => void) => {
      disposers.push(unsubscribe);
      return unsubscribe;
    };

    return {
      pluginId: manifest.id,
      services: {
        provide,
        register: provide,
        resolve: <T>(token: ServiceToken<T>) => this.services.resolve(token),
        optional: <T>(token: ServiceToken<T>) => this.services.optional(token),
        has: (tokenOrId) => this.services.has(tokenOrId),
      },
      events: {
        on: (event, handler, options) =>
          trackSubscription(this.events.on(event, handler, options)),
        once: (event, handler, options) =>
          trackSubscription(this.events.once(event, handler, options)),
        emit: (event, payload) => this.events.emit(event, payload),
      },
      logger: withLogContext(this.#logger, { pluginId: manifest.id }),
      onDispose: (disposer) => {
        disposers.push(disposer);
      },
    };
  }

  #assertProvidedServices(manifest: PluginManifest): void {
    const expected = [...manifest.provides].sort();
    const actual = [...this.services.serviceIdsOwnedBy(manifest.id)].sort();
    if (
      expected.length !== actual.length ||
      expected.some((serviceId, index) => serviceId !== actual[index])
    ) {
      throw new KernelError(
        "plugin_provides_mismatch",
        `Plugin "${manifest.id}" declared [${expected.join(", ")}] but provided [${actual.join(", ")}]`,
      );
    }
  }

  #topologicalOrder(requestedIds: readonly string[]): string[] {
    const visiting: string[] = [];
    const visited = new Set<string>();
    const result: string[] = [];

    const visit = (pluginId: string): void => {
      if (this.#active.has(pluginId) || visited.has(pluginId)) return;
      const cycleAt = visiting.indexOf(pluginId);
      if (cycleAt >= 0) {
        const cycle = [...visiting.slice(cycleAt), pluginId];
        throw new PluginDependencyError(
          "plugin_dependency_cycle",
          `Plugin dependency cycle: ${cycle.join(" -> ")}`,
          cycle,
        );
      }
      const entry = this.#catalog.get(pluginId);
      if (entry === undefined) {
        throw new PluginDependencyError(
          "plugin_dependency_missing",
          `Required plugin "${pluginId}" is not registered`,
          [pluginId],
        );
      }

      visiting.push(pluginId);
      for (const dependencyId of entry.manifest.requires) visit(dependencyId);
      visiting.pop();
      visited.add(pluginId);
      result.push(pluginId);
    };

    for (const pluginId of requestedIds) visit(pluginId);
    return result;
  }

  async #cleanupPartial(
    pluginId: string,
    disposers: readonly PluginDisposer[],
  ): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (const dispose of [...disposers].reverse()) {
      try {
        await dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    this.services.unregisterOwnedBy(pluginId);
    return errors;
  }

  async #deactivateInternal(pluginId: string): Promise<unknown[]> {
    const active = this.#active.get(pluginId);
    if (active === undefined) return [];
    const errors = await this.#cleanupPartial(pluginId, active.disposers);
    this.#active.delete(pluginId);
    const orderIndex = this.#activationOrder.lastIndexOf(pluginId);
    if (orderIndex >= 0) this.#activationOrder.splice(orderIndex, 1);
    this.#logger.info("Plugin disposed", { pluginId });
    return errors;
  }
}

function toDisposer(result: PluginSetupResult): PluginDisposer | undefined {
  if (typeof result === "function") return result;
  if (result !== undefined) return () => result.dispose();
  return undefined;
}
