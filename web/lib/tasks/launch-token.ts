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
  taskLaunchIntents,
} from "@/lib/db/schema";
import { retryDigest } from "@/lib/agents/retry-guards";
import { ACTIVE_AGENT_RUN_STATUSES } from "@/lib/agents/activity-status";

const tokenAuthority = Symbol("verified task launch token");

/** Only persisted immutable origin is accepted here; callers cannot supply an origin or actor. */
export async function assertStoredTaskLaunchTokenAuthority(
  db: Db,
  intentId: string,
  actions: readonly ProjectAction[],
): Promise<void> {
  const [intent] = await db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, intentId));

  if (
    !intent ||
    intent.basis.kind !== "automatic" ||
    !intent.basis.origin ||
    intent.principalId !== intent.basis.origin.tokenId
  )
    throw tokenAuthorityRevoked();
  await assertTaskLaunchTokenAuthority(
    db,
    {
      [tokenAuthority]: true,
      origin: intent.basis.origin,
    },
    intent.projectId,
    actions,
  );
}

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
      boundRunId: projectTokens.bound_run_id,
      originKind: projectTokens.origin_kind,
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
    boundRunId:
      row.originKind !== null ? row.boundRunId : parseBoundRunId(row.name),
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

/** Recovery continues the same run; launch scope cannot substitute for its distinct permission. */
export async function assertTaskLaunchRecoveryTokenAuthority(
  db: Db,
  principal: TokenTaskLaunchPrincipal,
  projectId: string,
): Promise<void> {
  await assertTaskLaunchTokenVisibility(db, principal, projectId);
  const ownerId = taskLaunchTokenActorUserId(principal.origin);

  if (ownerId) {
    await assertTaskLaunchUserAuthority(db, projectId, ownerId, ["recoverRun"]);
  } else {
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), isNull(projects.archivedAt)))
      .for("share");

    if (!project) throw tokenAuthorityRevoked();
  }
  const scopes = await assertLiveTaskLaunchToken(db, principal);

  if (!tokenHasScope(scopes, "runs:recover")) throw tokenAuthorityRevoked();
}

/** A delegated child keeps its exact run-bound token scope; launch scope cannot impersonate this parent decision. */
export async function assertTaskLaunchDelegationTokenAuthority(
  db: Db,
  origin: TaskLaunchTokenOrigin,
  projectId: string,
  parentRunId: string,
): Promise<void> {
  if (
    origin.boundRunId !== parentRunId ||
    (origin.projectId !== null && origin.projectId !== projectId) ||
    origin.tokenKind === "librarian"
  )
    throw tokenAuthorityRevoked();
  const principal: TokenTaskLaunchPrincipal = {
    [tokenAuthority]: true,
    origin,
  };

  await assertTaskLaunchTokenVisibility(db, principal, projectId);
  const scopes = await assertLiveTaskLaunchToken(db, principal);

  if (!tokenHasScope(scopes, "runs:delegate")) throw tokenAuthorityRevoked();
  const owner = taskLaunchTokenActorUserId(origin);

  if (owner)
    await assertTaskLaunchUserAuthority(db, projectId, owner, ["launchRun"]);
}

/** Validate only this persisted finite child; this cannot construct fresh bearer or launch authority. */
export async function assertAcceptedTaskLaunchDelegationTokenAuthority(
  db: Db,
  intentId: string,
  origin: TaskLaunchTokenOrigin,
): Promise<void> {
  const [intent] = await db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, intentId));
  const source =
    intent?.settingsSnapshot.version === 2
      ? intent.settingsSnapshot.serverExecution
      : undefined;
  const payload = source?.execution.triggerPayload;
  const storedOrigin =
    payload && typeof payload === "object" && "origin" in payload
      ? payload.origin
      : null;

  if (
    !intent ||
    !source ||
    source.kind !== "delegated_child" ||
    source.id !== intent.taskId ||
    source.projectId !== intent.projectId ||
    source.taskId !== intent.taskId ||
    intent.principalKind !== "system" ||
    intent.principalId !== `delegated_child:${source.id}` ||
    intent.basis.kind !== "execution_child" ||
    !["queued", "preparing", "held", "run_bound"].includes(intent.state) ||
    origin.boundRunId !== intent.basis.parent.parentRunId ||
    (origin.projectId !== null && origin.projectId !== intent.projectId) ||
    origin.tokenKind === "librarian" ||
    retryDigest(storedOrigin) !== retryDigest(origin)
  )
    throw tokenAuthorityRevoked();
  const parentRunId = intent.basis.parent.parentRunId;
  const [parent] = await db
    .select({
      projectId: runs.projectId,
      agentId: runs.agentId,
      status: runs.status,
    })
    .from(runs)
    .where(eq(runs.id, parentRunId))
    .for("share");

  if (
    !parent ||
    parent.projectId !== intent.projectId ||
    !ACTIVE_AGENT_RUN_STATUSES.includes(parent.status) ||
    (origin.agentId !== null && parent.agentId !== origin.agentId)
  )
    throw tokenAuthorityRevoked();
  const owner = taskLaunchTokenActorUserId(origin);

  if (owner)
    await assertTaskLaunchUserAuthority(db, intent.projectId, owner, [
      "launchRun",
    ]);
  else {
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(eq(projects.id, intent.projectId), isNull(projects.archivedAt)),
      )
      .for("share");

    if (!project) throw tokenAuthorityRevoked();
  }
  const [token] = await db
    .select()
    .from(projectTokens)
    .where(
      and(
        eq(projectTokens.id, origin.tokenId),
        or(
          isNull(projectTokens.expires_at),
          sql`${projectTokens.expires_at}>clock_timestamp()`,
        ),
      ),
    )
    .for("share");

  if (!token || !tokenHasScope(token.scopes, "runs:delegate"))
    throw tokenAuthorityRevoked();
  const current: TaskLaunchTokenOrigin = {
    version: 1,
    kind: "token",
    tokenId: token.id,
    tokenKind: token.token_kind,
    projectId: token.project_id,
    ownerUserId: token.owner_user_id,
    agentId: token.agent_id,
    boundRunId:
      token.origin_kind !== null
        ? token.bound_run_id
        : parseBoundRunId(token.name),
    librarianTurnId: token.librarian_turn_id,
  };

  if (retryDigest(current) !== retryDigest(origin))
    throw tokenAuthorityRevoked();
  if (
    token.revoked_at !== null &&
    !(
      token.revocation_reason === "rotation" &&
      token.origin_kind === "orchestrator_run" &&
      token.bound_run_id === parentRunId &&
      token.token_kind === "project" &&
      token.owner_user_id === null &&
      token.agent_id === null &&
      token.librarian_turn_id === null
    )
  )
    throw tokenAuthorityRevoked();
}
