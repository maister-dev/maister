import "server-only";

import { MaisterError } from "@/lib/errors";

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
