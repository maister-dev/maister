import { parseArgs } from "node:util";

import pino from "pino";

import {
  importLegacyAgentMemory,
  type LegacyMemoryImportCommand,
} from "@/lib/agent-memory-vault/import-legacy";
import { getDb } from "@/lib/db/client";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { runtimeRoot } from "@/lib/runtime-root";

const log = pino({ name: "import-agent-memory-vault" });

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      import: { type: "boolean" },
      activate: { type: "boolean" },
      cleanup: { type: "boolean" },
      "actor-user-id": { type: "string" },
      help: { type: "boolean" },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(
      "Scan by default. Use one of --import, --activate or --cleanup with --actor-user-id <admin-id>.\n" +
        "Set MAISTER_RUNTIME_ROOT to the legacy runtime root. Stop the old service and drain its executions before activation.\n",
    );

    return;
  }
  const actions: LegacyMemoryImportCommand[] = [];

  if (values.import) actions.push("import");
  if (values.activate) actions.push("activate");
  if (values.cleanup) actions.push("cleanup");
  if (actions.length > 1 || (actions.length > 0 && !values["actor-user-id"]))
    throw new MaisterError(
      "CONFIG",
      "Select one memory import action and supply its administrator identity",
    );
  const db = getDb();

  try {
    await importLegacyAgentMemory(db, {
      root: runtimeRoot(),
      command: actions[0] ?? "preview",
      actorUserId: values["actor-user-id"] ?? "",
    });
  } finally {
    await db.$client.end();
  }
}

main().catch((error: unknown) => {
  // Database errors can include content from a failed insert.
  if (isMaisterError(error))
    log.error(
      { code: error.code, details: error.details, message: error.message },
      "vault import refused",
    );
  else
    log.error(
      { errorType: error instanceof Error ? error.name : typeof error },
      "vault import failed",
    );
  process.exitCode = 1;
});
