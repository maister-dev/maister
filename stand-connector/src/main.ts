import {
  accessSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

import { createAuthorityClient } from "./authority-client.ts";
import type { HealthProbe } from "./health.ts";
import {
  createStandHelper,
  type Component,
  type HelperTarget,
} from "./helper.ts";
import { openRestartJournal } from "./restart-journal.ts";
import { createSystemdDriver } from "./systemd.ts";

function setting(name: string): string {
  const value = process.env[name];

  if (!value) throw new Error(`Missing configuration setting ${name}`);

  return value;
}

function localFile(name: string, limit: number): Buffer {
  const path = setting(name);

  if (!isAbsolute(path))
    throw new Error(`${name} must be an absolute file path`);
  const metadata = statSync(path);

  if (!metadata.isFile() || metadata.size > limit)
    throw new Error(`${name} is not a bounded regular file`);

  return readFileSync(path);
}

function credential(name: string): string {
  const value = localFile(name, 1026)
    .toString("utf8")
    .replace(/\r?\n$/, "");

  if (!/^[!-~]{1,1024}$/.test(value))
    throw new Error(`${name} is not a valid service credential`);

  return value;
}

function executable(name: string): string {
  const path = setting(name);

  if (!isAbsolute(path) || !statSync(path).isFile())
    throw new Error(`${name} must name an absolute executable file`);
  accessSync(path, constants.X_OK);

  return path;
}

function integer(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid stand configuration object");

  return value as Record<string, unknown>;
}

function readComponent(raw: unknown): Component {
  const {
    id,
    scope,
    user,
    unit,
    actions,
    serviceManager,
    healthProbe,
    ...extra
  } = objectValue(raw);

  if (
    Object.keys(extra).length !== 0 ||
    typeof id !== "string" ||
    serviceManager !== "systemd" ||
    typeof unit !== "string" ||
    !(
      (scope === "system" && user === null) ||
      (scope === "user" && typeof user === "string")
    ) ||
    !Array.isArray(actions) ||
    actions.length < 1 ||
    actions.length > 4 ||
    new Set(actions).size !== actions.length ||
    !actions.every(
      (action): action is Component["actions"][number] =>
        action === "inspect" ||
        action === "logs" ||
        action === "restart" ||
        action === "verify",
    )
  )
    throw new Error("Invalid stand component configuration");

  return {
    id,
    scope,
    user,
    unit,
    actions,
    healthProbe: readHealthProbe(healthProbe),
  };
}

function readHealthProbe(raw: unknown): HealthProbe {
  const input = objectValue(raw);

  if (
    input.kind === "systemd" &&
    input.expectedState === "active" &&
    Object.keys(input).length === 2
  )
    return { kind: "systemd", expectedState: "active" };
  if (
    input.kind === "http" &&
    typeof input.url === "string" &&
    integer(input.expectedStatus, 100, 599) &&
    typeof input.expectedIdentity === "string" &&
    Object.keys(input).length === 4
  )
    return {
      kind: "http",
      url: input.url,
      expectedStatus: input.expectedStatus,
      expectedIdentity: input.expectedIdentity,
    };

  throw new Error("Invalid stand health probe configuration");
}

function readTarget(raw: unknown): HelperTarget {
  const { id, companyId, incarnationId, configRevision, components, ...extra } =
    objectValue(raw);

  if (
    Object.keys(extra).length !== 0 ||
    typeof id !== "string" ||
    typeof companyId !== "string" ||
    typeof incarnationId !== "string" ||
    !integer(configRevision, 1, Number.MAX_SAFE_INTEGER) ||
    !Array.isArray(components) ||
    components.length < 1 ||
    components.length > 32
  )
    throw new Error("Invalid stand target configuration");

  return {
    id,
    companyId,
    incarnationId,
    configRevision,
    components: components.map(readComponent),
  };
}

function loadTarget(): HelperTarget {
  const content = localFile("MAISTER_STAND_TARGET_CONFIG_FILE", 65_536);
  let parsed: unknown;

  try {
    parsed = JSON.parse(content.toString("utf8"));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error("Invalid stand target configuration JSON");
  }

  return readTarget(parsed);
}

function startup(): void {
  if (process.platform !== "linux")
    throw new Error("The stand helper requires Linux with systemd");
  const target = loadTarget();
  const stateDirectory = setting("MAISTER_STAND_STATE_DIRECTORY");

  if (!isAbsolute(stateDirectory))
    throw new Error("The stand journal requires an absolute state directory");
  const statePath = realpathSync(stateDirectory);
  const metadata = statSync(statePath);

  if (
    !metadata.isDirectory() ||
    metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o077) !== 0
  )
    throw new Error(
      "The stand journal requires a private state directory owned by the helper account",
    );
  const port = Number(process.env.MAISTER_STAND_PORT ?? "7443");
  const journalPages = Number(
    process.env.MAISTER_STAND_JOURNAL_PAGES ?? "65536",
  );

  if (!integer(port, 1, 65_535) || !integer(journalPages, 16, 65_536))
    throw new Error("Invalid stand listener port or journal capacity");
  const helperCredential = credential("MAISTER_STAND_HELPER_CREDENTIAL_FILE");
  const platformCredential = credential(
    "MAISTER_STAND_PLATFORM_CREDENTIAL_FILE",
  );
  const key = localFile("MAISTER_STAND_TLS_KEY_FILE", 65_536);
  const cert = localFile("MAISTER_STAND_TLS_CERT_FILE", 65_536);
  const authority = createAuthorityClient({
    origin: setting("MAISTER_STAND_AUTHORITY_ORIGIN"),
    serverName: setting("MAISTER_STAND_AUTHORITY_SERVER_NAME"),
    ca: localFile("MAISTER_STAND_AUTHORITY_CA_FILE", 65_536),
    certificate: cert,
    key,
    credential: helperCredential,
  });
  const manager = createSystemdDriver(
    {
      systemctl: executable("MAISTER_STAND_SYSTEMCTL"),
      journalctl: executable("MAISTER_STAND_JOURNALCTL"),
    },
    [helperCredential, platformCredential],
  );
  const journalPath = join(statePath, "state.sqlite");
  const journalFile = openSync(
    journalPath,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );

  try {
    const fileMetadata = fstatSync(journalFile);

    if (
      !fileMetadata.isFile() ||
      fileMetadata.uid !== metadata.uid ||
      fileMetadata.nlink !== 1
    )
      throw new Error(
        "The stand journal requires a regular file owned by the helper account",
      );
    fchmodSync(journalFile, 0o600);
  } finally {
    closeSync(journalFile);
  }
  const journal = openRestartJournal(
    journalPath,
    target.incarnationId,
    journalPages,
  );

  try {
    const server = createStandHelper({
      tls: {
        key,
        cert,
        ca: localFile("MAISTER_STAND_PLATFORM_CA_FILE", 65_536),
      },
      platformCertificateSha256: setting("MAISTER_STAND_PLATFORM_CERT_SHA256"),
      platformCredential,
      target,
      journal,
      authorize: authority.authorize,
      authorizeReceipt: authority.authorizeReceipt,
      authorizeLogs: authority.authorizeLogs,
      authorizeVerification: authority.authorizeVerification,
      manager,
    });

    server.on("close", journal.close);
    server.on("error", (error: NodeJS.ErrnoException) => {
      console.error(
        JSON.stringify({
          event: "stand_listener_failed",
          code: error.code ?? "UNKNOWN",
        }),
      );
      server.close();
      process.exitCode = 1;
    });
    process.once("SIGTERM", () => server.close());
    process.once("SIGINT", () => server.close());
    server.listen(port, process.env.MAISTER_STAND_HOST ?? "127.0.0.1", () => {
      console.info(
        JSON.stringify({
          event: "stand_helper_listening",
          port,
          targetIncarnation: target.incarnationId,
        }),
      );
    });
  } catch (error) {
    journal.close();
    throw error;
  }
}

try {
  startup();
} catch (error) {
  console.error(
    JSON.stringify({
      event: "stand_helper_startup_failed",
      reason:
        error instanceof Error &&
        error.constructor === Error &&
        !("code" in error)
          ? error.message
          : "configuration_or_state_unavailable",
    }),
  );
  process.exitCode = 1;
}
