import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

// D10 (AB-16): a real, kernel-enforced filesystem boundary for the web
// process under test. Choosing different path strings is not isolation — the
// same identity could still open the host's private root — so the harness
// wraps the production web command in a mechanism the process cannot undo.
//
// Only a driver this host can actually enforce is offered. macOS provides
// `sandbox-exec`: a MAC profile inherited by every descendant, whose denial
// surfaces as EPERM. A Linux driver (distinct uid with 0700 roots → EACCES,
// or a mount namespace → ENOENT) lands with the S5.3 CI matrix; until then
// an unsupported host fails loudly rather than pretending to isolate.

const execFileAsync = promisify(execFile);
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export type IsolationDriver = Readonly<{
  name: "sandbox-exec";
  // The errno a denied access surfaces as under this driver.
  deniedCode: string;
  wrap(
    command: readonly string[],
    deniedRoots: readonly string[],
  ): { file: string; args: string[] };
}>;

export class IsolationUnavailableError extends Error {
  readonly name = "IsolationUnavailableError";
}

function sandboxProfile(deniedRoots: readonly string[]): string {
  const deny = deniedRoots.map(
    (root) =>
      `(deny file* (subpath "${root.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"))`,
  );

  return ["(version 1)", "(allow default)", ...deny].join("\n");
}

const sandboxExecDriver: IsolationDriver = {
  name: "sandbox-exec",
  deniedCode: "EPERM",
  wrap(command, deniedRoots) {
    return {
      file: SANDBOX_EXEC,
      args: ["-p", sandboxProfile(deniedRoots), ...command],
    };
  },
};

export function resolveIsolationDriver(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): IsolationDriver {
  const requested = env.MAISTER_TEST_ISOLATION;

  if (
    requested === "sandbox-exec" ||
    (requested === undefined && platform === "darwin")
  ) {
    if (existsSync(SANDBOX_EXEC)) return sandboxExecDriver;
    throw new IsolationUnavailableError(
      `${SANDBOX_EXEC} is not present; this host cannot enforce the web/supervisor boundary`,
    );
  }
  throw new IsolationUnavailableError(
    `no filesystem isolation driver for platform ${platform}` +
      (requested ? ` (MAISTER_TEST_ISOLATION=${requested})` : "") +
      "; the Linux uid/mount-namespace driver is scheduled with S5.3",
  );
}

export type AccessProbe =
  | { outcome: "readable"; bytes: number }
  | { outcome: "denied"; code: string };

// Reads `target` from a fresh Node process under the SAME wrapping the web
// process runs with — the negative control that proves the denial is a
// property of the identity, not of the path string.
export async function probeFilesystemAccess(
  driver: IsolationDriver,
  deniedRoots: readonly string[],
  target: string,
): Promise<AccessProbe> {
  const script = [
    "const fs = require('node:fs');",
    "try { const b = fs.readFileSync(process.argv[1]); process.stdout.write(JSON.stringify({ outcome: 'readable', bytes: b.length })); }",
    "catch (e) { process.stdout.write(JSON.stringify({ outcome: 'denied', code: e.code ?? 'UNKNOWN' })); }",
  ].join(" ");
  const wrapped = driver.wrap(
    [process.execPath, "-e", script, target],
    deniedRoots,
  );
  const { stdout } = await execFileAsync(wrapped.file, wrapped.args, {
    timeout: 20_000,
  });

  return JSON.parse(stdout) as AccessProbe;
}
