import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { MaisterError } from "@/lib/errors";

const execute = promisify(execFile);
const ownership = new AsyncLocalStorage<
  (processGroup: number) => Promise<void>
>();

// The child cannot start Git until the owner has durably recorded its group.
// If the web process dies before that acknowledgement, IPC disconnect exits it.
export const GIT_OWNERSHIP_UNCERTAIN = "MAISTER_GIT_PROCESS_UNCERTAIN";
export const GIT_GATE = `
const { spawn, spawnSync } = require('node:child_process');
const { writeSync } = require('node:fs');
const timeout = Number(process.argv[1]);
const deadline = Date.now() + timeout;
function uncertain(reason, fields = {}) {
  try { writeSync(2, '${GIT_OWNERSHIP_UNCERTAIN} ' + JSON.stringify({ reason, ...fields }) + '\\n'); }
  finally { process.kill(-process.pid, 'SIGKILL'); }
}
setTimeout(() => { process.kill(-process.pid, 'SIGKILL'); }, timeout);
let started = false;
process.on('disconnect', () => { if (!started) process.exit(1); });
process.once('message', message => {
  if (message !== 'go') process.exit(1);
  started = true;
  const child = spawn('git', process.argv.slice(2), { stdio: ['inherit','inherit','inherit'] });
  child.once('error', () => process.exit(127));
  child.once('exit', code => {
    if (code === null) return uncertain('signalled_git');
    if (Date.now() >= deadline) return uncertain('deadline');
    const report = spawnSync('ps', ['-g', String(process.pid), '-o', 'pid=,pgid=,stat='], { encoding: 'utf8', timeout: Math.max(1, Math.min(deadline - Date.now(), 5000)), maxBuffer: 1048576 });
    if (report.error || report.status !== 0) return uncertain('process_table_unavailable', { code: report.error?.code, status: report.status });
    for (const line of report.stdout.split('\\n').filter(value => value.trim())) {
      const entry = /^\\s*(\\d+)\\s+(\\d+)\\s+(\\S+)/.exec(line);
      if (!entry) return uncertain('process_table_unparseable');
      const pid = Number(entry[1]);
      if (Number(entry[2]) === process.pid && pid !== process.pid && pid !== report.pid && !entry[3].startsWith('Z')) return uncertain('active_child', { pid, state: entry[3], exitedGitPid: child.pid });
    }
    process.exit(code);
  });
});
process.send('ready');
`;

export function withGitOwnership<T>(
  register: (processGroup: number) => Promise<void>,
  action: () => Promise<T>,
): Promise<T> {
  return ownership.run(register, action);
}

type GitExecutionOptions = {
  timeout: number;
  maxBuffer: number;
  env: NodeJS.ProcessEnv;
};
type GitBufferFailure = NodeJS.ErrnoException & {
  stdout?: Buffer;
  stderr?: Buffer;
  killed?: boolean;
  signal?: NodeJS.Signals;
};

function gitTextFailure(error: unknown, stdout: string, stderr: string): Error {
  const failure = error as GitBufferFailure;

  return Object.assign(
    new Error(error instanceof Error ? error.message : "Git execution failed", {
      cause: error,
    }),
    {
      code: failure.code,
      killed: failure.killed,
      signal: failure.signal,
      stdout,
      stderr,
    },
  );
}

function reviewedGitText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new MaisterError(
      "PRECONDITION",
      "The manifest or required repository output is not valid UTF-8 and cannot be reviewed without changing bytes. Convert the source to UTF-8 and create a fresh preview.",
      {
        details: { reason: "unsupported_checkout" },
        cause: cause instanceof Error ? cause : undefined,
      },
    );
  }
}

/** Keep the established text contract of unrelated parent Git helpers. */
export async function executeRepositoryGit(
  repo: string,
  args: readonly string[],
  options: GitExecutionOptions,
): Promise<{ stdout: string; stderr: string }> {
  try {
    const output = await executeRepositoryGitBytes(repo, args, options);

    return {
      stdout: output.stdout.toString("utf8"),
      stderr: output.stderr.toString("utf8"),
    };
  } catch (error) {
    if (error instanceof MaisterError) throw error;
    const failure = error as GitBufferFailure;

    throw gitTextFailure(
      error,
      failure.stdout?.toString("utf8") ?? "",
      failure.stderr?.toString("utf8") ?? "",
    );
  }
}

/** Reviewed configuration must never hide source-byte changes through replacement decoding. */
export async function executeReviewedRepositoryGit(
  repo: string,
  args: readonly string[],
  options: GitExecutionOptions,
): Promise<{ stdout: string; stderr: string }> {
  try {
    const output = await executeRepositoryGitBytes(repo, args, options);

    return {
      stdout: reviewedGitText(output.stdout),
      stderr: output.stderr.toString("utf8"),
    };
  } catch (error) {
    if (error instanceof MaisterError) throw error;
    const failure = error as GitBufferFailure;

    throw gitTextFailure(
      error,
      reviewedGitText(failure.stdout ?? Buffer.alloc(0)),
      failure.stderr?.toString("utf8") ?? "",
    );
  }
}

async function executeRepositoryGitBytes(
  repo: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv },
): Promise<{ stdout: Buffer; stderr: Buffer }> {
  const register = ownership.getStore();

  if (!register)
    return execute("git", ["-C", repo, ...args], {
      ...options,
      encoding: "buffer",
    });

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["-e", GIT_GATE, "--", String(options.timeout), "-C", repo, ...args],
      {
        detached: true,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: Error | null = null;
    const stop = (error: Error): void => {
      failure ??= error;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ESRCH")
            failure = cause instanceof Error ? cause : error;
        }
      }
    };
    const timer = setTimeout(
      () => stop(new Error("Git execution exceeded its bounded window")),
      options.timeout,
    );

    child.once("message", () => {
      if (!child.pid) {
        stop(new Error("Git owner process did not start"));

        return;
      }
      register(child.pid).then(
        () => {
          if (!failure && child.connected) child.send("go");
        },
        (error: unknown) =>
          stop(
            error instanceof Error
              ? error
              : new Error("Git ownership could not be recorded"),
          ),
      );
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (failure) return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > options.maxBuffer)
        stop(new Error("Git output exceeds its bounded buffer"));
      else stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (failure) return;
      stderrBytes += chunk.byteLength;
      if (stderrBytes > options.maxBuffer)
        stop(new Error("Git diagnostics exceed their bounded buffer"));
      else stderr.push(chunk);
    });
    child.once("error", (error) => {
      failure ??= error;
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (failure instanceof MaisterError) {
        reject(failure);

        return;
      }
      const output = {
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      };

      if (failure || code !== 0) {
        reject(
          Object.assign(failure ?? new Error("Git command failed"), {
            code: code ?? "EPIPE",
            ...output,
            killed: failure !== null || signal !== null,
          }),
        );
      } else resolve(output);
    });
  });
}

export async function registerOwnedGitProcess(
  processGroup: number,
): Promise<void> {
  const register = ownership.getStore();

  if (!register)
    throw new MaisterError(
      "CONFLICT",
      "Git publication requires a recorded repository ownership fence.",
      { details: { reason: "operation_busy" } },
    );
  await register(processGroup);
}
