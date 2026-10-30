import { closeDb, getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import { recoverProjectConfigurations } from "@/lib/project-config-persistence/reconcile";

try {
  const summary = await recoverProjectConfigurations(getDb());

  process.stdout.write(
    JSON.stringify({ recorded: "config-startup", ...summary }) + "\n",
  );
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      recorded: "config-startup-error",
      code: error instanceof MaisterError ? error.code : "UNKNOWN",
    }) + "\n",
  );
  process.exitCode = 1;
} finally {
  await closeDb();
}
