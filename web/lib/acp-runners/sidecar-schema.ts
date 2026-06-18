import { z } from "zod";

// ADR-094: a sidecar `configPath` is forwarded to the supervisor, which reads
// it via fs.access/readFile (after `~` expansion). Reject `..` traversal at
// EVERY web boundary that accepts the value — POST create AND PATCH update — so
// a stored path can never escape into a location the supervisor would read or
// refuse. Shared so the create and update routes cannot drift apart.
export const sidecarConfigPathSchema = z
  .string()
  .min(1)
  .regex(/^(?!.*\.\.).+$/, "configPath must not contain '..' path segments");
