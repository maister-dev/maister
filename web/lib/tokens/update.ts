import "server-only";

import { and, eq, isNull } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  assertTokenNameAllowed,
  isManagedToken,
  recordTokenLifecycleEvent,
  type TokenLifecycleActor,
} from "@/lib/tokens/lifecycle";
import { getTokenListItem, type TokenListItem } from "@/lib/tokens/list";
import { normalizeTokenScopes, type TokenScope } from "@/lib/tokens/scopes";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { projectTokens } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "tokens-update",
  level: process.env.LOG_LEVEL ?? "info",
});

const HUMAN_HITL_SCOPE = "hitl:respond:human";

export type TokenUpdateSurface = "project" | "account";

export type TokenUpdatePatch = {
  name?: string;
  scopes?: readonly string[];
  // Account surface only — mirrors that surface's POST, where the exact human
  // scope is granted through this boolean rather than inside `scopes`.
  humanHitl?: boolean;
  // The ONLY nullable field: `null` clears expiry, absent preserves it.
  expiresAt?: Date | null;
};

export type StoredTokenFields = {
  name: string;
  scopes: string[];
  expires_at: Date | null;
};

export type EffectiveTokenFields = {
  name: string;
  scopes: TokenScope[];
  expiresAt: Date | null;
};

export type TokenChangedField = "scopes_changed" | "renamed" | "expiry_changed";

export type TokenUpdateOutcome = "updated" | "unchanged" | "not-found";

export type TokenUpdateResult = {
  outcome: TokenUpdateOutcome;
  token?: TokenListItem;
  changed: TokenChangedField[];
};

/**
 * Resolve the patch against the stored row into the fields that would be
 * written. Pure: no database, no route. Exported because the empty-scope
 * refusal below is a service-layer invariant, not a validator's job.
 */
export function resolveEffectiveTokenFields(
  stored: StoredTokenFields,
  patch: TokenUpdatePatch,
  surface: TokenUpdateSurface,
): EffectiveTokenFields {
  const name = patch.name ?? stored.name;

  const requested =
    surface === "account"
      ? resolveAccountScopes(stored.scopes, patch)
      : (patch.scopes ?? stored.scopes);

  // D6: `normalizeTokenScopes([])` returns `["*"]`. On the create path that is
  // a benign "default to full"; on the update path it silently grants full
  // access to the token the caller was trying to restrict. Refuse BEFORE
  // normalizing, and never lean on the route's zod `.min(1)` to get here.
  if (requested.length === 0) {
    throw new MaisterError(
      "CONFIG",
      "token must keep at least one scope — revoke it instead of removing them all",
      { details: { field: "scopes" } },
    );
  }

  return {
    name,
    scopes: normalizeTokenScopes(requested),
    expiresAt:
      patch.expiresAt !== undefined ? patch.expiresAt : stored.expires_at,
  };
}

function resolveAccountScopes(
  storedScopes: string[],
  patch: TokenUpdatePatch,
): string[] {
  const base =
    patch.scopes ?? storedScopes.filter((s) => s !== HUMAN_HITL_SCOPE);
  const human = patch.humanHitl ?? storedScopes.includes(HUMAN_HITL_SCOPE);

  return human ? [...base, HUMAN_HITL_SCOPE] : [...base];
}

function sameScopes(a: readonly string[], b: readonly string[]): boolean {
  // A reorder is not a change: the ledger records intent, not array identity.
  const left = [...a].sort();
  const right = [...b].sort();

  return left.length === right.length && left.every((v, i) => v === right[i]);
}

function sameInstant(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b;

  return a.getTime() === b.getTime();
}

function diffFields(
  stored: StoredTokenFields,
  effective: EffectiveTokenFields,
): TokenChangedField[] {
  const changed: TokenChangedField[] = [];

  if (effective.name !== stored.name) changed.push("renamed");
  if (!sameScopes(effective.scopes, stored.scopes))
    changed.push("scopes_changed");
  if (!sameInstant(effective.expiresAt, stored.expires_at)) {
    changed.push("expiry_changed");
  }

  return changed;
}

function beforeAfterFor(
  field: TokenChangedField,
  stored: StoredTokenFields,
  effective: EffectiveTokenFields,
): { before: unknown; after: unknown } {
  switch (field) {
    case "renamed":
      return { before: { name: stored.name }, after: { name: effective.name } };
    case "scopes_changed":
      return {
        before: { scopes: stored.scopes },
        after: { scopes: effective.scopes },
      };
    case "expiry_changed":
      return {
        before: { expiresAt: stored.expires_at?.toISOString() ?? null },
        after: { expiresAt: effective.expiresAt?.toISOString() ?? null },
      };
  }
}

async function updateToken(
  args: {
    tokenId: string;
    surface: TokenUpdateSurface;
    // Re-asserted in BOTH the SELECT and the UPDATE: a token outside the
    // caller's scope is existence-hidden, never mutated.
    // FIXME(any): dual drizzle-orm peer-dep variants.
    scope: any;
  },
  patch: TokenUpdatePatch,
  actor: TokenLifecycleActor,
  db?: Db,
): Promise<TokenUpdateResult> {
  const d = db ?? getDb();

  const rows = await d.select().from(projectTokens).where(args.scope).limit(1);

  if (rows.length === 0) {
    log.warn(
      { tokenId: args.tokenId, surface: args.surface, reason: "not-found" },
      "token update refused",
    );

    return { outcome: "not-found", changed: [] };
  }

  const stored = rows[0];

  if (stored.revoked_at !== null && stored.revoked_at !== undefined) {
    log.warn(
      { tokenId: args.tokenId, reason: "revoked" },
      "token update refused",
    );
    throw new MaisterError(
      "PRECONDITION",
      "a revoked token cannot be edited — revocation is terminal",
    );
  }

  if (!isManagedToken(stored)) {
    log.warn(
      { tokenId: args.tokenId, reason: "not-managed" },
      "token update refused",
    );
    throw new MaisterError(
      "PRECONDITION",
      "run-bound and agent tokens are managed by their own run lifecycle and cannot be edited",
    );
  }

  if (patch.name !== undefined) {
    assertTokenNameAllowed(patch.name);
  }

  const storedFields: StoredTokenFields = {
    name: stored.name,
    scopes: (stored.scopes as string[]) ?? ["*"],
    expires_at: stored.expires_at ?? null,
  };
  const effective = resolveEffectiveTokenFields(
    storedFields,
    patch,
    args.surface,
  );
  const changed = diffFields(storedFields, effective);

  log.debug({ tokenId: args.tokenId, changed }, "token update diff computed");

  if (changed.length === 0) {
    return {
      outcome: "unchanged",
      token: (await getTokenListItem(args.tokenId, d)) ?? undefined,
      changed: [],
    };
  }

  await d.transaction(async (tx: Db) => {
    const updated = await tx
      .update(projectTokens)
      .set({
        name: effective.name,
        scopes: effective.scopes,
        expires_at: effective.expiresAt,
      })
      // CAS on revoked_at: a revoke that lands between the SELECT and here
      // matches zero rows, and that is a refusal, never a silent success.
      .where(and(args.scope, isNull(projectTokens.revoked_at)))
      .returning({ id: projectTokens.id });

    if (updated.length === 0) {
      throw new MaisterError(
        "PRECONDITION",
        "token was revoked concurrently; no fields were changed",
      );
    }

    for (const field of changed) {
      const { before, after } = beforeAfterFor(field, storedFields, effective);

      await recordTokenLifecycleEvent(
        { token: stored, event: field, actor, before, after },
        tx,
      );
    }
  });

  log.info(
    {
      tokenId: args.tokenId,
      actorUserId: actor.userId,
      surface: args.surface,
      changed,
    },
    "api token updated",
  );

  return {
    outcome: "updated",
    token: (await getTokenListItem(args.tokenId, d)) ?? undefined,
    changed,
  };
}

/** Edit a managed PROJECT token. The project predicate existence-hides others. */
export function updateProjectToken(
  input: { tokenId: string; projectId: string },
  patch: TokenUpdatePatch,
  actor: TokenLifecycleActor,
  db?: Db,
): Promise<TokenUpdateResult> {
  return updateToken(
    {
      tokenId: input.tokenId,
      surface: "project",
      scope: and(
        eq(projectTokens.id, input.tokenId),
        eq(projectTokens.project_id, input.projectId),
      ),
    },
    patch,
    actor,
    db,
  );
}

/**
 * Edit a managed GLOBAL PERSONAL token. Owner, kind, and NULL-project
 * predicates existence-hide other users' tokens and every project-bound token.
 */
export function updateOwnerToken(
  input: { tokenId: string; ownerUserId: string },
  patch: TokenUpdatePatch,
  actor: TokenLifecycleActor,
  db?: Db,
): Promise<TokenUpdateResult> {
  return updateToken(
    {
      tokenId: input.tokenId,
      surface: "account",
      scope: and(
        eq(projectTokens.id, input.tokenId),
        eq(projectTokens.owner_user_id, input.ownerUserId),
        eq(projectTokens.token_kind, "user"),
        isNull(projectTokens.project_id),
      ),
    },
    patch,
    actor,
    db,
  );
}
