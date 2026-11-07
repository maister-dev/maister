import type { Invocation, ProcessIdentity } from "./process-invocation";

import { z } from "zod";

import {
  findProcessIdentity,
  readProcessSnapshot,
  registerProcess,
  processIdentity,
} from "./process-invocation";

const sessionIdentitySchema = z.object({
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  pid: z.number().int().gt(1),
  processGroup: z.number().int().gt(1),
  adapterPid: z.number().int().gt(1).optional(),
  assignmentId: z.string().optional(),
  assignmentEpoch: z.number().int().positive().optional(),
  acpSessionId: z.string().optional(),
  status: z.enum(["live", "exited", "crashed"]),
});

type AdapterCaptureInput = Readonly<{
  invocation: Invocation;
  supervisor: Readonly<{
    url: string;
    pid: number;
    captureOwnedSessionGroups(): Promise<readonly number[]>;
  }>;
  sessionId: string;
  expected?: Readonly<{
    runId?: string;
    assignmentId?: string;
    assignmentEpoch?: number;
    acpSessionId?: string;
  }>;
}>;

/** Resolve a behavioral signal target from attested scope and actual native ancestry. */
export async function captureOwnedAdapterProcess(
  input: AdapterCaptureInput,
): Promise<
  Readonly<{
    adapter: ProcessIdentity;
    gate: ProcessIdentity;
    sessionRecord: z.infer<typeof sessionIdentitySchema>;
  }>
> {
  const inventory = await fetch(`${input.supervisor.url}/sessions`, {
    signal: AbortSignal.timeout(2_000),
  });

  if (!inventory.ok)
    throw new Error(
      `Fixture session discovery failed: HTTP ${inventory.status}`,
    );
  const discovered = z
    .array(sessionIdentitySchema)
    .parse(await inventory.json());
  const target = discovered.find(
    (entry) => entry.sessionId === input.sessionId,
  );

  if (!target) throw new Error("Fixture session identity is missing");
  const response = await fetch(
    `${input.supervisor.url}/sessions?runId=${encodeURIComponent(target.runId)}`,
    { signal: AbortSignal.timeout(2_000) },
  );

  if (
    !response.ok ||
    response.headers.get("X-Maister-Session-Ownership-Version") !== "1"
  )
    throw new Error(
      `Fixture session ownership is unproved: HTTP ${response.status}`,
    );
  const sessionRecord = z
    .array(sessionIdentitySchema)
    .parse(await response.json())
    .find((entry) => entry.sessionId === input.sessionId);

  if (
    !sessionRecord ||
    sessionRecord.status !== "live" ||
    !sessionRecord.adapterPid
  )
    throw new Error("Fixture session has no live native adapter");
  for (const [key, value] of Object.entries(input.expected ?? {}))
    if (
      value !== undefined &&
      sessionRecord[key as keyof typeof sessionRecord] !== value
    )
      throw new Error(
        `Fixture session ${key} does not match its expected owner`,
      );
  const groups = await input.supervisor.captureOwnedSessionGroups();
  const [gate, adapter] = await Promise.all([
    processIdentity(input.invocation, sessionRecord.pid),
    processIdentity(input.invocation, sessionRecord.adapterPid),
  ]);

  if (
    !groups.includes(sessionRecord.processGroup) ||
    gate.pid !== sessionRecord.processGroup ||
    gate.pgid !== gate.pid ||
    gate.ppid !== input.supervisor.pid ||
    adapter.ppid !== gate.pid ||
    adapter.pgid !== gate.pgid ||
    adapter.pid === gate.pid ||
    [gate, adapter].some(
      (entry) => !entry.owned || !entry.inspected || entry.zombie,
    )
  )
    throw new Error(
      "Fixture adapter lacks its exact owned gate and process group",
    );

  return { adapter, gate, sessionRecord };
}

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
