import "server-only";

import type { Db } from "./db";
import type { PromptOwner } from "./prompt-owner-contract";
import type { ExecutionCommand, ExecutionEvent } from "@/lib/db/schema";

import { PromptOwnerSchema } from "./prompt-owner-contract";
import { readPromptOutput } from "./prompt-output";

import { MaisterError } from "@/lib/errors";

export type PromptOwnerDisposition = "applied" | "superseded";
export type PromptOwnerOutcome =
  | {
      state: "succeeded";
      response: Readonly<Record<string, unknown>>;
      events: AsyncIterable<ExecutionEvent>;
    }
  | {
      state: "failed" | "fenced";
      error: Readonly<Record<string, unknown>>;
    };

export type PreparedPromptOwner = Readonly<{
  /** DB-only: lock the domain authority in its usual order and recheck its
   * exact generation before writing. Persist any successor readiness here.
   * The application marker is committed by the caller in this transaction.
   */
  apply: (tx: Db) => Promise<PromptOwnerDisposition>;
  /** Optional cleanup hint after commit. Durable domain/GC state must also
   * recover this work if the process dies before the hint runs. */
  afterCommit?: () => Promise<void>;
}>;

type Preparation<O extends PromptOwner> = Readonly<{
  db: Db;
  owner: O;
  command: Readonly<ExecutionCommand>;
  outcome: PromptOwnerOutcome;
  signal: AbortSignal;
}>;

export type PromptOwnerAdapter = Readonly<{
  kind: PromptOwner["kind"];
  prepare: (input: Preparation<PromptOwner>) => Promise<PreparedPromptOwner>;
}>;
export type PromptOwnerRegistry = ReadonlyMap<
  PromptOwner["kind"],
  PromptOwnerAdapter
>;

/** A valid owner is awaiting another durable domain transition, not failing. */
export class PromptOwnerDeferred extends MaisterError {
  constructor(causeCode: string) {
    super("PRECONDITION", "prompt owner awaits a durable domain transition", {
      details: { reason: "prompt_owner_deferred", causeCode },
    });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class PromptOwnerInvariantError extends MaisterError {
  constructor(causeCode: string) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(causeCode))
      throw new MaisterError(
        "CONFIG",
        "prompt owner invariant requires a bounded diagnostic code",
      );
    super("CONFLICT", "prompt owner application failed its invariant", {
      details: { reason: "prompt_owner_invariant", causeCode },
    });
    Object.setPrototypeOf(this, PromptOwnerInvariantError.prototype);
  }
}

/** Application modules register typed adapters here; the command layer never
 * imports Flow, agent, scratch, gate or sync implementations. */
export function definePromptOwnerAdapter<K extends PromptOwner["kind"]>(
  kind: K,
  prepare: (
    input: Preparation<Extract<PromptOwner, { kind: K }>>,
  ) => Promise<PreparedPromptOwner>,
): PromptOwnerAdapter {
  return {
    kind,
    prepare: (input) => {
      if (input.owner.kind !== kind)
        throw new PromptOwnerInvariantError("adapter_kind");

      return prepare({
        ...input,
        // The runtime discriminator above narrows the generic family.
        owner: input.owner as Extract<PromptOwner, { kind: K }>,
      });
    },
  };
}

export function createPromptOwnerRegistry(
  adapters: readonly PromptOwnerAdapter[],
): PromptOwnerRegistry {
  const registry = new Map(adapters.map((adapter) => [adapter.kind, adapter]));

  if (registry.size !== adapters.length)
    throw new MaisterError("CONFIG", "prompt owner adapters must be unique");

  return registry;
}

/** Network reads and full output verification happen before the DB apply
 * transaction. Returning after a prefix of the event iterator cannot apply.
 */
export async function preparePromptOwner(input: {
  db: Db;
  command: ExecutionCommand;
  registry: PromptOwnerRegistry;
  signal: AbortSignal;
}): Promise<PreparedPromptOwner> {
  const { db, command, signal } = input;
  const parsed = PromptOwnerSchema.safeParse({
    kind: command.ownerKind,
    ref: command.ownerRef,
  });

  if (!parsed.success) throw new PromptOwnerInvariantError("owner_shape");
  const owner = parsed.data;
  const adapter = input.registry.get(owner.kind);

  if (!adapter) throw new PromptOwnerInvariantError("adapter_missing");
  let outputComplete = command.state !== "succeeded";
  let outputEvents: AsyncGenerator<ExecutionEvent> | null = null;
  let outcome: PromptOwnerOutcome;

  if (command.state === "succeeded") {
    const output = await readPromptOutput({
      db,
      commandId: command.id,
      signal,
    });
    const events = async function* (): AsyncGenerator<ExecutionEvent> {
      for await (const event of output.events) {
        signal.throwIfAborted();
        yield event;
      }
      outputComplete = true;
    };

    outputEvents = events();
    outcome = {
      state: "succeeded",
      response: output.response,
      events: outputEvents,
    };
  } else if (command.state === "failed" || command.state === "fenced") {
    if (!command.lastError)
      throw new PromptOwnerInvariantError("terminal_error_missing");
    outcome = { state: command.state, error: command.lastError };
  } else throw new PromptOwnerInvariantError("terminal_missing");
  try {
    const prepared = await adapter.prepare({
      db,
      command,
      owner,
      outcome,
      signal,
    });

    signal.throwIfAborted();
    if (!outputComplete)
      throw new PromptOwnerInvariantError("output_not_consumed");

    return prepared;
  } finally {
    if (!outputComplete && outputEvents) await outputEvents.return(undefined);
  }
}
