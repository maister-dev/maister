import "server-only";

import { sql, type SQL } from "drizzle-orm";

export type VaultBindingAvailability =
  "available" | "disabled_attachment" | "disabled_memory";

export function vaultBindingAvailability(
  enabled: SQL,
  memoryEnabled: SQL,
): SQL {
  return sql`CASE
    WHEN (${enabled}) IS NOT TRUE THEN 'disabled_attachment'
    WHEN (${memoryEnabled}) IS NOT TRUE THEN 'disabled_memory'
    ELSE 'available' END`;
}

export function installationVaultAvailability(
  enabled: SQL,
  snapshot: SQL,
): SQL {
  return vaultBindingAvailability(
    enabled,
    sql`(${snapshot}->'installationGrant'->'memoryEnabled')='true'::jsonb`,
  );
}
