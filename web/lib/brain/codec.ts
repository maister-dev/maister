import "server-only";

import { createHash } from "node:crypto";

import { MaisterError } from "@/lib/errors";

// Project Brain (ADR-122) shared low-level codecs. ONE home for the pgvector
// text serialization and the content hash so retain/reindex/recall never drift
// on either (SSOT).

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// Serialize an embedding to the pgvector text literal. Every component must be
// a finite number — a NaN/Infinity/undefined hole would otherwise produce a
// `[1,NaN,3]` literal that fails the `::vector` cast as a raw pg error (or,
// worse, gets cached upstream).
export function toVectorLiteral(v: number[]): string {
  for (const x of v) {
    if (typeof x !== "number" || !Number.isFinite(x)) {
      throw new MaisterError(
        "CONFIG",
        "embedding vector contains a non-finite component",
      );
    }
  }

  return `[${v.join(",")}]`;
}
