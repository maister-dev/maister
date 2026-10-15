import { writeSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { threadId, isMainThread } from "node:worker_threads";

import { findProcessIdentities, findProcessIdentity, invocationFromEnvironment, processIdentity, readProcessSnapshot, sameProcess } from "./process-invocation.ts";

const invocation = invocationFromEnvironment();
const ownerText = process.env.MAISTER_TEST_PROCESS_OWNER;
const expectedParentText = process.env.MAISTER_TEST_PROCESS_PARENT;

if (!invocation || !ownerText || !expectedParentText) throw new Error("fixture watchdog requires invocation and owner identities");
const owner = JSON.parse(ownerText);
const expectedParent = JSON.parse(expectedParentText);
const self = await processIdentity(invocation, process.pid);
const parent = await findProcessIdentity(invocation, process.ppid);
const intervalMs = 500;
let checking = false;

// Forked Vitest workers inherit the preload. Before accepting their immediate
// parent, prove its ancestry still reaches the identity captured before spawn.
let ancestor = parent;
let parentVerified = false;

for (let depth = 0; ancestor && depth < 64; depth++) {
  if (sameProcess(ancestor, expectedParent)) { parentVerified = true; break; }
  if (ancestor.ppid <= 1) break;
  ancestor = await findProcessIdentity(invocation, ancestor.ppid);
}

const lookupWindowStartedAt = performance.now();
let lookupTiming = { checks: 0, lookupMs: 0, maxLookupMs: 0 };

async function terminateOwnedGroup(reason) {
  const members = (await readProcessSnapshot(invocation)).filter((entry) => entry.pgid === self.pgid && !entry.zombie);

  writeSync(2, `${JSON.stringify({ invocationId: invocation.id, event: "fixture-parent-death", role: "fixture", caseName: process.env.MAISTER_TEST_CASE_NAME ?? "fixture", pid: self.pid, pgid: self.pgid, runtime: process.version, rootRole: "inherited", bootId: String(self.started), outcome: "killed", reason })}\n`);
  if (self.pgid > 1 && members.every((entry) => entry.owned && entry.inspected)) process.kill(-self.pgid, "SIGKILL");
  // A mixed group cannot become authority to kill an unrelated sibling.
  process.kill(self.pid, "SIGKILL");
}

async function checkOwners() {
  if (checking) return;
  checking = true;
  try {
    const selectedPids = [...new Set(parent ? [owner.pid, parent.pid] : [owner.pid])];
    const lookupStartedAt = performance.now();
    const identities = await findProcessIdentities(invocation, selectedPids);
    const lookupMs = performance.now() - lookupStartedAt;
    const currentOwner = identities[selectedPids.indexOf(owner.pid)];
    const currentParent = parent && identities[selectedPids.indexOf(parent.pid)];

    if (!parentVerified || process.ppid === 1 || !parent || process.ppid !== parent.pid || !currentParent || !sameProcess(parent, currentParent) || !currentOwner || !sameProcess(owner, currentOwner)) {
      await terminateOwnedGroup("owner identity disappeared");
    } else {
      lookupTiming = { checks: lookupTiming.checks + 1, lookupMs: lookupTiming.lookupMs + lookupMs, maxLookupMs: Math.max(lookupTiming.maxLookupMs, lookupMs) };
      if (lookupTiming.checks === 1 || lookupTiming.checks % 120 === 0) {
        // Per-thread lookup windows overlap and stop before the final lifetime is known.
        writeSync(2, `${JSON.stringify({ invocationId: invocation.id, event: "fixture-watchdog-lookup-timing", role: "fixture", caseName: process.env.MAISTER_TEST_CASE_NAME ?? "fixture", pid: self.pid, pgid: self.pgid, kernelStartId: self.started, threadId, isMainThread, runtime: process.version, platform: process.platform, arch: process.arch, selectedPids, targetCount: selectedPids.length, cadenceMs: intervalMs, ...lookupTiming, observedElapsedMs: performance.now() - lookupWindowStartedAt, overlapping: true, rightCensored: true })}\n`);
      }
    }
  } catch (error) {
    const causes = [];
    let cause = error;

    for (let depth = 0; cause instanceof Error && depth < 4; depth++) {
      causes.push({ name: cause.name, message: cause.message.slice(-4096), code: typeof cause.code === "string" ? cause.code : null, signal: typeof cause.signal === "string" ? cause.signal : null });
      cause = cause.cause;
    }
    writeSync(2, `${JSON.stringify({ invocationId: invocation.id, event: "fixture-watchdog-error", pid: process.pid, outcome: "failed", owner, parent: expectedParent, message: (error instanceof Error ? error.message : String(error)).slice(-4096), causes })}\n`);
    // Refuse to keep spending after the ownership mechanism itself failed.
    process.kill(process.pid, "SIGKILL");
  } finally {
    checking = false;
  }
}

await checkOwners();
setInterval(() => { void checkOwners(); }, intervalMs).unref();
