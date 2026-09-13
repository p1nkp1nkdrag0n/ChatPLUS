import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { registerRoutes, type RouteServices } from "../http/routes.js";
import { registerAchievementRoutes } from "../http/achievement-routes.js";

export type BusinessHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
) => unknown;
export interface BusinessRoute {
  method: string;
  url: string;
  handler: BusinessHandler;
}
export interface BusinessRegistry {
  routes: Map<string, BusinessRoute>;
  close(): void;
}

// This adapter records immutable handlers, each closed over ONE tenant's services.
// It neither switches global state nor opens a per-user listening socket.
export function collectBusinessRoutes(
  services: RouteServices,
): BusinessRegistry {
  const routes = new Map<string, BusinessRoute>();
  const closers: Array<(done: () => void) => void> = [];
  const registrar: Record<string, unknown> = {};
  for (const method of ["GET", "POST", "PATCH", "PUT", "DELETE"]) {
    registrar[method.toLowerCase()] = (
      url: string,
      handler: BusinessHandler,
    ) => {
      if (!isHostedBusinessRoute(method, url)) return registrar;
      const key = `${method} ${url}`;
      if (routes.has(key))
        throw new Error(`Duplicate hosted business route: ${key}`);
      routes.set(key, { method, url, handler });
      return registrar;
    };
  }
  registrar.addHook = (event: string, handler: (done: () => void) => void) => {
    if (event !== "preClose")
      throw new Error(`Unsupported business lifecycle: ${event}`);
    closers.push(handler);
    return registrar;
  };
  registerRoutes(registrar as unknown as FastifyInstance, services);
  registerAchievementRoutes(registrar as unknown as FastifyInstance, services);
  return {
    routes,
    close() {
      for (const close of closers) close(() => undefined);
    },
  };
}

export function isHostedBusinessRoute(_method: string, url: string): boolean {
  return (
    !url.startsWith("/api/developer/") &&
    !url.startsWith("/api/achievement-image/") &&
    ![
      "/api/health",
      "/api/settings",
      "/api/demo/ensure",
      "/api/agents/:id/state",
      "/api/agents/:id/schedule",
      "/api/agents/:id/schedule/effects",
      "/api/agents/:id/memories",
    ].includes(url)
  );
}

/** Discover the same route definitions without creating a user or opening a DB.
 * Registrations may construct services but must never execute business work.
 * The throwing stubs make a future registration-time side effect fail closed. */
export function businessRouteManifest(): Array<{
  method: string;
  url: string;
}> {
  const unusable = new Proxy(() => undefined, {
    get(_target, key) {
      if (key === "then") return undefined;
      return unusable;
    },
    apply() {
      throw new Error("Business work must not run during route registration");
    },
  });
  const services = new Proxy(
    { config: { developerRoutes: false } },
    {
      get(target, key) {
        return key === "config" ? target.config : unusable;
      },
    },
  );
  const registry = collectBusinessRoutes(services as unknown as RouteServices);
  return [...registry.routes.values()].map(({ method, url }) => ({
    method,
    url,
  }));
}
