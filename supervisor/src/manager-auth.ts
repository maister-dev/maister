import type { FastifyInstance } from "fastify";

import { timingSafeEqual } from "node:crypto";

import {
  MANAGER_HOST_HEADER,
  readManagerCredential,
} from "../../runtime/manager-credential";

export function registerManagerAuthentication(
  app: FastifyInstance,
  credentialFile: string,
  hostKey: string,
): void {
  app.addHook("onRequest", async (request, reply) => {
    const header = request.headers.authorization;
    const supplied = header?.match(/^Bearer ([0-9a-f]{64})$/)?.[1];
    const route = request.routeOptions.url;

    if (supplied && request.headers[MANAGER_HOST_HEADER] === hostKey) {
      let expected: string;

      try {
        expected = await readManagerCredential(credentialFile);
      } catch {
        request.log.error(
          { route, outcome: "credential_unavailable" },
          "manager authentication",
        );

        return reply.code(503).send({
          code: "EXECUTOR_UNAVAILABLE",
          message: "Manager credential is unavailable",
          details: { reason: "manager_auth_unavailable" },
        });
      }

      if (timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
        request.log.debug(
          { route, outcome: "allowed" },
          "manager authentication",
        );
        reply.raw.setHeader(MANAGER_HOST_HEADER, hostKey);

        return;
      }
    }

    request.log.warn({ route, outcome: "denied" }, "manager authentication");

    return reply
      .header("www-authenticate", 'Bearer realm="maister-execution-host"')
      .code(401)
      .send({
        code: "PRECONDITION",
        message: "Manager authentication required",
        details: { reason: "manager_auth_required" },
      });
  });
}
