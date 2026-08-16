import {
  DuplicateServiceError,
  KernelError,
  ServiceNotFoundError,
} from "./errors.js";

const SERVICE_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.:/-][a-z0-9]+)*$/;

/** A compile-time typed reference. Runtime identity is its stable string id. */
export interface ServiceToken<T> {
  readonly id: string;
  readonly description?: string;
  readonly __serviceType?: (service: T) => T;
}

export function createServiceToken<T>(
  id: string,
  description?: string,
): ServiceToken<T> {
  if (id.length === 0 || id.length > 120 || !SERVICE_ID_PATTERN.test(id)) {
    throw new KernelError(
      "invalid_service_token",
      `Invalid service id: "${id}"`,
    );
  }
  return Object.freeze(
    description === undefined ? { id } : { id, description },
  );
}

interface ServiceEntry {
  readonly value: unknown;
  readonly owner?: string;
}

export interface RegisterServiceOptions {
  readonly owner?: string;
  readonly replace?: boolean;
}

export interface ServiceRegistrationInfo {
  readonly id: string;
  readonly owner?: string;
}

export class ServiceRegistry {
  readonly #entries = new Map<string, ServiceEntry>();

  public register<T>(
    token: ServiceToken<T>,
    service: T,
    options: RegisterServiceOptions = {},
  ): () => void {
    const previous = this.#entries.get(token.id);
    if (previous !== undefined && options.replace !== true) {
      throw new DuplicateServiceError(token.id);
    }

    const entry: ServiceEntry =
      options.owner === undefined
        ? { value: service }
        : { value: service, owner: options.owner };
    this.#entries.set(token.id, entry);

    let active = true;
    return () => {
      if (!active || this.#entries.get(token.id) !== entry) return;
      active = false;
      if (previous === undefined) this.#entries.delete(token.id);
      else this.#entries.set(token.id, previous);
    };
  }

  public resolve<T>(token: ServiceToken<T>): T {
    const entry = this.#entries.get(token.id);
    if (entry === undefined) throw new ServiceNotFoundError(token.id);
    return entry.value as T;
  }

  public optional<T>(token: ServiceToken<T>): T | undefined {
    return this.#entries.get(token.id)?.value as T | undefined;
  }

  public has<T>(tokenOrId: ServiceToken<T> | string): boolean {
    return this.#entries.has(
      typeof tokenOrId === "string" ? tokenOrId : tokenOrId.id,
    );
  }

  public ownerOf<T>(tokenOrId: ServiceToken<T> | string): string | undefined {
    return this.#entries.get(
      typeof tokenOrId === "string" ? tokenOrId : tokenOrId.id,
    )?.owner;
  }

  public registeredServices(): readonly ServiceRegistrationInfo[] {
    return [...this.#entries.entries()].map(([id, entry]) =>
      entry.owner === undefined ? { id } : { id, owner: entry.owner },
    );
  }

  public serviceIdsOwnedBy(owner: string): readonly string[] {
    return [...this.#entries.entries()]
      .filter(([, entry]) => entry.owner === owner)
      .map(([id]) => id)
      .sort();
  }

  public unregisterOwnedBy(owner: string): readonly string[] {
    const removed: string[] = [];
    for (const [id, entry] of this.#entries) {
      if (entry.owner === owner) {
        this.#entries.delete(id);
        removed.push(id);
      }
    }
    return removed.sort();
  }

  public clear(): void {
    this.#entries.clear();
  }
}
