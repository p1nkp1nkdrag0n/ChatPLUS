import { timingSafeEqual } from "node:crypto";

import type { FastifyInstance } from "fastify";

export const DESKTOP_SESSION_HEADER = "x-dearvale-desktop-token";

/** Guard all desktop content, including assets and EventSource connections.
 * The token stays in the main process, never in a URL or renderer storage. */
export function registerDesktopSession(
  app: FastifyInstance,
  token: string,
): void {
  if (!/^[a-f0-9]{64}$/u.test(token)) {
    throw new TypeError(
      "A desktop session requires a 32-byte hexadecimal token.",
    );
  }
  const expectedToken = Buffer.from(token);

  app.addHook("onRequest", async (request, reply) => {
    const supplied = request.headers[DESKTOP_SESSION_HEADER];
    const suppliedToken =
      typeof supplied === "string" ? Buffer.from(supplied) : undefined;
    if (
      suppliedToken === undefined ||
      suppliedToken.length !== expectedToken.length ||
      !timingSafeEqual(suppliedToken, expectedToken)
    ) {
      return reply.code(401).send({
        error: {
          code: "desktop_session_required",
          message: "Open this page in Dearvale Desktop.",
        },
      });
    }

    const address = app.server.address();
    const origin =
      address !== null && typeof address !== "string"
        ? `http://127.0.0.1:${address.port}`
        : undefined;
    if (
      origin === undefined ||
      request.headers.host !== new URL(origin).host ||
      (request.headers.origin !== undefined &&
        request.headers.origin !== origin) ||
      request.headers["sec-fetch-site"] === "cross-site"
    ) {
      return reply.code(403).send({
        error: {
          code: "desktop_origin_forbidden",
          message: "This origin cannot access the desktop session.",
        },
      });
    }
  });
}
