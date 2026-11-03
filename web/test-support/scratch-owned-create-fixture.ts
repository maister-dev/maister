import type { Db } from "@/lib/execution-host/db";
import type { BoundClient } from "@/lib/execution-host/client";
import type { CreateSessionPayload } from "@/lib/execution-host/contracts";
import type { SessionCreateOwner } from "@/lib/execution-host/create-owner-contract";
import type { OwnedSessionOptions } from "@/lib/execution-host/owned-session-create";
import type { OwnedCreateContinuation } from "@/lib/execution-host/create-continuation";

import { canonicalCommandJson } from "../../runtime/command-json";

import { SessionCreateOwnerSchema } from "@/lib/execution-host/create-owner-contract";
import { OwnedCreateContinuationSchema } from "@/lib/execution-host/create-continuation";

type FixtureClient = Readonly<{
  assignment: Readonly<{ runId: string; id: string }>;
}>;

/** Route-only fixtures retain the real owned-create inputs; SQL ownership is exercised by scratch-placement.integration. */
export function scratchOwnedCreateFixture() {
  const retained = new Map<
    string,
    { owner: SessionCreateOwner; continuation: OwnedCreateContinuation }
  >();

  return {
    clear: (): void => retained.clear(),
    async create<T>(
      db: Db,
      client: FixtureClient & {
        createSession: (payload: unknown) => Promise<T>;
      },
      owner: SessionCreateOwner,
      preparePayload: () => Promise<
        Omit<CreateSessionPayload, "executionWorkspaceId">
      >,
      options?: OwnedSessionOptions,
    ): Promise<T> {
      const key = client.assignment.id;
      const existing = retained.get(key);

      if (existing)
        throw new Error(
          "Route fixture unexpectedly admitted a second session create for one assignment",
        );
      if (!options?.prepareContinuation)
        throw new Error(
          "Route fixture create omitted its private continuation",
        );
      const continuation = OwnedCreateContinuationSchema.parse(
        await options.prepareContinuation(),
      );
      const frozenOwner = SessionCreateOwnerSchema.parse(owner);
      const payload = await preparePayload();

      await options.assertCommit?.(db);
      retained.set(key, { owner: frozenOwner, continuation });

      return client.createSession(payload);
    },
    async read(
      _db: Db,
      client: Pick<BoundClient, "assignment">,
      owner: SessionCreateOwner,
    ): Promise<OwnedCreateContinuation | null> {
      const original = retained.get(client.assignment.id);

      if (
        !original ||
        canonicalCommandJson(original.owner) !== canonicalCommandJson(owner)
      )
        throw new Error("Route fixture has no matching frozen create owner");

      return original.continuation;
    },
  };
}
