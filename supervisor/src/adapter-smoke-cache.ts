import type { ExecutorAgent } from "./types";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

const AdapterSmokeCacheEntrySchema = z
  .object({
    status: z.enum(["ok", "skipped", "error"]),
    reason: z.string().min(1).optional(),
    checkedAt: z.string().datetime(),
    protocolVersion: z.number().int().positive().optional(),
  })
  .strict();

const AdapterSmokeCacheSchema = z
  .object({
    version: z.literal(1),
    adapters: z
      .object({
        claude: AdapterSmokeCacheEntrySchema.optional(),
        codex: AdapterSmokeCacheEntrySchema.optional(),
        gemini: AdapterSmokeCacheEntrySchema.optional(),
        opencode: AdapterSmokeCacheEntrySchema.optional(),
        mimo: AdapterSmokeCacheEntrySchema.optional(),
      })
      .strict(),
  })
  .strict();

type AdapterSmokeCacheEntry = z.infer<typeof AdapterSmokeCacheEntrySchema>;

export type AdapterSmokeStatus =
  | "not_required"
  | "pending"
  | AdapterSmokeCacheEntry["status"];

export type AdapterSmokeDiagnostic = {
  readonly status: AdapterSmokeStatus;
  readonly reason: string | null;
  readonly checkedAt: string | null;
  readonly protocolVersion: number | null;
};

export type AdapterSmokeCacheRead = {
  readonly entries: Partial<Record<ExecutorAgent, AdapterSmokeCacheEntry>>;
  readonly error: string | null;
};

export type AdapterSmokeCacheWriteEntry = {
  readonly adapter: ExecutorAgent;
  readonly status: AdapterSmokeCacheEntry["status"];
  readonly reason?: string;
  readonly protocolVersion?: number;
};

const SMOKE_REQUIRED_ADAPTERS: ReadonlySet<ExecutorAgent> = new Set([
  "gemini",
  "opencode",
  "mimo",
]);

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

    return { entries: parsed.data.adapters, error: null };
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
): AdapterSmokeDiagnostic {
  if (!SMOKE_REQUIRED_ADAPTERS.has(adapter)) {
    return {
      status: "not_required",
      reason: null,
      checkedAt: null,
      protocolVersion: null,
    };
  }

  if (cache.error) {
    return {
      status: "error",
      reason: cache.error,
      checkedAt: null,
      protocolVersion: null,
    };
  }

  const entry = cache.entries[adapter];

  if (!entry) {
    return {
      status: "pending",
      reason: `${adapter} ACP compatibility smoke has not been cached`,
      checkedAt: null,
      protocolVersion: null,
    };
  }

  return {
    status: entry.status,
    reason: entry.reason ?? null,
    checkedAt: entry.checkedAt,
    protocolVersion: entry.protocolVersion ?? null,
  };
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
    adapters[entry.adapter] = {
      status: entry.status,
      checkedAt,
      ...(entry.reason ? { reason: entry.reason } : {}),
      ...(entry.protocolVersion
        ? { protocolVersion: entry.protocolVersion }
        : {}),
    };
  }

  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(
    cachePath,
    `${JSON.stringify({ version: 1, adapters }, null, 2)}\n`,
    "utf8",
  );
}
