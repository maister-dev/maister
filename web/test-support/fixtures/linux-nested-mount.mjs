import { readFileSync, writeFileSync } from "node:fs";

import {
  IsolationPolicyError,
  revalidateLinuxIsolationPolicy,
} from "../linux-isolation.ts";
import { decodeLinuxIsolationPolicy } from "../linux-isolation-protocol.ts";

const policy = decodeLinuxIsolationPolicy(process.argv[2] ?? "");
const nested = process.argv[3];
const witness = process.argv[4];
const mount = readFileSync("/proc/self/mountinfo", "utf8")
  .split("\n")
  .find((line) => line.split(" ")[4] === nested);

if (!mount?.includes(" - tmpfs "))
  throw new Error("nested-mount control did not reach its real tmpfs barrier");

try {
  revalidateLinuxIsolationPolicy(policy);
} catch (error) {
  if (
    !(error instanceof IsolationPolicyError) ||
    error.message !== "isolation bind contains an unapproved nested host mount"
  )
    throw error;
  process.stdout.write(JSON.stringify({ nested: true, refused: true }) + "\n");
  process.exit(0);
}
writeFileSync(witness, "unexpected-exec");
process.stdout.write(JSON.stringify({ nested: true, refused: false }) + "\n");
