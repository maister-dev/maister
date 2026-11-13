import "server-only";

import { readFile } from "node:fs/promises";
import { isIP } from "node:net";

import pino from "pino";

import { startStandAuthorityIngress } from "./authority-ingress";
import { authorizeStandCallback } from "./authority-permit";

import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";

const log = pino({ name: "stand-authority-runtime" });

/** Start the dedicated mTLS callback listener when its host settings are present. */
export async function startConfiguredStandAuthority(): Promise<
  () => Promise<void>
> {
  const rawPort = process.env.MAISTER_STAND_AUTHORITY_PORT;
  const host = process.env.MAISTER_STAND_AUTHORITY_HOST;
  const caPath = process.env.MAISTER_STAND_AUTHORITY_CA_FILE;
  const certPath = process.env.MAISTER_STAND_AUTHORITY_CERT_FILE;
  const keyPath = process.env.MAISTER_STAND_AUTHORITY_KEY_FILE;

  if (
    [rawPort, host, caPath, certPath, keyPath].every(
      (value) => value === undefined,
    )
  )
    return async () => {};
  const port = Number(rawPort);

  if (
    !rawPort ||
    !/^\d+$/.test(rawPort) ||
    port < 1 ||
    port > 65_535 ||
    !host ||
    !isIP(host) ||
    !caPath ||
    !certPath ||
    !keyPath
  )
    throw new MaisterError(
      "CONFIG",
      "Stand authority requires a bind IP, TCP port and readable CA, certificate and key files",
    );
  const [ca, cert, key] = await Promise.all([
    readFile(caPath),
    readFile(certPath),
    readFile(keyPath),
  ]).catch((error: NodeJS.ErrnoException) => {
    log.error(
      { errorCode: error.code },
      "stand authority TLS file read failed",
    );
    throw new MaisterError(
      "CONFIG",
      "Stand authority TLS files could not be read",
    );
  });
  const db = getDb();
  const listener = await startStandAuthorityIngress(
    { ca, cert, key },
    { port, host },
    async (request) => ({
      status: 200,
      body: await authorizeStandCallback(db, request),
    }),
  );

  log.info(
    { host: listener.address.address, port: listener.address.port },
    "stand authority listener ready",
  );

  return listener.close;
}
