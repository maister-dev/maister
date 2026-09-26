import "server-only";

import type { RunnerCatalogEntry } from "@/lib/acp-runners/resolve";

import { eq } from "drizzle-orm";
import pino from "pino";

import {
  librarianAvailabilityOf,
  librarianRunnerIneligibility,
  type LibrarianAvailabilityState,
} from "./settings-view";

import { loadRunnerCatalog } from "@/lib/acp-runners/catalog";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { platformRuntimeSettings } = schemaModule as unknown as Record<
  string,
  any
>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "librarian.settings",
  level: process.env.LOG_LEVEL ?? "info",
});

export type { LibrarianAvailabilityState };

export type LibrarianSettings = {
  enabled: boolean;
  runnerId: string | null;
  runner: RunnerCatalogEntry | null;
  availability: LibrarianAvailabilityState;
};

export { librarianRunnerIneligibility };

export async function readLibrarianSettings(
  db: Db,
): Promise<LibrarianSettings> {
  const [row] = await db
    .select({
      enabled: platformRuntimeSettings.librarianEnabled,
      runnerId: platformRuntimeSettings.librarianRunnerId,
    })
    .from(platformRuntimeSettings)
    .where(eq(platformRuntimeSettings.id, "singleton"))
    .limit(1);
  const enabled = row?.enabled === true;
  const runnerId: string | null = row?.runnerId ?? null;
  const runner = runnerId
    ? ((await loadRunnerCatalog(db)).find((entry) => entry.id === runnerId) ??
      null)
    : null;

  return {
    enabled,
    runnerId,
    runner,
    availability: librarianAvailabilityOf(enabled, runner),
  };
}

/** The refusal a message send gets when the librarian cannot admit it. */
export function availabilityRefusal(
  state: LibrarianAvailabilityState,
): MaisterError | null {
  if (state === "ready") return null;
  log.warn({ state }, "librarian unavailable");
  if (state === "disabled")
    return new MaisterError("CONFIG", "The librarian is disabled", {
      details: { reason: "librarian_disabled" },
    });

  return new MaisterError(
    "EXECUTOR_UNAVAILABLE",
    "No ready librarian runner is configured",
    { details: { reason: `librarian_${state}` } },
  );
}

/** ADR-183 (LCV-11): the admin's enable toggle and runner choice. `runnerId`
 * undefined leaves the runner as it is; null clears it. A runner must exist,
 * be enabled and be eligible (read-only-capable, never skipping permissions);
 * readiness is reported, not required. Disabling stops admission only. */
export async function updateLibrarianSettings(
  input: { enabled: boolean; runnerId?: string | null },
  actorUserId: string,
  db: Db,
): Promise<LibrarianSettings> {
  if (input.runnerId) {
    const runner = (await loadRunnerCatalog(db)).find(
      (entry) => entry.id === input.runnerId,
    );
    const refusal = !runner
      ? "runner_missing"
      : !runner.enabled
        ? "runner_disabled"
        : librarianRunnerIneligibility(runner);

    if (refusal) {
      log.warn(
        { runnerId: input.runnerId, refusal, actorUserId },
        "librarian runner refused",
      );
      throw new MaisterError(
        "CONFIG",
        "This runner cannot host the librarian",
        { details: { reason: refusal } },
      );
    }
  }
  const updated = await db
    .update(platformRuntimeSettings)
    .set({
      librarianEnabled: input.enabled,
      ...(input.runnerId !== undefined
        ? { librarianRunnerId: input.runnerId }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(platformRuntimeSettings.id, "singleton"))
    .returning({ id: platformRuntimeSettings.id });

  if (updated.length === 0)
    throw new MaisterError(
      "CONFIG",
      "Platform runtime settings are not initialized",
      { details: { reason: "settings_missing" } },
    );
  const settings = await readLibrarianSettings(db);

  log.info(
    { enabled: settings.enabled, runnerId: settings.runnerId, actorUserId },
    "librarian settings updated",
  );

  return settings;
}
