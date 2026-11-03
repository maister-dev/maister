import type { Invocation } from "./process-invocation";

import {
  findProcessIdentity,
  readProcessSnapshot,
  registerProcess,
} from "./process-invocation";

type SupervisorProcessCapture = Readonly<{
  invocation: Invocation;
  url: string;
  supervisorPid: number;
  runtimeRoot: string;
  bootId: string;
  logFile: string;
  caseName: string;
}>;

/** Capture positively owned session groups before intentionally killing their host. */
export async function captureSupervisorProcessGroups(
  input: SupervisorProcessCapture,
): Promise<readonly number[]> {
  const response = await fetch(`${input.url}/sessions`, {
    signal: AbortSignal.timeout(2_000),
  });

  if (!response.ok)
    throw new Error(
      `Fixture session inventory failed: HTTP ${response.status}`,
    );
  const entries: unknown = await response.json();

  if (!Array.isArray(entries))
    throw new Error("Fixture session inventory is not an array");
  const snapshot = await readProcessSnapshot(input.invocation);
  const groups = new Set<number>();

  for (const value of entries as readonly unknown[]) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Readonly<Record<string, unknown>>;
    const group = entry.processGroup;

    if (group === undefined) continue;
    if (
      typeof group !== "number" ||
      !Number.isSafeInteger(group) ||
      group <= 1 ||
      entry.pid !== group
    )
      throw new Error("Fixture session has an invalid native group identity");
    if (groups.has(group)) continue;
    const identity = await findProcessIdentity(input.invocation, group);

    if (
      identity &&
      (identity.pgid !== group || identity.ppid !== input.supervisorPid)
    )
      throw new Error(
        "Fixture session gate does not belong to this supervisor",
      );
    const members = snapshot.filter(
      (member) => member.pgid === group && !member.zombie,
    );

    if (members.length === 0) continue;
    if (members.some((member) => !member.owned || !member.inspected))
      throw new Error("Fixture session group contains an unowned process");
    // A retained terminal session can outlive its gate. Record the actual
    // inspected descendants before stopping their known host owner.
    for (const member of members)
      await registerProcess(
        input.invocation,
        {
          role: "fixture",
          caseName: input.caseName,
          rootRole: "supervisor-session",
          root: input.runtimeRoot,
          bootId: input.bootId,
          logFile: input.logFile,
        },
        member.pid,
      );
    groups.add(group);
  }

  return [...groups];
}
