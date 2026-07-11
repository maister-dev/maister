import type { ExecutorAgent } from "./types";

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

import { getAdapterRuntime } from "./adapter-registry";

const AdapterSmokeEvidenceSchema = z
  .object({
    status: z.enum(["ok", "skipped", "error"]),
    reason: z.string().min(1).optional(),
    checkedAt: z.string().datetime(),
    protocolVersion: z.number().int().positive().optional(),
  })
  .strict();

const ReadOnlySmokeEvidenceSchema = AdapterSmokeEvidenceSchema.extend({
  probeVersion: z.number().int().positive().optional(),
}).strict();

const AdapterSmokeCacheEntrySchema = AdapterSmokeEvidenceSchema.extend({
  readOnlySession: ReadOnlySmokeEvidenceSchema.optional(),
  // ADR-130: cached evidence that capability_guard enforcement is safe at the seam.
  capabilityEnforcement: AdapterSmokeEvidenceSchema.optional(),
}).strict();

const AdapterSmokeAdaptersSchema = z
  .object({
    claude: AdapterSmokeCacheEntrySchema.optional(),
    codex: AdapterSmokeCacheEntrySchema.optional(),
    gemini: AdapterSmokeCacheEntrySchema.optional(),
    opencode: AdapterSmokeCacheEntrySchema.optional(),
    mimo: AdapterSmokeCacheEntrySchema.optional(),
  })
  .strict();

const AdapterSmokeCacheV1Schema = z
  .object({
    version: z.literal(1),
    adapters: AdapterSmokeAdaptersSchema,
  })
  .strict();

const AdapterSmokeCacheV2Schema = z
  .object({
    version: z.literal(2),
    adapters: AdapterSmokeAdaptersSchema,
  })
  .strict();

const AdapterSmokeCacheSchema = z.union([
  AdapterSmokeCacheV1Schema,
  AdapterSmokeCacheV2Schema,
]);

type AdapterSmokeCacheEntry = z.infer<typeof AdapterSmokeCacheEntrySchema>;
type AdapterSmokeEvidence = z.infer<typeof AdapterSmokeEvidenceSchema>;

export type AdapterSmokeStatus =
  | "not_required"
  | "pending"
  | AdapterSmokeCacheEntry["status"];

export type AdapterSmokeDimensionStatus = AdapterSmokeStatus | "stale";

export type AdapterSmokeDiagnostic = {
  readonly status: AdapterSmokeStatus;
  readonly reason: string | null;
  readonly checkedAt: string | null;
  readonly protocolVersion: number | null;
  readonly readOnlySession: AdapterSmokeDimensionDiagnostic;
  readonly capabilityEnforcement: AdapterSmokeDimensionDiagnostic;
};

export type AdapterSmokeDimensionDiagnostic = {
  readonly status: AdapterSmokeDimensionStatus;
  readonly reason: string | null;
  readonly checkedAt: string | null;
  readonly protocolVersion: number | null;
  readonly probeVersion: number | null;
};

export type AdapterSmokeCacheRead = {
  readonly entries: Partial<Record<ExecutorAgent, AdapterSmokeCacheEntry>>;
  readonly error: string | null;
  readonly cacheVersion?: 1 | 2;
};

export type AdapterSmokeCacheWriteEntry = {
  readonly adapter: ExecutorAgent;
  readonly status: AdapterSmokeEvidence["status"];
  readonly reason?: string;
  readonly protocolVersion?: number;
  readonly readOnlySession?: {
    readonly status: AdapterSmokeEvidence["status"];
    readonly reason?: string;
    readonly protocolVersion?: number;
  };
  readonly capabilityEnforcement?: {
    readonly status: AdapterSmokeEvidence["status"];
    readonly reason?: string;
    readonly protocolVersion?: number;
  };
};

const SMOKE_REQUIRED_ADAPTERS: ReadonlySet<ExecutorAgent> = new Set([
  "gemini",
  "opencode",
  "mimo",
]);

export const READ_ONLY_SMOKE_PROBE_VERSION = 1;
const READ_ONLY_SMOKE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

function isMissingFile(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { readonly code?: unknown }).code === "ENOENT"
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function adapterSmokeCachePath(runtimeRoot: string): string {
  return (
    process.env.MAISTER_ADAPTER_SMOKE_CACHE_PATH ??
    join(runtimeRoot, "adapter-smoke-cache.json")
  );
}

export async function readAdapterSmokeCache(
  cachePath: string,
): Promise<AdapterSmokeCacheRead> {
  try {
    const raw = await readFile(cachePath, "utf8");
    const parsed = AdapterSmokeCacheSchema.safeParse(JSON.parse(raw));

    if (!parsed.success) {
      return {
        entries: {},
        error: `adapter smoke cache is malformed: ${parsed.error.message}`,
      };
    }

    return {
      entries: parsed.data.adapters,
      error: null,
      cacheVersion: parsed.data.version,
    };
  } catch (err) {
    if (isMissingFile(err)) return { entries: {}, error: null };

    return {
      entries: {},
      error: `adapter smoke cache cannot be read: ${errorMessage(err)}`,
    };
  }
}

export function smokeDiagnosticForAdapter(
  adapter: ExecutorAgent,
  cache: AdapterSmokeCacheRead,
  evaluatedAt: Date = new Date(),
): AdapterSmokeDiagnostic {
  const readOnlySession = readOnlySessionDiagnosticForAdapter(
    adapter,
    cache,
    evaluatedAt,
  );
  const capabilityEnforcement = capabilityEnforcementDiagnosticForAdapter(
    adapter,
    cache,
  );

  if (!SMOKE_REQUIRED_ADAPTERS.has(adapter)) {
    return {
      status: "not_required",
      reason: null,
      checkedAt: null,
      protocolVersion: null,
      readOnlySession,
      capabilityEnforcement,
    };
  }

  if (cache.error) {
    return {
      status: "error",
      reason: cache.error,
      checkedAt: null,
      protocolVersion: null,
      readOnlySession,
      capabilityEnforcement,
    };
  }

  const entry = cache.entries[adapter];

  if (!entry) {
    return {
      status: "pending",
      reason: `${adapter} ACP compatibility smoke has not been cached`,
      checkedAt: null,
      protocolVersion: null,
      readOnlySession,
      capabilityEnforcement,
    };
  }

  return {
    status: entry.status,
    reason: entry.reason ?? null,
    checkedAt: entry.checkedAt,
    protocolVersion: entry.protocolVersion ?? null,
    readOnlySession,
    capabilityEnforcement,
  };
}

function smokeDimensionDiagnostic(
  entry: AdapterSmokeEvidence,
): AdapterSmokeDimensionDiagnostic {
  return {
    status: entry.status,
    reason: entry.reason ?? null,
    checkedAt: entry.checkedAt,
    protocolVersion: entry.protocolVersion ?? null,
    probeVersion:
      "probeVersion" in entry && typeof entry.probeVersion === "number"
        ? entry.probeVersion
        : null,
  };
}

function staleReadOnlyReason(
  cacheVersion: 1 | 2 | undefined,
  entry: z.infer<typeof ReadOnlySmokeEvidenceSchema>,
  evaluatedAt: Date,
): string | null {
  if (cacheVersion !== 2) {
    return "read-only-session evidence uses legacy cache format";
  }

  if (entry.probeVersion !== READ_ONLY_SMOKE_PROBE_VERSION) {
    return `read-only-session probe version ${entry.probeVersion ?? "missing"} does not match ${READ_ONLY_SMOKE_PROBE_VERSION}`;
  }

  const checkedAtMs = Date.parse(entry.checkedAt);
  const evaluatedAtMs = evaluatedAt.getTime();

  if (checkedAtMs > evaluatedAtMs) {
    return "read-only-session evidence is future-dated";
  }

  if (evaluatedAtMs - checkedAtMs >= READ_ONLY_SMOKE_MAX_AGE_MS) {
    return "read-only-session evidence is seven days old or older";
  }

  return null;
}

function readOnlySessionDiagnosticForAdapter(
  adapter: ExecutorAgent,
  cache: AdapterSmokeCacheRead,
  evaluatedAt: Date,
): AdapterSmokeDimensionDiagnostic {
  if (getAdapterRuntime(adapter).readOnlySessionSmoke !== "required") {
    return {
      status: "not_required",
      reason: null,
      checkedAt: null,
      protocolVersion: null,
      probeVersion: null,
    };
  }

  if (cache.error) {
    return {
      status: "error",
      reason: cache.error,
      checkedAt: null,
      protocolVersion: null,
      probeVersion: null,
    };
  }

  const entry = cache.entries[adapter]?.readOnlySession;
  const genericEntry = cache.entries[adapter];

  if (!entry) {
    return {
      status: "pending",
      reason: `${adapter} read-only-session smoke has not been cached`,
      checkedAt: null,
      protocolVersion: null,
      probeVersion: null,
    };
  }

  if (entry.status === "ok" && genericEntry?.status !== "ok") {
    const genericStatus = genericEntry?.status ?? "missing";
    const genericReason = genericEntry?.reason
      ? `: ${genericEntry.reason}`
      : "";

    return {
      status: genericEntry?.status ?? "pending",
      reason: `${adapter} read-only-session smoke ignored because adapter ACP compatibility smoke is ${genericStatus}${genericReason}`,
      checkedAt: genericEntry?.checkedAt ?? null,
      protocolVersion: null,
      probeVersion: null,
    };
  }

  if (entry.status === "ok") {
    const staleReason = staleReadOnlyReason(
      cache.cacheVersion,
      entry,
      evaluatedAt,
    );

    if (staleReason) {
      return {
        ...smokeDimensionDiagnostic(entry),
        status: "stale",
        reason: staleReason,
      };
    }
  }

  return smokeDimensionDiagnostic(entry);
}

function capabilityEnforcementDiagnosticForAdapter(
  adapter: ExecutorAgent,
  cache: AdapterSmokeCacheRead,
): AdapterSmokeDimensionDiagnostic {
  if (getAdapterRuntime(adapter).capabilityEnforcementSmoke !== "required") {
    return {
      status: "not_required",
      reason: null,
      checkedAt: null,
      protocolVersion: null,
      probeVersion: null,
    };
  }

  if (cache.error) {
    return {
      status: "error",
      reason: cache.error,
      checkedAt: null,
      protocolVersion: null,
      probeVersion: null,
    };
  }

  const entry = cache.entries[adapter]?.capabilityEnforcement;
  const genericEntry = cache.entries[adapter];

  if (!entry) {
    return {
      status: "pending",
      reason: `${adapter} capability-enforcement smoke has not been cached`,
      checkedAt: null,
      protocolVersion: null,
      probeVersion: null,
    };
  }

  if (entry.status === "ok" && genericEntry?.status !== "ok") {
    const genericStatus = genericEntry?.status ?? "missing";
    const genericReason = genericEntry?.reason
      ? `: ${genericEntry.reason}`
      : "";

    return {
      status: genericEntry?.status ?? "pending",
      reason: `${adapter} capability-enforcement smoke ignored because adapter ACP compatibility smoke is ${genericStatus}${genericReason}`,
      checkedAt: genericEntry?.checkedAt ?? null,
      protocolVersion: null,
      probeVersion: null,
    };
  }

  return smokeDimensionDiagnostic(entry);
}

export async function writeAdapterSmokeCache(
  cachePath: string,
  entries: readonly AdapterSmokeCacheWriteEntry[],
): Promise<void> {
  const existing = await readAdapterSmokeCache(cachePath);
  const checkedAt = new Date().toISOString();
  const adapters: Partial<Record<ExecutorAgent, AdapterSmokeCacheEntry>> = {
    ...(existing.error ? {} : existing.entries),
  };

  for (const entry of entries) {
    // ADR-130: preserve the OTHER dimension when a write carries only one (the
    // readOnlySession and capabilityEnforcement rituals run as separate smoke
    // invocations) — a single-dimension write must not clobber the sibling.
    const prev = adapters[entry.adapter];

    adapters[entry.adapter] = {
      status: entry.status,
      checkedAt,
      ...(entry.reason ? { reason: entry.reason } : {}),
      ...(entry.protocolVersion
        ? { protocolVersion: entry.protocolVersion }
        : {}),
      ...(!entry.readOnlySession && prev?.readOnlySession
        ? { readOnlySession: prev.readOnlySession }
        : {}),
      ...(!entry.capabilityEnforcement && prev?.capabilityEnforcement
        ? { capabilityEnforcement: prev.capabilityEnforcement }
        : {}),
      ...(entry.readOnlySession
        ? {
            readOnlySession: {
              status: entry.readOnlySession.status,
              checkedAt,
              probeVersion: READ_ONLY_SMOKE_PROBE_VERSION,
              ...(entry.readOnlySession.reason
                ? { reason: entry.readOnlySession.reason }
                : {}),
              ...(entry.readOnlySession.protocolVersion
                ? { protocolVersion: entry.readOnlySession.protocolVersion }
                : {}),
            },
          }
        : {}),
      ...(entry.capabilityEnforcement
        ? {
            capabilityEnforcement: {
              status: entry.capabilityEnforcement.status,
              checkedAt,
              ...(entry.capabilityEnforcement.reason
                ? { reason: entry.capabilityEnforcement.reason }
                : {}),
              ...(entry.capabilityEnforcement.protocolVersion
                ? {
                    protocolVersion:
                      entry.capabilityEnforcement.protocolVersion,
                  }
                : {}),
            },
          }
        : {}),
    };
  }

  await persistAdapterSmokeCache(cachePath, adapters);
}

async function persistAdapterSmokeCache(
  cachePath: string,
  adapters: Partial<Record<ExecutorAgent, AdapterSmokeCacheEntry>>,
): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true });

  const temporaryPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;

  await writeFile(
    temporaryPath,
    `${JSON.stringify({ version: 2, adapters }, null, 2)}\n`,
    "utf8",
  );
  await rename(temporaryPath, cachePath);
}

export async function invalidateAdapterReadOnlySmokeCache(
  cachePath: string,
  adapter: ExecutorAgent,
): Promise<void> {
  const existing = await readAdapterSmokeCache(cachePath);

  if (existing.error) {
    throw new Error(existing.error);
  }

  const current = existing.entries[adapter];

  if (!current) return;

  const checkedAt = new Date().toISOString();
  const adapters: Partial<Record<ExecutorAgent, AdapterSmokeCacheEntry>> = {
    ...existing.entries,
    [adapter]: {
      ...current,
      readOnlySession: {
        status: "error",
        reason: "read-only-session probe is in progress",
        checkedAt,
        probeVersion: READ_ONLY_SMOKE_PROBE_VERSION,
      },
    },
  };

  await persistAdapterSmokeCache(cachePath, adapters);
}
