import { requireProjectActionForUser } from "@/lib/authz";
import { closeDb, getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import { confirmProjectConfiguration } from "@/lib/project-config-persistence/service";

const [id, projectId, actorUserId] = process.argv.slice(2);

if (!id || !projectId || !actorUserId)
  throw new Error("Missing operation fixture identity");

try {
  const receipt = await confirmProjectConfiguration(
    getDb(),
    { id, projectId, actorUserId },
    async () => {
      await requireProjectActionForUser(actorUserId, projectId, "editSettings");
      await requireProjectActionForUser(
        actorUserId,
        projectId,
        "readRepoFiles",
      );
    },
  );

  process.stdout.write(
    JSON.stringify({
      recorded: "config-operation",
      state: receipt.state,
      sha: receipt.committedSha,
    }) + "\n",
  );
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      recorded: "config-operation-error",
      code: error instanceof MaisterError ? error.code : "UNKNOWN",
      reason: error instanceof MaisterError ? error.details?.reason : undefined,
    }) + "\n",
  );
  process.exitCode = 1;
} finally {
  await closeDb();
}
