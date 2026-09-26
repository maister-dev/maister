import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const INVOCATION_KEY = "MAISTER_TEST_WORKTREE_INVOCATION_ID";
const LEDGER_KEY = "MAISTER_TEST_PROCESS_LEDGER";
// Use NodeURL so Vite does not rewrite these filesystem resources into DOM asset URLs.
const NATIVE_SOURCE = fileURLToPath(
  new NodeURL("./process-environment.c", import.meta.url),
);

export type ProcessIdentity = Readonly<{
  pid: number;
  ppid: number;
  pgid: number;
  uid: number;
  started: string;
  owned: boolean;
  inspected: boolean;
  zombie: boolean;
}>;
export type ProcessRole =
  | "runner"
  | "vitest"
  | "playwright"
  | "supervisor"
  | "web"
  | "build"
  | "fixture";
export type Invocation = Readonly<{ id: string; directory: string }>;
export type ProcessRecord = Readonly<{
  kind: "process";
  identity: ProcessIdentity;
  role: ProcessRole;
  caseName: string;
  rootRole: string;
  root: string | null;
  bootId: string;
  logFile: string | null;
}>;
export type RootRecord = Readonly<{
  kind: "root";
  root: string;
  device: number;
  inode: number;
  rootRole: string;
}>;
export type ContainerRecord = Readonly<{
  kind: "container";
  id: string | null;
}>;
type ResourceRecord = ProcessRecord | RootRecord | ContainerRecord;
export const INVOCATION_CONTAINER_LABEL = "maister.test.invocation";

export class InvocationOwnershipError extends Error {
  readonly name = "InvocationOwnershipError";
}

function assertInvocationId(id: string): void {
  if (!/^[a-zA-Z0-9_-]{1,160}$/u.test(id)) {
    throw new InvocationOwnershipError(
      "invocation ID must be one safe path segment",
    );
  }
}

export function invocationFromEnvironment(): Invocation | null {
  const id = process.env[INVOCATION_KEY];

  if (!id) return null;
  assertInvocationId(id);

  return {
    id,
    directory:
      process.env[LEDGER_KEY] ??
      path.join(tmpdir(), "maister-process-ledgers", id),
  };
}

export async function createInvocation(directory: string): Promise<Invocation> {
  const id = randomUUID();
  const invocation = { id, directory: path.join(directory, "processes", id) };

  await mkdir(invocation.directory, { recursive: true, mode: 0o700 });

  return invocation;
}

export function invocationEnvironment(
  invocation: Invocation,
): Record<typeof INVOCATION_KEY | typeof LEDGER_KEY, string> {
  return {
    [INVOCATION_KEY]: invocation.id,
    [LEDGER_KEY]: invocation.directory,
  };
}

export function logInvocation(
  invocation: Invocation,
  event: string,
  fields: Record<string, string | number | boolean | null>,
): void {
  process.stderr.write(
    `${JSON.stringify({ invocationId: invocation.id, event, parentPid: fields.pid === process.pid ? process.ppid : process.pid, rootId: fields.rootRole ?? "none", runtime: `${process.platform}/${process.arch}/node-${process.versions.node}`, ...fields })}\n`,
  );
}

async function nativeReader(invocation: Invocation): Promise<string> {
  const digest = createHash("sha256")
    .update(await readFile(NATIVE_SOURCE, "utf8"))
    .digest("hex")
    .slice(0, 16);
  const executable = path.join(
    invocation.directory,
    `process-environment-${digest}`,
  );

  try {
    await stat(executable);

    return executable;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(invocation.directory, { recursive: true, mode: 0o700 });
  const temporary = `${executable}.${randomUUID()}`;
  const env = { ...process.env, ...invocationEnvironment(invocation) };

  try {
    const compiler = spawn(
      process.execPath,
      [
        fileURLToPath(
          new NodeURL("./fixture-compiler-watchdog.mjs", import.meta.url),
        ),
        String(process.pid),
        "cc",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-O2",
        NATIVE_SOURCE,
        "-o",
        temporary,
      ],
      {
        env,
        detached: true,
        signal: AbortSignal.timeout(30_000),
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let diagnostics = "";
    let failure: Error | undefined;

    compiler.stderr.on("data", (chunk: Buffer) => {
      diagnostics = `${diagnostics}${chunk.toString()}`.slice(-16 * 1024);
    });
    await new Promise<void>((resolve, reject) => {
      compiler.once("error", (error) => {
        failure = error;
      });
      compiler.once("close", (code, signal) => {
        if (code === 0 && !failure) resolve();
        else
          reject(
            new Error(
              `native reader compilation failed: ${code}/${signal}\n${diagnostics}`,
              { cause: failure },
            ),
          );
      });
    });
    await rename(temporary, executable);
  } finally {
    await rm(temporary, { force: true });
  }

  return executable;
}

async function readDarwinProcesses(
  invocation: Invocation,
  pid?: number,
): Promise<ProcessIdentity[]> {
  const executable = await nativeReader(invocation);
  const env = {
    ...process.env,
    ...invocationEnvironment(invocation),
    MAISTER_TEST_PROCESS_INSPECTOR: invocation.id,
  };
  const { stdout } = await execFileAsync(
    executable,
    [invocation.id, ...(pid === undefined ? [] : [String(pid)])],
    {
      env,
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  ).catch((cause: unknown): never => {
    throw new InvocationOwnershipError(
      `native process ownership could not be inspected for ${pid ?? "snapshot"}`,
      { cause },
    );
  });

  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line): ProcessIdentity => {
      const [pid, ppid, pgid, uid, started, owned, status] = line.split("\t");

      if (
        ![pid, ppid, pgid, uid, owned, status].every((field) =>
          /^-?\d+$/u.test(field ?? ""),
        ) ||
        !/^\d+:\d+$/u.test(started ?? "")
      ) {
        throw new InvocationOwnershipError("malformed native process identity");
      }

      return {
        pid: Number(pid),
        ppid: Number(ppid),
        pgid: Number(pgid),
        uid: Number(uid),
        started,
        owned: owned === "1",
        inspected: Number(owned) >= 0,
        zombie: status === "5",
      };
    });
}

async function readLinuxProcesses(
  invocation: Invocation,
  pid?: number,
): Promise<ProcessIdentity[]> {
  const result: ProcessIdentity[] = [];

  for (const entry of pid === undefined
    ? await readdir("/proc")
    : [String(pid)]) {
    if (!/^\d+$/u.test(entry)) continue;
    const directory = path.join("/proc", entry);

    try {
      const info = await stat(directory);

      if (info.uid !== process.getuid?.()) continue;
      const raw = await readFile(path.join(directory, "stat"), "utf8");
      const fields = raw
        .slice(raw.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/u);
      let inspected = true;
      const environment = await readFile(
        path.join(directory, "environ"),
        "utf8",
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ESRCH") throw error;
        if (error.code !== "EACCES" && error.code !== "EPERM") throw error;
        inspected = false;

        return "";
      });

      if (
        environment
          .split("\0")
          .includes(`MAISTER_TEST_PROCESS_INSPECTOR=${invocation.id}`)
      )
        continue;

      result.push({
        pid: Number(entry),
        ppid: Number(fields[1]),
        pgid: Number(fields[2]),
        uid: info.uid,
        started: fields[19],
        owned: environment
          .split("\0")
          .includes(`${INVOCATION_KEY}=${invocation.id}`),
        inspected,
        zombie: fields[0] === "Z",
      });
    } catch (error) {
      if (
        !["ENOENT", "ESRCH"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
    }
  }

  return result;
}

export async function readProcessSnapshot(
  invocation: Invocation,
): Promise<ProcessIdentity[]> {
  if (process.platform === "darwin") return readDarwinProcesses(invocation);
  if (process.platform === "linux") return readLinuxProcesses(invocation);
  throw new InvocationOwnershipError(
    `no process environment reader for ${process.platform}`,
  );
}

export function sameProcess(
  left: ProcessIdentity,
  right: ProcessIdentity,
): boolean {
  return (
    left.pid === right.pid &&
    left.uid === right.uid &&
    left.started === right.started
  );
}

export async function findProcessIdentity(
  invocation: Invocation,
  pid: number,
): Promise<ProcessIdentity | null> {
  const snapshot =
    process.platform === "darwin"
      ? await readDarwinProcesses(invocation, pid)
      : process.platform === "linux"
        ? await readLinuxProcesses(invocation, pid)
        : await readProcessSnapshot(invocation);

  const entry = snapshot.find((candidate) => candidate.pid === pid);

  if (entry) return entry.zombie ? null : entry;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return null;
    throw error;
  }
  throw new InvocationOwnershipError(
    `live process ${pid} could not be inspected`,
  );
}

export async function processIdentity(
  invocation: Invocation,
  pid: number,
): Promise<ProcessIdentity> {
  const identity = await findProcessIdentity(invocation, pid);

  if (!identity)
    throw new InvocationOwnershipError(
      `process ${pid} disappeared before registration`,
    );

  return identity;
}

async function writeRecord(
  invocation: Invocation,
  record: ResourceRecord,
): Promise<void> {
  await mkdir(invocation.directory, { recursive: true, mode: 0o700 });
  const filename = path.join(
    invocation.directory,
    record.kind === "process"
      ? `process-${record.identity.pid}-${record.identity.started.replaceAll(":", "-")}.json`
      : record.kind === "root"
        ? `root-${createHash("sha256").update(record.root).digest("hex")}.json`
        : `container-${record.id ?? "allocation"}.json`,
  );
  const temporary = `${filename}.${randomUUID()}.tmp`;

  await writeFile(temporary, JSON.stringify(record), {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, filename);
}

export async function registerProcess(
  invocation: Invocation,
  record: Omit<ProcessRecord, "kind" | "identity">,
  pid: number,
): Promise<ProcessRecord> {
  const identity = await processIdentity(invocation, pid);

  if (record.role !== "runner" && (!identity.owned || !identity.inspected)) {
    throw new InvocationOwnershipError(
      `process ${pid} lacks the exact invocation environment tag`,
    );
  }
  const entry: ProcessRecord = { kind: "process", identity, ...record };

  await writeRecord(invocation, entry);
  logInvocation(invocation, "process-registered", {
    pid,
    pgid: identity.pgid,
    role: record.role,
    caseName: record.caseName,
    rootRole: record.rootRole,
    rootId: record.root
      ? createHash("sha256").update(record.root).digest("hex").slice(0, 12)
      : "none",
    bootId: record.bootId,
    outcome: "registered",
  });

  return entry;
}

/** A known direct child can be observed across an exec wrapper's startup window. */
export async function registerSpawnedProcess(
  invocation: Invocation,
  record: Omit<ProcessRecord, "kind" | "identity">,
  child: ChildProcess,
): Promise<ProcessRecord> {
  if (!child.pid)
    throw new InvocationOwnershipError("spawned process has no PID");
  const original = await processIdentity(invocation, child.pid);
  const deadline = Date.now() + 5_000;
  let current = original;

  for (;;) {
    if (!sameProcess(original, current) || current.ppid !== process.pid)
      throw new InvocationOwnershipError(
        "spawned process identity changed before registration",
      );
    if (current.owned && current.inspected)
      return registerProcess(invocation, record, child.pid);
    if (
      child.exitCode !== null ||
      child.signalCode !== null ||
      Date.now() >= deadline
    )
      throw new InvocationOwnershipError(
        `spawned process ${child.pid} never exposed its invocation identity`,
      );
    await new Promise((resolve) => setTimeout(resolve, 25));
    current = await processIdentity(invocation, child.pid);
  }
}

export async function registerRoot(
  invocation: Invocation,
  root: string,
  rootRole: string,
): Promise<void> {
  const info = await lstat(root);

  if (!info.isDirectory() || info.isSymbolicLink())
    throw new InvocationOwnershipError("owned root is not a directory");
  const canonical = await realpath(root);
  const temporary = await realpath(tmpdir());

  await mkdir(invocation.directory, { recursive: true, mode: 0o700 });
  const ledger = await realpath(invocation.directory);

  if (
    !canonical.startsWith(`${temporary}${path.sep}`) ||
    canonical === ledger ||
    ledger.startsWith(`${canonical}${path.sep}`)
  )
    throw new InvocationOwnershipError(
      "owned root must be temporary and exclude the evidence ledger",
    );
  const marker = path.join(canonical, ".maister-test-invocation");

  try {
    await writeFile(marker, invocation.id, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await readFile(marker, "utf8")) !== invocation.id)
      throw new InvocationOwnershipError(
        "root belongs to a different invocation",
      );
  }
  await writeRecord(invocation, {
    kind: "root",
    root: canonical,
    device: info.dev,
    inode: info.ino,
    rootRole,
  });
}

export async function invocationRecords(
  invocation: Invocation,
): Promise<ResourceRecord[]> {
  const entries = await readdir(invocation.directory);
  const records: ResourceRecord[] = [];

  for (const entry of entries.filter((name) =>
    /^(process|root|container)-.*\.json$/u.test(name),
  )) {
    const record = JSON.parse(
      await readFile(path.join(invocation.directory, entry), "utf8"),
    ) as ResourceRecord;

    if (
      record.kind !== "process" &&
      record.kind !== "root" &&
      record.kind !== "container"
    ) {
      throw new InvocationOwnershipError(`invalid resource record ${entry}`);
    }
    records.push(record);
  }

  return records;
}

function ownedLiveProcesses(
  snapshot: readonly ProcessIdentity[],
): ProcessIdentity[] {
  return snapshot.filter(
    (entry) => entry.owned && !entry.zombie && entry.pid !== process.pid,
  );
}

function signalOwnedPid(
  identity: ProcessIdentity,
  signal: NodeJS.Signals,
): void {
  if (identity.pid <= 1)
    throw new InvocationOwnershipError("refusing to signal a system PID");
  try {
    process.kill(identity.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/** A discovered leak remains a failed lane even when reaping succeeds. */
export async function sweepInvocation(
  invocation: Invocation,
): Promise<ProcessIdentity[]> {
  const records = await invocationRecords(invocation);
  const snapshot = await readProcessSnapshot(invocation);

  for (const record of records) {
    if (record.kind !== "process" || record.role === "runner") continue;
    const current = snapshot.find((entry) =>
      sameProcess(entry, record.identity),
    );

    if (current && !current.zombie && (!current.inspected || !current.owned)) {
      throw new InvocationOwnershipError(
        `registered process ${current.pid} has unverifiable invocation ownership`,
      );
    }
  }
  const leaks = new Map(
    ownedLiveProcesses(snapshot).map((entry) => [
      `${entry.pid}:${entry.started}`,
      entry,
    ]),
  );

  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    const currentSnapshot = await readProcessSnapshot(invocation);
    const current = ownedLiveProcesses(currentSnapshot);

    for (const entry of current)
      leaks.set(`${entry.pid}:${entry.started}`, entry);
    const groups = new Set(current.map((entry) => entry.pgid));

    for (const pgid of groups) {
      const members = currentSnapshot.filter(
        (entry) => entry.pgid === pgid && !entry.zombie,
      );
      const groupOwned =
        pgid > 1 &&
        members.every((entry) => entry.owned && entry.pid !== process.pid);
      const targets = current.filter((entry) => entry.pgid === pgid);

      for (const target of targets) {
        const record = records.find(
          (entry): entry is ProcessRecord =>
            entry.kind === "process" && sameProcess(entry.identity, target),
        );

        logInvocation(invocation, "sweep-kill", {
          pid: target.pid,
          pgid,
          signal,
          role: record?.role ?? "descendant",
          caseName: record?.caseName ?? "lane-exit",
          rootRole: record?.rootRole ?? "inherited",
          bootId: record?.bootId ?? "unregistered",
          outcome: "leak",
          groupOwned,
        });
      }
      if (groupOwned) {
        try {
          process.kill(-pgid, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      } else {
        for (const target of targets) {
          const latest = (await readProcessSnapshot(invocation)).find((entry) =>
            sameProcess(entry, target),
          );

          if (latest?.owned && latest.inspected) signalOwnedPid(latest, signal);
        }
      }
    }
    const deadline = Date.now() + (signal === "SIGTERM" ? 1_000 : 3_000);

    while (Date.now() < deadline) {
      if (
        ownedLiveProcesses(await readProcessSnapshot(invocation)).length === 0
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const remaining = ownedLiveProcesses(await readProcessSnapshot(invocation));

  if (remaining.length)
    throw new InvocationOwnershipError(
      `invocation processes survived SIGKILL: ${remaining.map((entry) => entry.pid).join(",")}`,
    );
  logInvocation(invocation, "sweep-complete", {
    role: "runner",
    caseName: "lane-exit",
    pid: process.pid,
    pgid: 0,
    rootRole: "invocation",
    bootId: invocation.id,
    outcome: leaks.size ? "leak-reaped" : "clean",
    leaks: leaks.size,
  });

  return [...leaks.values()];
}

export async function readLogTail(
  filename: string,
  maxBytes = 16 * 1024,
): Promise<string> {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 4 * 1024 * 1024
  )
    throw new InvocationOwnershipError(
      "log tail size must be between 1 byte and 4 MiB",
    );
  const handle = await open(filename, "r");

  try {
    const info = await handle.stat();
    const buffer = new Uint8Array(Math.min(info.size, maxBytes));
    const { bytesRead } = await handle.read(
      buffer,
      0,
      buffer.length,
      Math.max(0, info.size - buffer.length),
    );

    return new TextDecoder().decode(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

function archivedLog(invocation: Invocation, filename: string): string {
  return path.join(
    invocation.directory,
    `saved-log-${createHash("sha256").update(filename).digest("hex")}.log`,
  );
}

export async function fixtureLogTail(
  invocation: Invocation,
  filename: string,
  maxBytes = 16 * 1024,
): Promise<string> {
  try {
    return await readLogTail(filename, maxBytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;

    return readLogTail(archivedLog(invocation, filename), maxBytes);
  }
}

export async function preserveFixtureLog(
  invocation: Invocation,
  filename: string,
): Promise<void> {
  await writeFile(
    archivedLog(invocation, filename),
    await fixtureLogTail(invocation, filename),
    { mode: 0o600 },
  );
}

/** Terminal invocation cleanup only; a fixture restart never calls this. */
export async function removeInvocationRoots(
  invocation: Invocation,
): Promise<void> {
  if (ownedLiveProcesses(await readProcessSnapshot(invocation)).length)
    throw new InvocationOwnershipError(
      "cannot remove roots while invocation processes remain alive",
    );
  const records = await invocationRecords(invocation);

  for (const record of records) {
    if (record.kind !== "process" || !record.logFile) continue;
    try {
      await preserveFixtureLog(invocation, record.logFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const roots = records.filter(
    (record): record is RootRecord => record.kind === "root",
  );

  for (const record of roots.sort((a, b) => b.root.length - a.root.length)) {
    let info;

    try {
      info = await lstat(record.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (
      info.isSymbolicLink() ||
      info.dev !== record.device ||
      info.ino !== record.inode ||
      (await readFile(
        path.join(record.root, ".maister-test-invocation"),
        "utf8",
      )) !== invocation.id
    )
      throw new InvocationOwnershipError(
        `root ownership changed: ${record.rootRole}`,
      );
    if (record.rootRole === "worktrees") {
      const { cleanupTestWorktrees } = (await import(
        new NodeURL("./worktree-test-root.ts", import.meta.url).href
      )) as typeof import("./worktree-test-root");

      await cleanupTestWorktrees(record.root);
    } else {
      await rm(record.root, { recursive: true });
    }
    logInvocation(invocation, "root-removed", {
      role: "runner",
      caseName: "lane-exit",
      pid: process.pid,
      pgid: 0,
      rootRole: record.rootRole,
      rootId: createHash("sha256")
        .update(record.root)
        .digest("hex")
        .slice(0, 12),
      bootId: invocation.id,
      outcome: "removed",
    });
  }
}

export const FIXTURE_WATCHDOG = fileURLToPath(
  new NodeURL("./fixture-parent-watchdog.mjs", import.meta.url),
);

export async function registerContainerAllocation(
  invocation: Invocation,
): Promise<void> {
  await writeRecord(invocation, { kind: "container", id: null });
}

export async function registerContainer(
  invocation: Invocation,
  id: string,
): Promise<void> {
  if (!/^[a-f0-9]{64}$/u.test(id))
    throw new InvocationOwnershipError("invalid container identity");
  await writeRecord(invocation, { kind: "container", id });
}

/** Ryuk may be shared with live sibling lanes, so it cannot own this boundary. */
export async function removeInvocationContainers(
  invocation: Invocation,
): Promise<string[]> {
  if (
    !(await invocationRecords(invocation)).some(
      (record) => record.kind === "container",
    )
  )
    return [];
  if (ownedLiveProcesses(await readProcessSnapshot(invocation)).length)
    throw new InvocationOwnershipError(
      "cannot remove containers while invocation clients remain alive",
    );
  const list = async (): Promise<string[]> => {
    const { stdout } = await execFileAsync(
      "docker",
      [
        "container",
        "ls",
        "--all",
        "--no-trunc",
        "--filter",
        `label=${INVOCATION_CONTAINER_LABEL}=${invocation.id}`,
        "--format",
        "{{.ID}}",
      ],
      { timeout: 30_000 },
    );

    return stdout.trim().split("\n").filter(Boolean);
  };
  const containers = await list();

  for (const id of containers) {
    if (!/^[a-f0-9]{64}$/u.test(id))
      throw new InvocationOwnershipError(
        "Docker returned an invalid container identity",
      );
    try {
      const { stdout } = await execFileAsync(
        "docker",
        ["container", "inspect", "--format", "{{json .Config.Labels}}", id],
        { timeout: 10_000 },
      );
      const labels = JSON.parse(stdout) as Record<string, string>;

      if (labels[INVOCATION_CONTAINER_LABEL] !== invocation.id)
        throw new InvocationOwnershipError(
          "container invocation label changed",
        );
      await execFileAsync("docker", ["container", "rm", "--force", id], {
        timeout: 30_000,
      });
      logInvocation(invocation, "container-removed", {
        role: "postgres",
        caseName: "lane-exit",
        pid: process.pid,
        pgid: 0,
        rootRole: "database",
        rootId: id,
        bootId: invocation.id,
        outcome: "leak-reaped",
      });
    } catch (error) {
      if (error instanceof InvocationOwnershipError) throw error;
      if ((await list()).includes(id)) throw error;
      // Concurrent normal teardown or Ryuk already removed this exact object.
    }
  }
  if ((await list()).length)
    throw new InvocationOwnershipError(
      "invocation containers survived terminal cleanup",
    );

  return containers;
}

export type InvocationReclaimers = Readonly<{
  sweepInvocation: typeof sweepInvocation;
  removeInvocationContainers: typeof removeInvocationContainers;
  removeInvocationRoots: typeof removeInvocationRoots;
}>;

const INVOCATION_RECLAIMERS: InvocationReclaimers = {
  sweepInvocation,
  removeInvocationContainers,
  removeInvocationRoots,
};

/**
 * Terminal invocation cleanup shared by every lane runner: owned processes
 * first, then containers, then roots — a container or root may only go once
 * nothing owned can still use it. Each reclaimer runs even when the one before
 * it threw, because each owns a different resource class (S52-R6: a failed
 * process sweep used to leave every container and root behind). A survivor is
 * an error even after the sweep reaped it: a clean sweep only proves the lane's
 * own teardown was incomplete. Returns the errors; the caller combines them
 * with its own outcome. `subject` names the lane in the messages.
 */
export async function releaseInvocation(
  invocation: Invocation,
  subject: string,
  reclaimers: InvocationReclaimers = INVOCATION_RECLAIMERS,
): Promise<unknown[]> {
  const errors: unknown[] = [];
  let leaks: readonly ProcessIdentity[] = [];
  let containers: readonly string[] = [];

  for (const step of [
    async () => {
      leaks = await reclaimers.sweepInvocation(invocation);
    },
    async () => {
      containers = await reclaimers.removeInvocationContainers(invocation);
    },
    async () => {
      await reclaimers.removeInvocationRoots(invocation);
    },
  ]) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  if (leaks.length)
    errors.push(
      new Error(
        `${subject} leaked ${leaks.length} process(es); the final sweep reaped them (ledger ${invocation.directory})`,
      ),
    );
  if (containers.length)
    errors.push(
      new Error(
        `${subject} leaked ${containers.length} container(s); terminal cleanup removed them (ledger ${invocation.directory})`,
      ),
    );

  return errors;
}

export async function fixtureProcessEnvironment(
  invocation: Invocation,
): Promise<Record<string, string>> {
  const parent = await processIdentity(invocation, process.pid);
  const owner =
    process.env[INVOCATION_KEY] === invocation.id
      ? (process.env.MAISTER_TEST_PROCESS_OWNER ?? JSON.stringify(parent))
      : JSON.stringify(parent);

  return {
    ...invocationEnvironment(invocation),
    MAISTER_TEST_PROCESS_OWNER: owner,
    MAISTER_TEST_PROCESS_PARENT: JSON.stringify(parent),
  };
}

export async function signalInvocationGroup(
  invocation: Invocation,
  pgid: number,
  signal: NodeJS.Signals,
): Promise<void> {
  const members = (await readProcessSnapshot(invocation)).filter(
    (entry) => entry.pgid === pgid && !entry.zombie,
  );

  if (!members.length) return;
  if (
    pgid <= 1 ||
    members.some(
      (entry) => !entry.owned || !entry.inspected || entry.pid === process.pid,
    )
  )
    throw new InvocationOwnershipError(
      `refusing unverifiable fixture group ${pgid}`,
    );
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

export async function assertInvocationGroupEmpty(
  invocation: Invocation,
  pgid: number,
): Promise<void> {
  const deadline = Date.now() + 3_000;
  let members: ProcessIdentity[] = [];

  do {
    members = (await readProcessSnapshot(invocation)).filter(
      (entry) => entry.pgid === pgid && !entry.zombie,
    );
    if (!members.length) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  await signalInvocationGroup(invocation, pgid, "SIGKILL");
  throw new InvocationOwnershipError(
    `fixture group ${pgid} leaked after shutdown: ${members.map((entry) => entry.pid).join(",")}; SIGKILL sent`,
  );
}
