import { once } from "node:events";

import { z } from "zod";

import {
  findProcessIdentity,
  invocationFromEnvironment,
  processIdentity,
  readProcessSnapshot,
  sameProcess,
  signalCheckedInvocationGroup,
  type ProcessIdentity,
} from "../process-invocation";

const identitySchema = z.object({
  pid: z.number().int().gt(1),
  ppid: z.number().int().nonnegative(),
  pgid: z.number().int().gt(1),
  uid: z.number().int().nonnegative(),
  started: z.string().min(1),
  owned: z.literal(true),
  inspected: z.literal(true),
  zombie: z.literal(false),
});
const invocation = invocationFromEnvironment();

if (!invocation || !process.send)
  throw new Error(
    "Session watchdog requires its private invocation and IPC channel",
  );
const captureController = new AbortController();
const captureDeadline = setTimeout(() => captureController.abort(), 10_000);
let message: unknown;

try {
  [message] = await once(process, "message", {
    signal: captureController.signal,
  });
} finally {
  clearTimeout(captureDeadline);
}
const input = z
  .object({
    parent: identitySchema,
    groups: z.array(z.array(identitySchema).min(1)).min(1),
  })
  .parse(message as unknown);
const parent = await processIdentity(invocation, process.ppid);

if (!sameProcess(input.parent, parent) || !parent.owned || !parent.inspected)
  throw new Error("Session watchdog parent identity changed before capture");
for (const group of input.groups) {
  const pgid = group[0]!.pgid;

  if (group.some((member) => member.pgid !== pgid))
    throw new Error("Session watchdog capture contains mixed process groups");
  for (const expected of group) {
    const current = await processIdentity(invocation, expected.pid);

    if (!sameProcess(expected, current) || !current.owned || !current.inspected)
      throw new Error("Session watchdog capture changed before readiness");
  }
}
process.send({ ready: true });

/** Revalidate captured birth identities and full invocation membership before each group signal. */
async function retireCapturedGroups(): Promise<void> {
  for (const group of input.groups) {
    const pgid = group[0]!.pgid;
    const current = (await readProcessSnapshot(invocation!)).filter(
      (entry) => entry.pgid === pgid && !entry.zombie,
    );

    if (!current.length) continue;
    if (
      !current.some((entry) =>
        group.some((expected: ProcessIdentity) => sameProcess(expected, entry)),
      )
    )
      throw new Error(
        "Session watchdog group no longer contains a captured native owner",
      );
    await signalCheckedInvocationGroup(invocation!, pgid, current, "SIGKILL");
  }
}

for (;;) {
  const currentParent = await findProcessIdentity(invocation, input.parent.pid);

  if (
    !currentParent ||
    currentParent.zombie ||
    !sameProcess(input.parent, currentParent)
  ) {
    await retireCapturedGroups();
    process.exit(0);
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
}
