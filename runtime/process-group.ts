import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

export type ProcessGroupObservation =
  | Readonly<{ state: "retired" }>
  | Readonly<{ state: "active"; states: readonly string[] }>
  | Readonly<{ state: "unavailable" }>;

function groupAbsent(group: number): boolean | null {
  try {
    process.kill(-group, 0);

    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? true : null;
  }
}

/** Recorded groups are observation scopes, never authority to signal an unknown process. */
export async function inspectProcessGroup(
  group: number,
): Promise<ProcessGroupObservation> {
  if (!Number.isSafeInteger(group) || group <= 0)
    return { state: "unavailable" };
  const absent = groupAbsent(group);

  if (absent === true) return { state: "retired" };
  if (absent === null) return { state: "unavailable" };
  let stdout: string;

  try {
    ({ stdout } = await execute(
      "ps",
      ["-g", String(group), "-o", "pgid=,stat="],
      {
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
      },
    ));
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
    };

    return Number(failure.code) === 1 &&
      !failure.stdout?.trim() &&
      !failure.stderr?.trim() &&
      groupAbsent(group) === true
      ? { state: "retired" }
      : { state: "unavailable" };
  }
  const members: string[] = [];

  for (const line of stdout.split("\n").filter((entry) => entry.trim())) {
    const match = /^\s*(\d+)\s+(\S+)/u.exec(line);

    if (!match) return { state: "unavailable" };
    if (Number(match[1]) === group) members.push(match[2]!);
  }
  if (members.length === 0)
    return groupAbsent(group) === true
      ? { state: "retired" }
      : { state: "unavailable" };
  const active = members.filter((state) => !state.startsWith("Z"));

  return active.length
    ? { state: "active", states: active }
    : { state: "retired" };
}
