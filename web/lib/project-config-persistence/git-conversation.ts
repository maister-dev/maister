import "server-only";

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { GIT_GATE, registerOwnedGitProcess } from "./git-process";

import { MaisterError } from "@/lib/errors";

export type GitConversation = {
  write: (line: string) => void;
  command: (line: string, acknowledgement: string) => Promise<void>;
};

/** EOF aborts an uncommitted Git transaction when its web owner disappears. */
export async function executeGitConversation<T>(
  repo: string,
  args: readonly string[],
  action: (conversation: GitConversation) => Promise<T>,
): Promise<T> {
  const child = spawn(
    process.execPath,
    ["-e", GIT_GATE, "--", "30000", "-C", repo, ...args],
    {
      detached: true,
      env: {
        ...process.env,
        LC_ALL: "C",
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
      },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    },
  );
  let diagnostics = "";
  let failure: unknown = null;
  let exited = false;
  const pending: Array<{
    resolve: (line: string) => void;
    reject: (error: unknown) => void;
  }> = [];
  const lines: string[] = [];
  const fail = (error: unknown): void => {
    if (failure !== null) return;
    failure = error;
    for (const waiter of pending.splice(0)) waiter.reject(error);
  };
  const stopGroup = (error: unknown): void => {
    fail(error);
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ESRCH") fail(cause);
      }
    }
  };
  const deadline = setTimeout(
    () =>
      stopGroup(
        new MaisterError(
          "CONFLICT",
          "The Git publication deadline expired; recover the operation before retrying.",
          { details: { reason: "recovery_required" } },
        ),
      ),
    30000,
  );
  const stopped = new Promise<void>((resolve) => {
    child.once("error", (error) => fail(error));
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      exited = true;
      if (code !== 0 || signal !== null)
        fail(
          new MaisterError(
            "CONFLICT",
            "The Git publication transaction did not complete. Recover the operation before retrying.",
            { details: { reason: "recovery_required", exitCode: code } },
          ),
        );
      else if (pending.length)
        fail(
          new MaisterError(
            "CONFLICT",
            "The Git transaction ended before acknowledgement. Recover its outcome before retrying.",
            { details: { reason: "recovery_required" } },
          ),
        );
      resolve();
    });
  });
  const output = createInterface({ input: child.stdout! });

  output.on("line", (line) => {
    if (failure) return;
    const waiter = pending.shift();

    if (waiter) waiter.resolve(line);
    else lines.push(line);
    if (lines.length > 16)
      fail(
        new MaisterError(
          "CONFLICT",
          "Unexpected Git transaction output; recover the operation.",
          { details: { reason: "recovery_required" } },
        ),
      );
  });
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => {
    diagnostics += chunk;
    if (Buffer.byteLength(diagnostics) > 64 * 1024)
      stopGroup(
        new MaisterError(
          "CONFLICT",
          "Git publication diagnostics exceeded their bounded buffer; recover the operation.",
          { details: { reason: "recovery_required" } },
        ),
      );
  });
  child.stdin!.on("error", (error) => fail(error));
  const ready = new Promise<void>((resolve, reject) => {
    child.once("message", () => {
      if (!child.pid) {
        reject(
          new MaisterError(
            "EXECUTOR_UNAVAILABLE",
            "The Git transaction process could not start.",
          ),
        );

        return;
      }
      registerOwnedGitProcess(child.pid).then(
        () => {
          if (child.connected) {
            child.send("go");
            resolve();
          } else
            reject(
              new MaisterError(
                "EXECUTOR_UNAVAILABLE",
                "Git ownership acknowledgement was interrupted.",
              ),
            );
        },
        (error: unknown) => {
          if (child.connected) child.disconnect();
          reject(error);
        },
      );
    });
    child.once("close", () =>
      reject(
        new MaisterError(
          "EXECUTOR_UNAVAILABLE",
          "The Git transaction ended before ownership acknowledgement.",
        ),
      ),
    );
    child.once("error", reject);
  });
  const write = (line: string): void => {
    if (failure) throw failure;
    if (exited || /[\r\n\0]/u.test(line))
      throw new MaisterError(
        "CONFLICT",
        "Invalid or closed Git publication transaction.",
        { details: { reason: "recovery_required" } },
      );
    child.stdin!.write(`${line}\n`);
  };
  const command = async (
    line: string,
    acknowledgement: string,
  ): Promise<void> => {
    write(line);
    const response =
      lines.shift() ??
      (await new Promise<string>((resolve, reject) => {
        if (failure) reject(failure);
        else pending.push({ resolve, reject });
      }));

    if (response !== acknowledgement)
      throw new MaisterError(
        "CONFLICT",
        "Git returned an unexpected publication acknowledgement; recover this operation.",
        { details: { reason: "recovery_required" } },
      );
  };

  try {
    await ready;
    const result = await action({ write, command });

    child.stdin!.end();
    await stopped;
    if (failure) throw failure;

    return result;
  } finally {
    // Closing stdin is Git's documented transaction-abort path before commit.
    child.stdin!.end();
    await stopped;
    output.close();
  }
}
