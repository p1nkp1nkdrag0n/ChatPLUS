import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";

import { composeServer, type ServerKernelHandle } from "./composition/index.js";
import { readConfig, type ServerConfig } from "./config.js";
import type { Database } from "./db/connection.js";
import { ApiError } from "./domain/errors.js";
import { registerRoutes, type RouteServices } from "./http/routes.js";
import type { Clock } from "./runtime/clock.js";
import type { HourlyScheduler } from "./runtime/hourly-scheduler.js";

export type BuildAppOptions = {
  config?: ServerConfig;
  database?: Database;
  clock?: Clock;
  seedDemo?: boolean;
  startScheduler?: boolean;
  logger?: boolean;
};

export type PersonaSimApp = FastifyInstance & {
  personasim: RouteServices & {
    scheduler: HourlyScheduler;
    kernel: ServerKernelHandle;
  };
};

// A legal 500 KiB source can expand to roughly 3 MiB when every byte is
// represented as a six-byte JSON escape (for example, "\u0000"). Keep the
// transport envelope above that worst case while the domain schema continues
// to enforce the substantially smaller sourceText limit.
const JSON_BODY_LIMIT_BYTES = 4 * 1024 * 1024;

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<PersonaSimApp> {
  const config = options.config ?? readConfig();
  const app = Fastify({
    logger: options.logger === false ? false : { level: config.logLevel },
    bodyLimit: JSON_BODY_LIMIT_BYTES,
    requestIdHeader: "x-request-id",
  });
  const composition = await composeServer({
    config,
    logger: app.log,
    ...(options.database === undefined ? {} : { database: options.database }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const services = composition.routeServices;
  const { scheduler } = composition;
  const { store, characters, schedules, conversations } = services;

  try {
    app.addHook("onClose", async () => {
      await composition.dispose("fastify_close");
    });

    await app.register(cors, {
      origin: config.webOrigin.split(",").map((origin) => origin.trim()),
      credentials: false,
    });
    await app.register(multipart, {
      limits: { fileSize: 512_000, files: 1, fields: 20 },
    });

    app.setErrorHandler((error, request, reply) => {
      if (reply.sent) return;
      if (error instanceof ZodError) {
        void reply.code(400).send({
          error: {
            code: "validation_error",
            message: "Request validation failed.",
            issues: error.issues,
            requestId: request.id,
          },
        });
        return;
      }
      if (error instanceof ApiError) {
        void reply.code(error.statusCode).send({
          error: {
            code: error.code,
            message: error.message,
            ...(error.issues === undefined ? {} : { issues: error.issues }),
            requestId: request.id,
          },
        });
        return;
      }
      const reportedStatus =
        typeof error === "object" &&
        error !== null &&
        "statusCode" in error &&
        typeof error.statusCode === "number"
          ? error.statusCode
          : undefined;
      const reportedCode =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : undefined;
      const statusCode =
        reportedStatus !== undefined && reportedStatus < 500
          ? reportedStatus
          : 500;
      if (statusCode >= 500)
        request.log.error({ err: error }, "request failed");
      void reply.code(statusCode).send({
        error: {
          code:
            statusCode === 500
              ? "internal_error"
              : (reportedCode ?? "request_error"),
          message:
            statusCode === 500
              ? "An internal server error occurred."
              : error instanceof Error
                ? error.message
                : "The request failed.",
          requestId: request.id,
        },
      });
    });

    app.setNotFoundHandler((request, reply) => {
      void reply.code(404).send({
        error: {
          code: "route_not_found",
          message: "The requested route does not exist.",
          requestId: request.id,
        },
      });
    });

    registerRoutes(app, services);

    const shouldSeed = options.seedDemo ?? config.seedDemo;
    if (shouldSeed && store.countCharacters() === 0) {
      const demo = characters.createDemoCharacter();
      characters.publish(demo.id);
      await schedules.ensure72Hours(demo.id, true);
      conversations.createSession(demo.id, `与${demo.identity.name}的对话`);
    }

    if (
      options.startScheduler &&
      composition.kernel.bundle.capabilities.hourlySettlement
    ) {
      scheduler.start();
    }
    Object.assign(app, {
      personasim: { ...services, scheduler, kernel: composition.kernel },
    });
    return app as unknown as PersonaSimApp;
  } catch (error) {
    await composition.dispose("build_failed").catch((disposeError: unknown) => {
      app.log.error(
        { err: disposeError },
        "failed to dispose server composition",
      );
    });
    await app.close().catch((closeError: unknown) => {
      app.log.error(
        { err: closeError },
        "failed to close incomplete Fastify app",
      );
    });
    throw error;
  }
}
