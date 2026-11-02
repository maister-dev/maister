import "@/lib/load-env";

import { parseArgs } from "node:util";

import pino from "pino";
import { z } from "zod";

import { closeDb, getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import {
  inspectPromptApplication,
  rearmPromptApplication,
} from "@/lib/execution-host/prompt-application-recovery";

const log = pino({ name: "prompt-application-recovery" });

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      command: { type: "string" },
      "observation-token": { type: "string" },
    },
  });
  const command = z.string().guid().safeParse(values.command);
  const operation = positionals[0];

  if (
    !command.success ||
    positionals.length !== 1 ||
    (operation !== "inspect" && operation !== "reapply")
  )
    throw new MaisterError(
      "PRECONDITION",
      "Use inspect --command UUID, or reapply --command UUID --observation-token TOKEN from inspection",
    );
  try {
    const db = getDb();

    if (operation === "inspect") {
      process.stdout.write(
        `${JSON.stringify(await inspectPromptApplication(db, command.data), null, 2)}\n`,
      );

      return;
    }
    const token = z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .safeParse(values["observation-token"]);

    if (!token.success)
      throw new MaisterError(
        "PRECONDITION",
        "reapply requires the exact --observation-token from inspect",
      );
    const observation = await rearmPromptApplication({
      db,
      commandId: command.data,
      expectedToken: token.data,
    });

    // Domain finalization may promote and launch another Run. The persistent
    // web worker owns that work; this short-lived CLI only records the request.
    process.stdout.write(
      `${JSON.stringify({ action: "reapply_requested", ...observation }, null, 2)}\n`,
    );
  } finally {
    await closeDb();
  }
}

void main().catch((error: unknown) => {
  log.error(
    {
      code: error instanceof MaisterError ? error.code : "UNEXPECTED",
      message:
        error instanceof MaisterError
          ? error.message
          : "Prompt application recovery failed",
      details: error instanceof MaisterError ? error.details : undefined,
    },
    "[FIX:prompt-application] recovery refused",
  );
  process.exitCode = 1;
});
