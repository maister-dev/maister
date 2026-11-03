import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { TaskLaunchTokenOrigin } from "./launch-types";
import type { ProjectAction } from "@/lib/authz";

import { and, eq, isNull, or, sql } from "drizzle-orm";

import {
  assertTaskLaunchReadAuthority,
  assertTaskLaunchUserAuthority,
} from "./launch-authority";

import { verifyToken, parseBoundRunId } from "@/lib/tokens/verify";
import { tokenHasScope } from "@/lib/tokens/scopes";
import { MaisterError } from "@/lib/errors";
import {
  projectTokens,
  projects,
  librarianTurns,
  librarianConversations,
  runs,
  users,
} from "@/lib/db/schema";
import { retryDigest } from "@/lib/agents/retry-guards";
import { ACTIVE_AGENT_RUN_STATUSES } from "@/lib/agents/activity-status";

const tokenAuthority = Symbol("verified task launch token");

export type TokenTaskLaunchPrincipal = Readonly<{
  [tokenAuthority]: true;
  origin: TaskLaunchTokenOrigin;
}>;

/** Verify the real bearer secret once; retain only credential-free durable identity. */
export async function tokenTaskLaunchPrincipal(
  db: Db,
  presented: string,
): Promise<TokenTaskLaunchPrincipal> {
  const actor = await verifyToken(presented, db);

  return {
    [tokenAuthority]: true,
    origin: {
      version: 1,
      kind: "token",
      tokenId: actor.tokenId,
      tokenKind: actor.tokenKind,
      projectId: actor.projectId,
      ownerUserId: actor.ownerUserId,
      agentId: actor.agentId,
      boundRunId: actor.boundRunId,
      librarianTurnId: actor.librarianTurnId ?? null,
    },
  };
}

export function assertTokenTaskLaunchPrincipal(
  principal: TokenTaskLaunchPrincipal,
): void {
  if (principal?.[tokenAuthority] !== true)
    throw new MaisterError(
      "UNAUTHORIZED",
      "Verified bearer authority is required",
      {
        details: { reason: "launch_token_authority_required" },
      },
    );
}

function tokenAuthorityRevoked(): MaisterError {
  return new MaisterError(
    "UNAUTHORIZED",
    "Current token launch permission is required",
    {
      details: { reason: "launch_authority_revoked" },
    },
  );
}

export function taskLaunchTokenActorUserId(
  origin: TaskLaunchTokenOrigin,
): string | null {
  return origin.tokenKind === "user" || origin.tokenKind === "librarian"
    ? origin.ownerUserId
    : null;
}

/** Credential/owner liveness is checked before looking up any untrusted task selector. */
export async function assertTaskLaunchTokenAuthentication(
  db: Db,
  principal: TokenTaskLaunchPrincipal,
): Promise<void> {
  assertTokenTaskLaunchPrincipal(principal);
  const ownerId = taskLaunchTokenActorUserId(principal.origin);

  if (ownerId) {
    const [owner] = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.id, ownerId),
          eq(users.accountStatus, "active"),
          eq(users.mustChangePassword, false),
        ),
      )
      .for("share");

    if (!owner) throw tokenAuthorityRevoked();
  }
  await assertLiveTaskLaunchToken(db, principal);
}

/** Lock existing turn/parent ownership before the token row, matching their revocation owners. */
async function assertLiveTaskLaunchToken(
  db: Db,
  principal: TokenTaskLaunchPrincipal,
): Promise<readonly string[]> {
  assertTokenTaskLaunchPrincipal(principal);
  const origin = principal.origin;

  if (origin.librarianTurnId) {
    const [turn] = await db
      .select({ id: librarianTurns.id })
      .from(librarianTurns)
      .innerJoin(
        librarianConversations,
        eq(librarianConversations.id, librarianTurns.conversationId),
      )
      .where(
        and(
          eq(librarianTurns.id, origin.librarianTurnId),
          eq(librarianTurns.status, "running"),
          eq(librarianConversations.userId, origin.ownerUserId ?? ""),
        ),
      )
      .for("share", { of: librarianTurns });

    if (!turn) throw tokenAuthorityRevoked();
  }
  if (origin.boundRunId) {
    const [parent] = await db
      .select({
        projectId: runs.projectId,
        agentId: runs.agentId,
        status: runs.status,
      })
      .from(runs)
      .where(eq(runs.id, origin.boundRunId))
      .for("share");

    if (
      !parent ||
      !ACTIVE_AGENT_RUN_STATUSES.includes(parent.status) ||
      parent.projectId !== origin.projectId ||
      (origin.agentId !== null && parent.agentId !== origin.agentId)
    )
      throw tokenAuthorityRevoked();
  }
  const [row] = await db
    .select({
      id: projectTokens.id,
      tokenKind: projectTokens.token_kind,
      projectId: projectTokens.project_id,
      ownerUserId: projectTokens.owner_user_id,
      agentId: projectTokens.agent_id,
      name: projectTokens.name,
      librarianTurnId: projectTokens.librarian_turn_id,
      scopes: projectTokens.scopes,
    })
    .from(projectTokens)
    .where(
      and(
        eq(projectTokens.id, origin.tokenId),
        isNull(projectTokens.revoked_at),
        or(
          isNull(projectTokens.expires_at),
          sql`${projectTokens.expires_at}>clock_timestamp()`,
        ),
      ),
    )
    .for("share");

  if (!row) throw tokenAuthorityRevoked();
  const current: TaskLaunchTokenOrigin = {
    version: 1,
    kind: "token",
    tokenId: row.id,
    tokenKind: row.tokenKind,
    projectId: row.projectId,
    ownerUserId: row.ownerUserId,
    agentId: row.agentId,
    boundRunId: parseBoundRunId(row.name),
    librarianTurnId: row.librarianTurnId,
  };

  if (retryDigest(current) !== retryDigest(origin))
    throw tokenAuthorityRevoked();

  return row.scopes;
}

/** Resource visibility is not a launch grant; automated roots cannot escape their original scope. */
export async function assertTaskLaunchTokenVisibility(
  db: Db,
  principal: TokenTaskLaunchPrincipal,
  projectId: string,
): Promise<void> {
  assertTokenTaskLaunchPrincipal(principal);
  const origin = principal.origin;

  if (origin.projectId !== null && origin.projectId !== projectId)
    throw tokenAuthorityRevoked();
  const ownerId = taskLaunchTokenActorUserId(origin);

  if (ownerId) await assertTaskLaunchReadAuthority(db, projectId, ownerId);
  else {
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .for("share");

    if (!project) throw tokenAuthorityRevoked();
  }
  await assertLiveTaskLaunchToken(db, principal);
}

/** Metadata scope is distinct from launch authority and stays readable after archival. */
export async function assertTaskLaunchTokenReadAuthority(
  db: Db,
  principal: TokenTaskLaunchPrincipal,
  projectId: string,
): Promise<void> {
  await assertTaskLaunchTokenVisibility(db, principal, projectId);
  const scopes = await assertLiveTaskLaunchToken(db, principal);

  if (!tokenHasScope(scopes, "runs:read")) throw tokenAuthorityRevoked();
}

/** Recheck current grants and metadata without retaining or rereading the bearer secret. */
export async function assertTaskLaunchTokenAuthority(
  db: Db,
  principal: TokenTaskLaunchPrincipal,
  projectId: string,
  actions: readonly ProjectAction[],
): Promise<void> {
  assertTokenTaskLaunchPrincipal(principal);
  const origin = principal.origin;

  if (origin.projectId !== null && origin.projectId !== projectId)
    throw tokenAuthorityRevoked();
  const ownerId = taskLaunchTokenActorUserId(origin);

  if (ownerId)
    await assertTaskLaunchUserAuthority(db, projectId, ownerId, actions);
  else {
    if (actions.includes("launchUnattended")) throw tokenAuthorityRevoked();
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), isNull(projects.archivedAt)))
      .for("share");

    if (!project) throw tokenAuthorityRevoked();
  }
  const scopes = await assertLiveTaskLaunchToken(db, principal);

  if (
    !tokenHasScope(scopes, "runs:launch") ||
    (actions.includes("editTask") && !tokenHasScope(scopes, "tasks:update"))
  )
    throw tokenAuthorityRevoked();
}
