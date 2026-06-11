import "server-only";

import { inArray } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/services/tasks.ts).
const { users } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

export type ActorDTO = {
  type: "user" | "agent" | "system";
  id: string | null;
  label: string;
};

// The actor pair has no FK to users (polymorphic target, ADR-078 D3): a
// deleted user leaves a dangling id, rendered as the "former user" fallback.
export async function resolveActorLabels(
  pairs: Array<{ actorType: string; actorId: string | null }>,
  db?: Db,
): Promise<Map<string, string>> {
  const userIds = [
    ...new Set(
      pairs
        .filter((p) => p.actorType === "user" && p.actorId)
        .map((p) => p.actorId as string),
    ),
  ];

  if (userIds.length === 0) return new Map();

  const _db = (db ?? getDb()) as unknown as { select: any };
  const rows = (await _db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(inArray(users.id, userIds))) as Array<{
    id: string;
    name: string | null;
    email: string;
  }>;

  return new Map(rows.map((r) => [r.id, r.name ?? r.email]));
}

export function actorDTO(
  pair: { actorType: string; actorId: string | null },
  labels: Map<string, string>,
): ActorDTO {
  if (pair.actorType === "system") {
    return { type: "system", id: null, label: "system" };
  }
  if (pair.actorType === "user") {
    return {
      type: "user",
      id: pair.actorId,
      label: labels.get(pair.actorId ?? "") ?? "former user",
    };
  }

  return { type: "agent", id: pair.actorId, label: pair.actorId ?? "agent" };
}
