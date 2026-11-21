import "server-only";

import type { SQL } from "drizzle-orm";

import { sql } from "drizzle-orm";

import { projectTokens } from "@/lib/db/schema";

/** An exact current project grant is required at admission and receipt application. */
export function projectWaitSignalGrant(
  projectId: string,
  token: string | SQL,
): SQL {
  return sql`${projectTokens.id} = ${token}
    AND ${projectTokens.project_id} = ${projectId}
    AND ${projectTokens.token_kind} = 'project'
    AND ${projectTokens.scopes} ? 'waits:signal'
    AND ${projectTokens.revoked_at} IS NULL
    AND (${projectTokens.expires_at} IS NULL OR ${projectTokens.expires_at} > clock_timestamp())`;
}
