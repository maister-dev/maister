import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const ownership = new AsyncLocalStorage<
  (processGroup: number) => Promise<void>
>();

// The child cannot start Git until the owner has durably recorded its group.
// If the web process dies before that acknowledgement, IPC disconnect exits it.
const GIT_GATE = `
const { spawn } = require('node:child_process');
const timeout = Number(process.argv[1]);
setTimeout(() => { process.kill(-process.pid, 'SIGKILL'); }, timeout);
let started = false;
process.on('disconnect', () => { if (!started) process.exit(1); });
process.once('message', message => {
  if (message !== 'go') process.exit(1);
  started = true;
  const child = spawn('git', process.argv.slice(2), { stdio: ['ignore','inherit','inherit'] });
  child.once('error', () => process.exit(127));
  child.once('exit', code => process.exit(code === null ? 128 : code));
});
process.send('ready');
`;

export function withGitOwnership<T>(
  register: (processGroup: number) => Promise<void>,
  action: () => Promise<T>,
): Promise<T> {
  return ownership.run(register, action);
}

export async function executeRepositoryGit(
  repo: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  const register = ownership.getStore();

  if (!register) return execute("git", ["-C", repo, ...args], options);

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
    let stdout = "";
    let stderr = "";
    let failure: Error | null = null;
    const stop = (error: Error): void => {
      failure = error;
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
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > options.maxBuffer)
        stop(new Error("Git output exceeds its bounded buffer"));
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > options.maxBuffer)
        stop(new Error("Git diagnostics exceed their bounded buffer"));
    });
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (failure || code !== 0) {
        reject(
          Object.assign(failure ?? new Error("Git command failed"), {
            code: code ?? "EPIPE",
            stdout,
            stderr,
            killed: failure !== null || signal !== null,
          }),
        );
      } else resolve({ stdout, stderr });
    });
  });
}
