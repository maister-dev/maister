import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { promisify } from "node:util";

import * as acp from "@agentclientprotocol/sdk/unstable";

import { serveAgent } from "./acp-agent-app.mjs";

const run = promisify(execFile);

serveAgent(
  () => {
    const checkouts = new Map();
    return {
      async initialize() {
        return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} };
      },
      async newSession({ cwd }) {
        const sessionId = randomUUID();
        checkouts.set(sessionId, cwd);
        return { sessionId };
      },
      async prompt({ sessionId }) {
        const cwd = checkouts.get(sessionId);
        if (!cwd) throw new Error("Missing resolver checkout");
        const rebase = process.argv.includes("--rebase");
        await run(
          "git",
          rebase
            ? ["rebase", "--show-current-patch"]
            : ["rev-parse", "--verify", "MERGE_HEAD"],
          { cwd },
        );
        await writeFile(join(cwd, "README.md"), "both changes retained\n");
        await run("git", ["add", "--", "README.md"], { cwd });
        if (process.argv.includes("--leave-staged"))
          return { stopReason: "end_turn" };
        await run(
          "git",
          [
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "-c",
            "core.editor=true",
            ...(rebase ? ["rebase", "--continue"] : ["commit", "--no-edit"]),
          ],
          { cwd },
        );
        return { stopReason: "end_turn" };
      },
    };
  },
  acp.ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin),
  ),
);
